'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { ConflictView } from '@/components/decision/ConflictView';
import { DecisionFields, FIELD_LABEL, FIELD_TARGET } from '@/components/decision/DecisionFields';
import { SaveStatus, unsavedShown } from '@/components/decision/SaveStatus';
import { HELD_ON_SAVE, SaveHeldContext } from '@/components/decision/SaveHeld';
import { cardScroller, SCROLLER_ATTRIBUTE, scrollerView } from '@/components/decision/scroller';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Definition, Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { decisionFormNote } from '@/lib/authz/permissionNotes';
import { signInAgainHref } from '@/lib/auth/idle';
import { openDraftStore, type DraftStore, type StoredDraft } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { FINDING_NOTE, OUTSIDE_ROLE_LABELS, STATUS_OPTIONS, problemSummary } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { stageEndHref } from '@/lib/question/stageEndHref';
import { TERM_ACCEPTED_RISK, TERM_FINDING, TERM_NOT_YET, TERM_PARTLY, TERM_VERSION_OF_A_DECISION } from '@/lib/vocabulary/terms';
import { termPattern } from '@/lib/vocabulary/firstUse';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { formatTime } from '@/lib/format/dates';
import { declaredDateFromParts } from '@/lib/decision/rules';
import { draftErrors, draftFromCurrent, draftHeldForGate, draftKeyFor, isDecision, isDraftValue, keptEvidenceLine, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { conflictCurrent, gateStatus, navigationForOutcome, savingStatus, statusForOutcome, type SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
import './DecisionForm.css';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';
import type { FieldError, UtcInstant } from '@/types/record';
import '@/components/ui/buttonStyles';

/** The way on beside Save (R2): the next question that applies in this stage, or null on the stage's last question. */
export type NextQuestion = { questionId: string; text: string; href: string; number: number; total: number };

/**
 * `nextQuestion` and `stageHref` come from the decision card (DecisionCard.tsx); without them (a unit test of the form
 * alone) the save bar has no way on. The line on what this save will do reads the panel's own shortfall finding.
 * `foot` is the card's foot (its History and finding links), rendered after the form inside SaveHeldContext so its links
 * are text while a Save waits or is out. `ownOrigin` is the platform's public origin, read on the server, for the
 * evidence block's link names (VersionEvidenceList `platformOrigin`; null: no link is the platform's own). `lead` is the
 * card's phone saved block, rendered before the form inside SaveHeldContext so its history link is held too (review A A3c-2).
 */
export type DecisionFormProps = { data: QuestionPanelData; nextQuestion?: NextQuestion | null; stageHref?: string; foot?: ReactNode; lead?: ReactNode; ownOrigin?: string | null };

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const F = DECISION_FORM_COPY;
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The summary's two lines about the link form: a link that was not added while Save waited, an address typed and never added. */
const isLinkLine = (e: FieldError): boolean => e.message === F.linkNotAdded || e.message === EVIDENCE_COPY.link.typedNotAdded;

/** The names of files still moving or failed, joined for a sentence. */
const fileList = (names: readonly string[]) => names.join(', ');

/**
 * S-12's "Record a decision" (W-3, W-4; FR-DEC-01, FR-DEC-05 to FR-DEC-07, FR-DEC-10; UX-24 to UX-30;
 * NFR-REL-04, NFR-REL-05, NFR-PRIV-06). A slot of the S-12 shell; the page renders it with a key per question.
 *
 * - Every edit is written to this account's draft for this question (UX-26) and nothing is sent (UX-24). A
 *   draft found on open is restored; when its base is not the current version, W-4 shows at once.
 * - Save checks the fields with DEC-a's rules first (M-11: a summary that takes focus, a link to each field);
 *   while a file is uploading or failed it waits (UX-30); otherwise it sends route 1 with `requestIdFor` (the same
 *   id for an unchanged retry, a new one after an edit: UX-27), the press recorded in the draft first. The button
 *   keeps its label and is disabled until the reply. Only a 2xx says "Saved" (NFR-REL-04); it deletes the draft
 *   and refreshes the page's data.
 * - After a reply that says nothing was saved for sure (network, timeout), the browser's next `online` event
 *   sends the unchanged draft once more with the same id, and only once (NFR-REL-05). A refusal (4xx) is never
 *   retried by itself.
 *
 * When the role cannot record a decision (or the project is archived) the region holds only UX-14's line, and no
 * form. The evidence block lives in this client tree, so its callbacks are this form's (EVD RE-1), and it is
 * remounted with the current version's id so a save that made a new version gives it the new `initial` (EVD RE-4).
 */
export function DecisionForm({ data, nextQuestion = null, stageHref, foot, lead, ownOrigin = null }: DecisionFormProps): ReactElement | null {
  if (!data.canWrite) {
    const note = decisionFormNote(data.viewer.role, data.projectArchived);
    return note === null ? null : <p data-permission-note>{note}</p>;
  }
  return <WritableDecisionForm data={data} nextQuestion={nextQuestion} stageHref={stageHref} foot={foot} lead={lead} ownOrigin={ownOrigin} />;
}

/**
 * What this save will do (R2; spec 9.3 item 6), as one sentence, then the version it becomes. The words are
 * DECISION_FORM_COPY.consequence's, each true of lib/data/findings.ts (that file's comment says how); "open" is the
 * question's open shortfall finding, the one a save acts on (`data.openFinding`, openShortfallForQuestion), never a team
 * finding. The version is one above the newer of the base the form holds and the version on the page: the same number as
 * the corner's mark after a refresh, and a stale base meets the conflict view before any save (review round 1).
 * `finding` is true when the sentence uses the word, so its definition goes beside it.
 */
export function consequenceOf(d: DecisionDraft, data: QuestionPanelData, base: number | null): { text: string; finding: boolean; tips: DefinedEntry[] } {
  const C = F.consequence;
  // Coordinator (T3c item 7): the version line only while the answer differs from the saved version; render only.
  const version = answerDiffers(d, data) ? C.version(Math.max(base ?? 0, data.current?.versionNumber ?? 0) + 1) : '';
  const join = (sentence: string) => (version === '' ? sentence : sentence === '' ? version : `${sentence} ${version}`);
  if (data.question.type === 'gate') {
    return { text: join(d.scopeAnswer === null ? '' : C.scope[d.scopeAnswer]), finding: false, tips: [] };
  }
  const label = STATUS_OPTIONS.find((o) => o.value === d.status)?.label;
  // Lane 6's first-use rule (T3c item 10b): with no status chosen no card's definition shows, so the line gives Partly, Not
  // yet and "version" each its (i); "finding" has its definition after the line. "accepted risk" in the owner's sentence too.
  if (d.status === null || label === undefined) {
    return { text: join(FINDING_NOTE), finding: true, tips: version === '' ? [TERM_PARTLY, TERM_NOT_YET] : [TERM_PARTLY, TERM_NOT_YET, TERM_VERSION_OF_A_DECISION] };
  }
  const open = data.openFinding !== null;
  if (d.status === 'partly' || d.status === 'not_yet') {
    return open ? { text: join(C.keepsOpen(label)), finding: true, tips: [] } : { text: join(C.raises(label)), finding: true, tips: [TERM_ACCEPTED_RISK] };
  }
  return { text: join(open ? C.closesNot(label) : C.raisesNone(label)), finding: open, tips: [] };
}

/**
 * The line's words with the first use of "finding" (when its definition follows the line) and of each `tips` term marked
 * as the term (lane 6's `Term`), each tip term followed by its (i) (lane 6's `TermTip`, named "What does "<term>" mean?").
 * The words stay exactly as written.
 */
export function ConsequenceWords({ text, finding, tips }: { text: string; finding: boolean; tips: readonly DefinedEntry[] }): ReactElement {
  const entries: Array<{ of: DefinedEntry; tip: boolean }> = [...(finding ? [{ of: TERM_FINDING as DefinedEntry, tip: false }] : []), ...tips.map((of) => ({ of, tip: true }))];
  const uses = entries
    .map((e) => ({ ...e, m: termPattern(e.of.term, 'iu').exec(text) }))
    .filter((u): u is typeof u & { m: RegExpExecArray } => u.m !== null)
    .sort((a, b) => a.m.index - b.m.index);
  const parts: ReactNode[] = [];
  let from = 0;
  for (const u of uses) {
    if (u.m.index < from) continue;
    parts.push(text.slice(from, u.m.index));
    parts.push(<Term key={u.of.id} of={u.of}>{u.m[0]}</Term>);
    from = u.m.index + u.m[0].length;
    // "version 2" reads as one: its (i) follows the number, not the word.
    const number = u.of.id === TERM_VERSION_OF_A_DECISION.id ? /^\s\d+/.exec(text.slice(from)) : null;
    if (number !== null) { parts.push(number[0]); from += number[0].length; }
    if (u.tip) parts.push(<TermTip key={`${u.of.id}-tip`} of={u.of} label={F.whatMeans(u.of.term)} id={`decision-consequence-tip-${u.of.id}`} />);
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * Whether the form's answer differs from the saved version (the coordinator's rule for the version line, T3c item 7): any
 * answer differs when there is no saved decision (none yet, or a withdrawal); otherwise any field the save sends, the
 * evidence in any order, and the date when one is typed (the date opens empty, and an empty date is not a different
 * answer); and every answer while the saved version was answered against other wording (its content version). Render only: what a save sends, and the server's own "unchanged" refusal (lib/data/decisions.ts), are untouched.
 */
export function answerDiffers(d: DecisionDraft, data: QuestionPanelData): boolean {
  const c = data.current;
  if (!isDecision(c)) return true;
  // Review A A3c-3: the server's "unchanged" rule also needs the same content version (lib/data/decisions.ts `repeats`), so
  // the same answer saved against newer wording than the current version's is a new version.
  if (c.content.semver !== data.contentSemver) return true;
  const o = draftFromCurrent(data);
  const sorted = (a: readonly string[]) => [...a].sort().join('\n');
  if (d.status !== o.status || d.scopeAnswer !== o.scopeAnswer || d.reasonCode !== o.reasonCode || d.reason !== o.reason) return true;
  if (sorted(d.optionsInPlace) !== sorted(o.optionsInPlace) || sorted(d.evidenceIds) !== sorted(o.evidenceIds)) return true;
  if (JSON.stringify(d.decidedBy) !== JSON.stringify(o.decidedBy)) return true;
  if (d.date.day === '' && d.date.month === '' && d.date.year === '') return false;
  const typed = declaredDateFromParts(d.date);
  return !('date' in typed) || typed.date !== c.declaredDate;
}

/**
 * Plan 1C C4 (spec 9.7, "Save and Retry are one control whose label changes"): whether the form's one submit control reads
 * "Retry". Exactly when today's separate Retry would have re-sent the same request: a request was sent, the answer the field
 * holds is the one it carried (`requestIdFor` gives its id back), and either the reply offered a retry or a restored draft's
 * Save was pressed and never confirmed. While a pressed Retry's own request is out it keeps its label (D-398 item 4: it stays
 * the same control, busy, with focus); while a Save's request is out the control reads "Save decision", disabled.
 */
export function saveControlIsRetry(s: {
  retry: RetryState; body: Record<string, unknown>; status: SaveStatusValue | null; restoredPressed: boolean; saving: boolean; retrying: boolean;
}): boolean {
  if (s.saving) return s.retrying;
  return s.retry.requestId !== null
    && requestIdFor(s.retry, s.body, () => '').requestId === s.retry.requestId
    && (s.status?.next === 'retry' || (s.status === null && s.restoredPressed));
}

/**
 * The wait card's lines (UX-30): "Waiting for {files} to finish uploading." for the files still uploading, and, the owner's
 * words of 15 Nov 2026 14:30 (review B-M5), "{name} did not upload. Retry it, remove it, or save without it." for each
 * failed or refused file, which will not finish by itself.
 */
export function WaitLines({ uploading, failed }: { uploading: readonly string[]; failed: readonly string[] }): ReactElement | null {
  if (uploading.length === 0 && failed.length === 0) return null;
  return (
    <>
      {uploading.length > 0 ? <p>{F.waiting.before}<bdi>{fileList(uploading)}</bdi>{F.waiting.after}</p> : null}
      {failed.map((name) => <p key={name}><bdi>{name}</bdi>{F.waiting.failed}</p>)}
    </>
  );
}

/**
 * The way on beside Save (R2, R9): "Next: <question>" with "Question n of N", or on the stage's last question the line that
 * says so and All questions. Review B-I1: while a Save waits for an upload or a link, or its request is out (`held`), the
 * next question's words are text, not a link, and quieter, so the card's own control cannot take the person away from a
 * Save that has not gone yet (following it unmounts the form and its uploads). Leaving by the browser or the route column
 * is unchanged.
 */
export function NextWay({ next, stageHref, held }: { next: NextQuestion | null; stageHref?: string; held: boolean }): ReactElement | null {
  if (next !== null) {
    const words = <><span className="decision-next__words">{F.card.next(next.text)}</span><span className="decision-next__position">{F.card.position(next.number, next.total)}</span></>;
    return held
      ? <p className="decision-next decision-next--held" data-next-held>{words}</p>
      : <Link className="decision-next" href={next.href} {...{ [HELD_ON_SAVE]: '' }}>{words}</Link>;
  }
  if (stageHref === undefined) return null;
  // Review A I-1: on the stage's last question, All questions is held as Next is. Design G3: so is the way to the stage's end screen.
  return (
    <p className="decision-next decision-next--last">
      {QUESTION_COPY.foot.last}{' '}
      {held
        ? <span className="decision-next--held" data-next-held>{QUESTION_COPY.nav.allQuestions}</span>
        : <Link href={stageHref} {...{ [HELD_ON_SAVE]: '' }}>{QUESTION_COPY.nav.allQuestions}</Link>}
      {' '}
      {held
        ? <span className="decision-next--held" data-next-held>{QUESTION_COPY.end.link}</span>
        : <Link href={stageEndHref(stageHref)} {...{ [HELD_ON_SAVE]: '' }}>{QUESTION_COPY.end.link}</Link>}
    </p>
  );
}

/** What a saved outcome carries that the person must see: its status line, the files the save left out, and text typed while it was out. */
export type SavedCarries = { statusId: string; leftOut: readonly string[]; typedDuringSave: boolean };

/**
 * Design G3 and the controller's ruling on risk b: where a save leaves the person. After the stage's last question is saved the
 * person goes to the stage's end screen, where the working report leads, but only on a clean "Saved" (M-03) that carries no other
 * message. "Saved without <file>... save again", text typed while the save was out (CR-1, UX-25: the kept copy must be shown) and
 * "already saved" (M-04) are read on the question, which then links to the end screen. After any other question the card stays
 * open with the new answer (R2). Null: stay. Also null when the card was given no stage address.
 */
export function endHrefAfterSave(next: NextQuestion | null, stageHref: string | undefined, saved: SavedCarries): string | null {
  if (next !== null || stageHref === undefined) return null;
  return saved.statusId === 'M-03' && saved.leftOut.length === 0 && !saved.typedDuringSave ? stageEndHref(stageHref) : null;
}

/**
 * Whether the save bar covers the screen's foot now (W-3 narrow, and the owner's Option A of 15 Nov 2026 on wide screens):
 * fixed to the bottom at 768 px and below; above that it is `position: sticky` at the bottom of the card's form, which is
 * pinned exactly while its own place is below the fold, so it is read from geometry: its box reaches the screen's foot and
 * is on the screen. In the flow (static: an open withdrawal confirmation on a phone) it covers nothing. "The screen" for the
 * sticky row is the box that scrolls the card (T10: lane 3's frame from 1024 px, the document below; components/decision/
 * scroller.ts): the row pins to that box's foot, which is the window's only while that box ends on it.
 */
function pinnedBar(bar: HTMLElement): boolean {
  const position = getComputedStyle(bar).position;
  if (position === 'fixed') return true;
  if (position !== 'sticky') return false;
  const r = bar.getBoundingClientRect();
  const foot = scrollerView(cardScroller(bar)).bottom;
  return r.top < foot && r.bottom >= foot - 1;
}

function WritableDecisionForm({ data, nextQuestion = null, stageHref, foot, lead, ownOrigin = null }: DecisionFormProps): ReactElement {
  const router = useRouter();
  const key = draftKeyFor(data);
  const currentNumber = data.current?.versionNumber ?? null;

  const [value, setValue] = useState<DecisionDraft>(() => draftFromCurrent(data));
  const [base, setBase] = useState<number | null>(currentNumber);
  const [retry, setRetry] = useState<RetryState>(NO_RETRY);
  const [status, setStatus] = useState<SaveStatusValue | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<DecisionVersionView | null>(null);
  const [uploads, setUploads] = useState<{ uploading: string[]; failed: string[]; linkAdding: boolean }>({ uploading: [], failed: [], linkAdding: false });
  const [waiting, setWaiting] = useState(false);
  // Walk finding B3. Whether a link's request is out, as the evidence block last reported it (it reports the start inside
  // the press of "Add link"), and whether a Save is waiting: refs beside the two states, because Save reads the first at
  // its own press and the block's report reads the second inside an effect flush, and in both places the state can be a
  // render behind.
  const linkAdding = useRef(false);
  const waitingNow = useRef(false);
  // The open link form holds an address that was never added (the block reports it), and how often a save was refused for
  // it: the block shows each refusal at the box.
  const linkTyped = useRef(false);
  const [linkRefusals, setLinkRefusals] = useState(0);
  // The link boxes as last typed: when a new version replaces the evidence block, an address typed and not added goes
  // into the new block's boxes, not away.
  const [typedLink, setTypedLink] = useState({ url: '', label: '' });
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [draftSavedAt, setDraftSavedAt] = useState<UtcInstant | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItemView[]>(data.current?.evidence ?? []);
  const [evidenceInitial, setEvidenceInitial] = useState<EvidenceItemView[]>(data.current?.evidence ?? []);
  const [evidenceKey, setEvidenceKey] = useState(`${data.current?.id ?? 'none'}:open`);
  const [seenCurrentId, setSeenCurrentId] = useState(data.current?.id ?? null);
  // M-18: the files a restored draft says were still uploading when the page closed; shown once, as the block's prop.
  const [restoredNotUploaded, setRestoredNotUploaded] = useState<string[]>([]);
  // Evidence a restored draft holds that the block cannot name (uploaded after the current version, before the page
  // closed): kept in the answer and said so, never dropped without a word.
  const [extraEvidenceIds, setExtraEvidenceIds] = useState<string[]>([]);
  // A restored draft whose Save was pressed and never confirmed (7.4.1 "Offline or slow"): Retry is offered at once.
  const [restoredPressed, setRestoredPressed] = useState(false);
  // True once the form has mounted and read the device's draft: before that, a click is not yet the form's.
  const [ready, setReady] = useState(false);
  // Whether the field holds an answer of the person's that the current version does not: set by every edit and by a
  // restored draft, cleared by a save of exactly what the field holds and by Discard. The form keeps it itself, so it
  // holds in a browser that cannot keep drafts too: a new version replaces the form only when this is false (CR-1, F11).
  const [typedSinceCurrent, setTypedSinceCurrent] = useState(false);
  // D-398 item 4: a pressed Retry stays mounted, busy, while its own request is out, so focus stays on it.
  const [retrying, setRetrying] = useState(false);
  const saveBar = useRef<HTMLDivElement | null>(null);
  // The one submit control (C4): after a Retry's answer that leaves it reading "Save decision", focus moves to the bar.
  const submit = useRef<HTMLButtonElement | null>(null);
  const retryLabel = useRef(false);
  // Set when a Retry's request is answered, or a send removed a focused control of the bar: if nothing else took focus,
  // the bar takes it.
  const afterRetry = useRef(false);

  const store = useRef<DraftStore | null>(null);
  const summary = useRef<HTMLParagraphElement | null>(null);
  const focusSummary = useRef(false);
  // The draft as last sent when its reply said nothing was saved for sure; the `online` event sends it once.
  const pendingAuto = useRef<{ state: RetryState; omitted: string[] } | null>(null);
  const sending = useRef(false);
  // Read by the evidence block's callbacks, which its own effects call: a layout effect, so it is current before
  // any child's passive effect of the same commit runs.
  const latest = useRef({ value, base, retry });
  useLayoutEffect(() => { latest.current = { value, base, retry }; });

  // A new current version arrived (a save, or someone else's, after router.refresh): open from it, as on a new page.
  if ((data.current?.id ?? null) !== seenCurrentId) {
    setSeenCurrentId(data.current?.id ?? null);
    // Only when the field holds nothing of the person's that the new version lacks, and no link's request or file upload
    // is out: the block that sent it would be replaced, and the link or the file lost with it. Review B I-r4-1: "Save
    // without this file" saves while the file uploads, and the new version's remount aborted that upload and dropped it
    // without a word (e2e/decision-save-without-upload.spec.ts); kept, it finishes and edits the answer, so the next Save
    // adds it as the "Saved without" line promises.
    if (conflict === null && !typedSinceCurrent && !uploads.linkAdding && uploads.uploading.length === 0) {
      setValue(draftFromCurrent(data));
      setBase(currentNumber);
      setRetry(NO_RETRY);
      setEvidenceInitial(data.current?.evidence ?? []);
      setEvidenceItems(data.current?.evidence ?? []);
      setEvidenceKey(`${data.current?.id ?? 'none'}:open`);
      setExtraEvidenceIds([]);
    }
  }

  // On open: the store (or none: a private window), the purge of drafts past seven days, and this question's draft.
  useEffect(() => {
    const s = openDraftStore();
    store.current = s;
    // localStorage exists only in the browser, after hydration: a one-shot read on mount, as ThemeToggle's.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
    if (s === null) { setStorageUnavailable(true); return; }
    const now = new Date();
    s.purgeExpired(now);
    const found = s.read<DecisionDraft>(key, now);
    if (found === null || !isDraftValue(found.value)) return;
    const restored = { ...found.value, href: draftFromCurrent(data).href };
    setValue(restored);
    setTypedSinceCurrent(true);
    setBase(found.baseVersionNumber);
    setRetry(found.retry);
    setDraftSavedAt(found.savedAt);
    setRestoredNotUploaded(restored.notUploaded);
    setRestoredPressed(found.savePressedAt !== null);
    // The evidence block shows the restored ids it can name: those of the current version still in the answer.
    const carried = (data.current?.evidence ?? []).filter((e) => restored.evidenceIds.includes(e.id));
    setEvidenceInitial(carried);
    setEvidenceItems(carried);
    setExtraEvidenceIds(restored.evidenceIds.filter((id) => !carried.some((e) => e.id === id)));
    setEvidenceKey(`${data.current?.id ?? 'none'}:restored`);
    if (found.baseVersionNumber !== currentNumber && data.current !== null) setConflict(data.current);
    // Read once on open, for this question's key: the page gives the form a key per question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusSummary.current) { focusSummary.current = false; summary.current?.focus(); }
  });

  // After the answer to a Retry: a Retry still offered keeps its focus; the summary and the conflict view take focus
  // themselves (their effects run before this one); otherwise focus would fall to the page, so the save bar, which holds
  // the status line, takes it.
  useEffect(() => {
    if (!afterRetry.current) return;
    afterRetry.current = false;
    // C4: the Retry is the one submit control relabelled, not removed; when the answer leaves it reading "Save decision",
    // the Retry the person had is gone as before, and the bar takes focus as it did then.
    const active = document.activeElement;
    if (active === null || active === document.body || (active === submit.current && !retryLabel.current)) saveBar.current?.focus();
  });

  // W-3 narrow: the fixed save bar's height is the space the page reserves under its content (DecisionForm.css); on wide
  // screens (Option A) the pinned row's height is the scrolling box's scroll padding at its foot.
  // Measured after every render too, not only by the observer below: a render that grows the bar (the unsaved line
  // appearing on the first edit) is followed at once by the next key, and the observer reports only at the next
  // rendering frame, so a Tab before that frame scrolled the next field into view above the bar's old height and the
  // bar covered it (SC 2.4.11). A layout effect runs inside the same event, before the next key is handled.
  // When the bar has grown over the control that has focus (the radio whose Space made the first edit), that control
  // is scrolled clear once, above the new height; nothing moves when nothing is covered or focus is outside the form.
  // T10: the box that scrolls the card at this width carries the attribute that gives it the row's height as scroll padding
  // (DecisionForm.css); it is found again on every measure, so a resize across 1024 px moves it to the new scroller.
  const scroller = useRef<HTMLElement | null>(null);
  const applyBarHeight = useCallback((): void => {
    const bar = saveBar.current;
    if (bar === null) return;
    const now = cardScroller(bar);
    if (scroller.current !== now) {
      scroller.current?.removeAttribute(SCROLLER_ATTRIBUTE);
      now.setAttribute(SCROLLER_ATTRIBUTE, '');
      scroller.current = now;
    }
    const root = document.documentElement;
    const was = parseFloat(root.style.getPropertyValue('--decision-save-bar-h')) || 0;
    const h = bar.offsetHeight;
    if (h === was) return;
    root.style.setProperty('--decision-save-bar-h', `${h}px`);
    const focused = document.activeElement;
    if (h < was || !(focused instanceof HTMLElement) || bar.contains(focused) || !(bar.closest('form')?.contains(focused) ?? false)) return;
    // Covered: its lower edge under the bar's top, and it is on the screen at all (one the person scrolled away from stays).
    const r = focused.getBoundingClientRect();
    if (pinnedBar(bar) && r.bottom > bar.getBoundingClientRect().top && r.top < scrollerView(now).bottom) {
      focused.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, []);
  useLayoutEffect(applyBarHeight);

  /**
   * Brings what took focus wholly into view, unless it already is: between the screen's top and the top of the bar while
   * it covers the screen's foot (fixed, or pinned on a wide screen), or the screen's foot when the bar is in its place. A
   * control inside the bar is measured against the screen's foot: the bar holds it. A press on a control that is in view
   * must not move the page, or the press ends on whatever slid under it and is lost.
   */
  const footOfView = useCallback((): number => {
    const bar = saveBar.current;
    if (bar === null) return document.documentElement.clientHeight;
    return pinnedBar(bar) ? bar.getBoundingClientRect().top : scrollerView(cardScroller(bar)).bottom;
  }, []);
  const reveal = useCallback((el: Element): void => {
    const r = el.getBoundingClientRect();
    // Review B M-r4-2: only the wide screens' pinned (sticky) row holds its controls at the screen's foot; the phone's fixed
    // bar is measured as it was at 757f56ca (footOfView), so a control its own overflow clips is still scrolled into view.
    const bar = saveBar.current;
    const view = bar === null ? { top: 0, bottom: document.documentElement.clientHeight } : scrollerView(cardScroller(bar));
    const inPinnedRow = bar !== null && bar.contains(el) && getComputedStyle(bar).position === 'sticky';
    // T10: while the sticky row is pinned, scrolling its scroller cannot move it (it is held at the scroller's foot); it
    // only moves the card under a press on Save, and the press is lost. That happened when a box above the page frame (the
    // offline notice) pushed the frame's foot, row and all, below the window's: the button's foot was past the window's.
    if (inPinnedRow && pinnedBar(bar)) return;
    const foot = inPinnedRow ? view.bottom : footOfView();
    if (r.top >= view.top && r.bottom <= foot) return;
    el.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }, [footOfView]);

  /**
   * M-11: a summary link brings its field into view, the field's group (legend or label, hint and error) from its top,
   * or, when the group does not fit above the bar, the control itself just above it; then focuses the control without a
   * scroll of its own. Nothing is left in the address: a fragment would keep the control the :target, and a later press
   * on it would scroll by the target's margin and be lost (review T1). The link keeps its href for a page without
   * JavaScript. False when the control is not on the page, so the browser follows the href.
   */
  const land = useCallback((id: string): boolean => {
    const el = document.getElementById(id);
    if (el === null) return false;
    (el.closest('fieldset, .ui-field') ?? el).scrollIntoView({ block: 'start', behavior: 'instant' });
    if (el.getBoundingClientRect().bottom > footOfView()) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    el.focus({ preventScroll: true });
    return true;
  }, [footOfView]);
  useEffect(() => {
    const bar = saveBar.current;
    if (bar === null || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(applyBarHeight);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--decision-save-bar-h');
      scroller.current?.removeAttribute(SCROLLER_ATTRIBUTE);
      scroller.current = null;
    };
  }, [applyBarHeight]);

  /** Keeps the draft on this device; false when there is no store or the browser refused it. */
  const keep = useCallback((d: StoredDraft<DecisionDraft>): boolean => {
    const s = store.current;
    if (s === null) return false;
    if (s.write(key, d)) { setDraftSavedAt(d.savedAt); setStorageUnavailable(false); return true; }
    setStorageUnavailable(true);
    return false;
  }, [key]);

  /** An edit: kept on this device, never sent (UX-24). An edit after a press is no longer the answer that was pressed. */
  const edit = useCallback((next: DecisionDraft): void => {
    // The ref is made current here, not only by the layout effect after the next render: the evidence block reports a
    // finished upload with two edits in one effect flush, and the second must build on the first, not on the old value.
    latest.current = { ...latest.current, value: next };
    setValue(next);
    setRestoredPressed(false);
    setTypedSinceCurrent(true);
    keep({ baseVersionNumber: latest.current.base, value: next, savedAt: new Date().toISOString(), savePressedAt: null, retry: latest.current.retry });
  }, [keep]);

  /**
   * Reviews A M-1 and B M-r4-3: a focused way off the page (Next, All questions, a foot link) that a Save waiting or out turns
   * into text would leave focus on the page body; the bar takes it after that render (the after-Retry effect above).
   */
  const leaveHeldLink = useCallback((): void => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.closest(`[${HELD_ON_SAVE}]`) !== null) afterRetry.current = true;
  }, []);

  const send = useCallback(async (d: DecisionDraft, saveBase: number | null, state: RetryState, omitted: string[], auto = false, fromRetry = false): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    // Whatever this send's reply is, the automatic retry of an earlier one is spent or superseded (NFR-REL-05).
    pendingAuto.current = null;
    const body = toSaveBody(d, data, saveBase) as unknown as Record<string, unknown>;
    const id = requestIdFor(state, body);
    const now = new Date().toISOString();
    setRetry(id.state);
    keep({ baseVersionNumber: saveBase, value: d, savedAt: now, savePressedAt: now, retry: id.state });
    // A focused control in the bar that this send removes or disables (a Retry the person did not press, as on the
    // automatic retry or after waiting for uploads; Save itself) would leave focus on the page body: the bar takes it,
    // after the render that removed it and again after the answer (the effect below moves focus only from the body).
    const focusInBar = saveBar.current?.contains(document.activeElement) ?? false;
    if (focusInBar && !fromRetry) afterRetry.current = true;
    leaveHeldLink();
    setSaving(true);
    setRetrying(fromRetry);
    setErrors([]);
    setStatus(savingStatus(false));
    const outcome = await sendWrite<DecisionVersionView>(
      `/api/v1/orgs/${data.orgSlug}/projects/${data.projectId}/decisions`, 'POST', { ...body, requestId: id.requestId },
      { onSlow: () => setStatus(savingStatus(true)) },
    );
    sending.current = false;
    setSaving(false);
    setRetrying(false);
    afterRetry.current = fromRetry || focusInBar;
    const next = statusForOutcome(outcome, { viewerId: data.viewer.userId, timeText: formatTime });
    if ((next.id === 'M-03' || next.id === 'M-04') && outcome.kind === 'saved') {
      const saved = outcome.body.versionNumber;
      // The version this save made is the base of anything typed from now on.
      setBase(saved);
      setRetry(NO_RETRY);
      latest.current = { ...latest.current, base: saved, retry: NO_RETRY };
      setLeftOut(omitted);
      setConflict(null);
      setStatus(next);
      const typedDuringSave = JSON.stringify(latest.current.value) !== JSON.stringify(d);
      if (typedDuringSave) {
        // Typed while the save was out (7.4.1: typing still works): that answer is kept on the device on the new base, and
        // the form keeps it when the new version arrives (CR-1).
        keep({ baseVersionNumber: saved, value: latest.current.value, savedAt: new Date().toISOString(), savePressedAt: null, retry: NO_RETRY });
      } else {
        store.current?.remove(key);
        setDraftSavedAt(null);
        setExtraEvidenceIds([]);
        setTypedSinceCurrent(false);
      }
      // Design G3: the last question of a stage lands on that stage's end screen; the server renders it from what was just saved.
      // Only a clean "Saved" goes: a message the person must read keeps them here, with the end screen one link away.
      const end = endHrefAfterSave(nextQuestion, stageHref, { statusId: next.id, leftOut: omitted, typedDuringSave });
      if (end === null) router.refresh(); else router.push(end);
      return;
    }
    // The contract's Error codes table (CC-1): S-05, S-29 or the page's own not-found. The draft is already on the
    // device, its press kept, so Retry is offered when the person comes back. Whether the device holds it is decided now,
    // from what it holds now (the field's answer, written and read back): when it does not, the field is the only copy,
    // and a gate does not navigate by itself, it says what to do first and links there (CR-2).
    const nav = navigationForOutcome(outcome, d.href);
    if (nav !== null && nav.kind === 'go') {
      const v = latest.current.value;
      const pressed = JSON.stringify(v) === JSON.stringify(d);
      const draft = { baseVersionNumber: saveBase, value: v, savedAt: new Date().toISOString(), savePressedAt: pressed ? now : null, retry: id.state };
      if (draftHeldForGate(store.current, key, draft, new Date())) {
        setDraftSavedAt(draft.savedAt); setStorageUnavailable(false);
      } else {
        setStorageUnavailable(true);
        setStatus(gateStatus(nav));
        return;
      }
    }
    if (nav !== null) {
      setStatus(null);
      if (nav.kind === 'go') router.push(nav.href); else router.refresh();
      return;
    }
    // One automatic retry, armed only by a reply that says nothing was saved for sure, and never by a retry itself.
    if (outcome.kind === 'not_saved' && !auto) pendingAuto.current = { state: id.state, omitted };
    if (outcome.kind === 'rejected' && outcome.status !== 401) {
      // A refusal reached the server and was answered: the answer was not pressed into a pending save, so S-11 and a
      // reload do not offer it as one (F9). After request_id_reused the next press must not send the same id (UX-27).
      const reused = outcome.body.code === 'request_id_reused';
      if (reused) setRetry(NO_RETRY);
      keep({ baseVersionNumber: saveBase, value: latest.current.value, savedAt: now, savePressedAt: null, retry: reused ? NO_RETRY : id.state });
    }
    if (next.next === 'fix') {
      const fields = outcome.kind === 'rejected' ? outcome.body.fields ?? [] : [];
      const line = outcome.kind === 'rejected' && outcome.body.error !== '' ? outcome.body.error : next.text;
      setErrors(fields.length > 0 ? fields : [{ field: 'form', message: line }]);
      setStatus(null);
      focusSummary.current = true;
      return;
    }
    if (next.next === 'conflict') {
      const current = conflictCurrent(outcome);
      if (current !== null) setConflict(current);
    }
    setStatus(next);
  }, [data, key, keep, router, leaveHeldLink, nextQuestion, stageHref]);

  // NFR-REL-05: one automatic retry when the browser says it is online again, of the unchanged draft, same id.
  useEffect(() => {
    const onOnline = () => {
      const pending = pendingAuto.current;
      // Not while a pressed Save waits for a file or a link: that Save is the newer answer, and it disarms this one when it is sent.
      if (pending === null || sending.current || waitingNow.current) return;
      pendingAuto.current = null;
      const { value: v, base: b } = latest.current;
      const body = toSaveBody(v, data, b) as unknown as Record<string, unknown>;
      // Only the answer whose reply was lost: after an edit the body differs and nothing is sent by itself.
      if (requestIdFor(pending.state, body).requestId !== pending.state.requestId) return;
      void send(v, b, pending.state, pending.omitted, true);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [data, send]);

  /** Starts or ends the wait of a pressed Save, for the callout and for the block's next report. */
  function hold(on: boolean): void {
    if (on) leaveHeldLink();
    waitingNow.current = on;
    setWaiting(on);
  }

  function save(withoutUploads: boolean, files: { uploading: string[]; failed: string[] } = uploads, saveBase: number | null = base, fromRetry = false): void {
    if (saving) return;
    // The wait path runs inside the evidence block's effect flush, before this form re-renders, so the render's `value` can be one edit behind.
    const answer = latest.current.value;
    const fieldErrs = draftErrors(answer, data, new Date());
    // An address typed in the link box and never added is not in the answer, and the save would discard it without a word:
    // the save does not go, and the link is not added for the person. Not while the link's request is out: the box then
    // holds the address that is being added, and the save waits for it below.
    const unadded = linkTyped.current && !linkAdding.current;
    const errs = unadded ? [...fieldErrs, { field: 'form', message: EVIDENCE_COPY.link.typedNotAdded }] : fieldErrs;
    if (unadded) setLinkRefusals((n) => n + 1);
    if (errs.length > 0) {
      setErrors(errs);
      setStatus(null);
      hold(false);
      focusSummary.current = true;
      return;
    }
    const pendingFiles = [...files.uploading, ...files.failed];
    // A link whose request is out is not in the answer yet: the save waits for it as for a file, "Save without" included,
    // because nothing would say the link was left out (B3).
    if (linkAdding.current || (pendingFiles.length > 0 && !withoutUploads)) { hold(true); return; }
    hold(false);
    void send(answer, saveBase, retry, withoutUploads ? pendingFiles : [], false, fromRetry);
  }

  // UX-30: a Save that waited is sent once every chosen file has finished and no link's request is out (the block reports
  // each change of its uploads and of its link). A link that was not added while the Save waited ends the wait unsent:
  // the decision is never saved without it by itself (B3).
  const afterUploads = useRef<(s: { uploading: string[]; failed: string[]; linkAdding: boolean; linkNotAdded: boolean; linkTyped: boolean }) => void>(() => {});
  useLayoutEffect(() => {
    afterUploads.current = (s) => {
      const linkEnded = linkAdding.current && !s.linkAdding;
      linkAdding.current = s.linkAdding;
      linkTyped.current = s.linkTyped;
      // The summary's lines about the link form are true of the form as it was at the press. Once a link is being sent, or
      // the box is empty, they are not, and they go; a field's own line stays until the next Save, as it always has.
      if (s.linkAdding || !s.linkTyped) setErrors((e) => (e.some(isLinkLine) ? e.filter((x) => !isLinkLine(x)) : e));
      if (!waitingNow.current || s.linkAdding) return;
      if (linkEnded && s.linkNotAdded) {
        hold(false);
        setErrors([{ field: 'form', message: F.linkNotAdded }]);
        setStatus(null);
        focusSummary.current = true;
        return;
      }
      if (s.uploading.length === 0 && s.failed.length === 0) save(false, s);
    };
  });

  /**
   * The one Save/Retry control's press (C4), and a submit by Enter in a field: "Retry" takes the path today's Retry took
   * (`fromRetry`: it stays the pressed, busy control while its request is out), "Save decision" the path Save took.
   */
  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (isRetry) save(false, uploads, base, true); else save(false);
  }

  const deciderName = (() => {
    const d = value.decidedBy;
    if (d === null) return '';
    if (d.kind === 'outside_role') return OUTSIDE_ROLE_LABELS[d.role];
    if (d.userId === data.viewer.userId) return F.you(data.viewer.name);
    const other = isDecision(data.current) && data.current.decidedBy?.kind === 'member' && data.current.decidedBy.user.userId === d.userId
      ? F.formerMember(data.current.decidedBy.user.name) : '';
    return data.members.find((m) => m.userId === d.userId)?.name ?? other;
  })();

  const signInHref = signInAgainHref(value.href, '');
  const waitingFiles = [...uploads.uploading, ...uploads.failed];
  const consequence = consequenceOf(value, data, base);
  const isRetry = saveControlIsRetry({
    retry, body: toSaveBody(value, data, base) as unknown as Record<string, unknown>, status, restoredPressed, saving, retrying,
  });
  useLayoutEffect(() => { retryLabel.current = isRetry; });

  const held = waiting || saving;
  return (
    <SaveHeldContext.Provider value={held}>
    {lead}
    {/* SC 2.4.11: a control that takes focus anywhere in the answer form, the evidence block included, is brought wholly
        into view, instantly rather than with the page's smooth scroll (app/globals.css:225): the browser reveals a focused
        text control's caret, not its box, in a scroll it issues after this handler, and when both animate the browser's
        wins and leaves the box 2 px below the fold at <= 768 px, where the document and not .app-main scrolls. An instant
        scroll lands first, and the browser's if-needed reveal then finds the caret already in view. When the error
        summary's first line takes focus, the whole summary is brought into view, so its list is not left under the bar.
        A control already wholly in view is left where it is (reveal). */}
    <form method="post" noValidate onSubmit={onSubmit} onFocus={(e) => { const t: Element = e.target; reveal(t === summary.current ? t.parentElement ?? t : t); }} data-region-form="answer-form" data-ready={ready ? 'true' : undefined} aria-labelledby="s12-answer-form">
      {conflict !== null ? (
        <ConflictView
          current={conflict} mine={value} viewerId={data.viewer.userId}
          mineDecidedBy={deciderName} mineEvidence={evidenceItems.map((i) => i.fileName ?? i.label ?? i.url ?? F.evidenceFallback)}
          mineKeptEvidence={extraEvidenceIds.length}
          onSaveMine={() => { const b = conflict.versionNumber; setConflict(null); setBase(b); save(false, uploads, b); }}
          onEditMine={() => {
            const b = conflict.versionNumber;
            setConflict(null); setBase(b); setStatus(null);
            keep({ baseVersionNumber: b, value, savedAt: new Date().toISOString(), savePressedAt: null, retry });
            requestAnimationFrame(() => document.getElementById(data.question.type === 'gate' ? FIELD_TARGET.scopeAnswer : 'decision-reason')?.focus());
          }}
          onDiscard={() => { store.current?.remove(key); setConflict(null); setStatus(null); setDraftSavedAt(null); setTypedSinceCurrent(false); setSeenCurrentId('discarded'); router.refresh(); }}
        />
      ) : null}

      <div hidden={conflict !== null}>
        {/* Until the form has hydrated and read the device's draft, its controls refuse input visibly: a pick, a click or a
            native submit before then would be lost (F5, CR-3). */}
        <fieldset disabled={!ready} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {errors.length > 0 ? (
          <div role="alert" className="card" data-error-summary>
            <p tabIndex={-1} ref={summary} style={{ fontWeight: 700 }}>{problemSummary(errors.length)}</p>
            <ul>
              {errors.map((e) => (
                <li key={`${e.field}:${e.message}`}>
                  {FIELD_TARGET[e.field] !== undefined
                    ? <a href={`#${FIELD_TARGET[e.field]}`} onClick={(ev) => { if (land(FIELD_TARGET[e.field])) ev.preventDefault(); }}>{`${FIELD_LABEL[e.field]}: ${e.message}`}</a>
                    : e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DecisionFields data={data} value={value} errors={errors} disabled={false} onChange={edit} />

        {/* Named once, by the block's own fieldset legend "Evidence". */}
        <section data-region="evidence-block">
          <EvidenceBlock
            key={evidenceKey}
            orgSlug={data.orgSlug}
            projectId={data.projectId}
            initial={evidenceInitial}
            disabled={false}
            onChange={(ids) => {
              const now = latest.current.value;
              const all = [...ids, ...extraEvidenceIds.filter((x) => !ids.includes(x))];
              if (sameIds(all, now.evidenceIds)) return;   // the block's first report repeats what the form opened with
              edit({ ...now, evidenceIds: all });
            }}
            onUploadState={(s) => {
              setUploads({ uploading: s.uploading, failed: s.failed, linkAdding: s.linkAdding });
              const now = latest.current.value;
              // The draft names the files moving now, so a reload can say which did not finish (M-18).
              if (!sameIds(s.uploading, now.notUploaded)) edit({ ...now, notUploaded: [...s.uploading] });
              // Last, so a Save that waited sends the answer with that edit already in it; otherwise `send` sees the answer change under it.
              afterUploads.current(s);
            }}
            onItemsChange={setEvidenceItems}
            notUploaded={restoredNotUploaded}
            fromVersionNumber={isDecision(data.current) ? data.current.versionNumber : null}
            saveOut={saving}
            unaddedLinkRefusals={linkRefusals}
            initialLink={typedLink}
            onLinkInput={(l) => setTypedLink((o) => (o.url === l.url && o.label === l.label ? o : l))}
            examples={data.runningQuestion.evidenceExamples} decisionCard keptCount={extraEvidenceIds.length}
            saveWithout={waiting || waitingFiles.length === 0 ? null : { label: F.saveWithout(waitingFiles.length), onPress: () => save(true) }}
            ownOrigin={ownOrigin}
          />
        </section>

        {/* A status region that is on the page before the wait, so the card put into it is announced, once (one added with its words often is not). */}
        <div role="status" data-wait-status>
        {waiting ? (
          <div className="decision-form__box" data-upload-wait>
            <Callout kind="note">
              <WaitLines uploading={uploads.uploading} failed={uploads.failed} />
              {/* With no file to wait for, the wait is for a link, whether or not its report has been rendered yet. */}
              {uploads.linkAdding || waitingFiles.length === 0 ? <p>{EVIDENCE_COPY.link.waiting}</p> : null}
              <div className="form-actions">
                {waitingFiles.length > 0 ? <Button variant="secondary" onClick={() => save(true)}>{F.saveWithout(waitingFiles.length)}</Button> : null}
                <Button variant="secondary" onClick={() => hold(false)}>{F.cancel}</Button>
              </div>
            </Callout>
          </div>
        ) : null}
        </div>

        {/* R2: one line on what this save will do, after the fields and the evidence and before Save. Not a live region: it
            follows the choice as the person makes it, and the save's own status line announces what happened. */}
        <div className="decision-consequence">
          <svg className="decision-consequence__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" />
          </svg>
          <div>
            <p data-consequence><ConsequenceWords {...consequence} /></p>
            {consequence.finding ? <Definition of={TERM_FINDING} as="p" /> : null}
          </div>
        </div>

        {/* tabIndex -1: after a Retry's answer removes the Retry, focus comes here, beside the status line, not to the page. */}
        {/* Option A (owner, 15 Nov 2026): above 768 px the bar is sticky at the foot of the form, so it pins to the screen's foot
            while its place is below the fold and returns to it at the card's end (DecisionForm.css); the inner box carries the
            pinned look, which a scroll-state query sets on the bar's descendants. One bar, one Save, at every width. */}
        <div className="decision-save-bar" ref={saveBar} tabIndex={-1}>
          <div className="decision-save-bar__pin">
          <div className="decision-save-bar__row">
          <div className="form-actions">
            {/* C4: one control, "Save decision" or "Retry". A pressed Retry is busy, not disabled, while its request is out, so
                it keeps focus (D-398 item 4); Save is disabled while its request is out. */}
            <Button variant="primary" type="submit" ref={submit} disabled={saving && !retrying} busy={saving && retrying}>{isRetry ? F.retry : F.save}</Button>
            {/* Native links in the kit's button classes: ButtonLink is next/link, and the gate link carries data-gate-link. */}
            {status?.next === 'sign_in' ? <a className="ui-button ui-button--secondary" href={signInHref}>{F.signInAgain}</a> : null}
            {status?.next === 'go' && status.action !== undefined ? <a className="ui-button ui-button--secondary" href={status.action.href} data-gate-link>{status.action.label}</a> : null}
          </div>
          {/* R2, R9: the way on beside Save, a quiet link, never a second orange control; text while a Save waits or is out (B-I1). */}
          <NextWay next={nextQuestion} stageHref={stageHref} held={held} />
          </div>
          <SaveStatus status={status} draftSavedAt={draftSavedAt} storageUnavailable={storageUnavailable} />
          {leftOut.length > 0 && status !== null && (status.id === 'M-03' || status.id === 'M-04')
            ? <p>{F.savedWithout.before}<bdi>{fileList(leftOut)}</bdi>{leftOut.length === 1 ? F.savedWithout.after : F.savedWithout.afterMany}</p>
            : null}
          </div>
        </div>
        {/* GUARD: insert no block inside this fieldset on the frame a draft is restored (Chromium leaves .decision-fields 0 px
            tall, T6 and R6-1); the save bar stays its last child. Such blocks go after it, below. */}
        </fieldset>
        {/* R6-1: after the fieldset, as the unsaved line below is: it appears on the frame a draft is restored. */}
        {extraEvidenceIds.length > 0 ? (
          <div className="decision-form__box" data-kept-evidence>
            <Callout kind="note">
              <p>{keptEvidenceLine(extraEvidenceIds.length)}</p>
              <Button variant="secondary" size="compact" onClick={() => {
                const now = latest.current.value;
                setExtraEvidenceIds([]);
                edit({ ...now, evidenceIds: now.evidenceIds.filter((x) => !extraEvidenceIds.includes(x)) });
              }}>{F.removeKept(extraEvidenceIds.length)}</Button>
            </Callout>
          </div>
        ) : null}
        {/* Design N1: the unsaved line's words after its first sentence, under the bar's own place in the card, so the pinned
            bar stays one line taller and these show when it is back in its place. Hidden from assistive technology: the bar's
            live span reads the whole sentence. Not drawn on a phone, whose fixed bar shows the whole line (DecisionForm.css).
            After the fieldset, not in it, so the bar stays the fieldset's last child: drawn inside it on the frame a restored
            draft is read (the fieldset enabled, the fields refilled), Chromium left the fields' inline-size container
            (.decision-fields, DecisionFields.css) 0 px tall, every field undrawn, until the next layout. Inside the div the
            conflict view hides, so it is hidden with the form. */}
        {unsavedShown({ status, draftSavedAt, storageUnavailable })
          ? <p className="text-muted decision-unsaved-more" aria-hidden="true" data-unsaved-more>{F.unsavedMore}</p>
          : null}
      </div>
    </form>
    {foot}
    </SaveHeldContext.Provider>
  );
}
