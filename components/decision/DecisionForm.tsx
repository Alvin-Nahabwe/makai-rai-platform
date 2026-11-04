'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { ConflictView } from '@/components/decision/ConflictView';
import { DecisionFields, FIELD_LABEL, FIELD_TARGET } from '@/components/decision/DecisionFields';
import { SaveStatus } from '@/components/decision/SaveStatus';
import { decisionFormNote } from '@/lib/authz/permissionNotes';
import { signInAgainHref } from '@/lib/auth/idle';
import { openDraftStore, type DraftStore, type StoredDraft } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { OUTSIDE_ROLE_LABELS, problemSummary } from '@/lib/decision/copy';
import { formatTime } from '@/lib/format/dates';
import { draftErrors, draftFromCurrent, draftKeyFor, isDecision, isDraftValue, keptEvidenceLine, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { conflictCurrent, navigationForOutcome, savingStatus, statusForOutcome, type SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
import './DecisionForm.css';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';
import type { FieldError, UtcInstant } from '@/types/record';

export type DecisionFormProps = { data: QuestionPanelData };

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

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
export function DecisionForm({ data }: DecisionFormProps): ReactElement | null {
  if (!data.canWrite) {
    const note = decisionFormNote(data.viewer.role, data.projectArchived);
    return note === null ? null : <p data-permission-note>{note}</p>;
  }
  return <WritableDecisionForm data={data} />;
}

function WritableDecisionForm({ data }: DecisionFormProps): ReactElement {
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
  const [uploads, setUploads] = useState<{ uploading: string[]; failed: string[] }>({ uploading: [], failed: [] });
  const [waiting, setWaiting] = useState(false);
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
  // Set by this form's own save when nothing was typed since the press: the version that save made, arriving through
  // router.refresh, may then replace the form. Any edit clears it, so typing is never thrown away (CR-1, F11).
  const [resetOnNextCurrent, setResetOnNextCurrent] = useState(false);
  const saveBar = useRef<HTMLDivElement | null>(null);

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
    // Only after this form's own save with nothing typed since, or with no answer of the person's on the device.
    if (conflict === null && (resetOnNextCurrent || draftSavedAt === null)) {
      setResetOnNextCurrent(false);
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

  // W-3 narrow: the fixed save bar's height is the space the page reserves under its content (DecisionForm.css).
  useEffect(() => {
    const bar = saveBar.current;
    if (bar === null || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => { root.style.setProperty('--decision-save-bar-h', `${bar.offsetHeight}px`); });
    observer.observe(bar);
    return () => { observer.disconnect(); root.style.removeProperty('--decision-save-bar-h'); };
  }, []);

  /** Keeps the draft on this device; false when the browser refused it. */
  const keep = useCallback((d: StoredDraft<DecisionDraft>): void => {
    const s = store.current;
    if (s === null) return;
    if (s.write(key, d)) { setDraftSavedAt(d.savedAt); setStorageUnavailable(false); } else setStorageUnavailable(true);
  }, [key]);

  /** An edit: kept on this device, never sent (UX-24). An edit after a press is no longer the answer that was pressed. */
  const edit = useCallback((next: DecisionDraft): void => {
    setValue(next);
    setRestoredPressed(false);
    setResetOnNextCurrent(false);
    keep({ baseVersionNumber: latest.current.base, value: next, savedAt: new Date().toISOString(), savePressedAt: null, retry: latest.current.retry });
  }, [keep]);

  const send = useCallback(async (d: DecisionDraft, saveBase: number | null, state: RetryState, omitted: string[], auto = false): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    // Whatever this send's reply is, the automatic retry of an earlier one is spent or superseded (NFR-REL-05).
    pendingAuto.current = null;
    const body = toSaveBody(d, data, saveBase) as unknown as Record<string, unknown>;
    const id = requestIdFor(state, body);
    const now = new Date().toISOString();
    setRetry(id.state);
    keep({ baseVersionNumber: saveBase, value: d, savedAt: now, savePressedAt: now, retry: id.state });
    setSaving(true);
    setErrors([]);
    setStatus(savingStatus(false));
    const outcome = await sendWrite<DecisionVersionView>(
      `/api/v1/orgs/${data.orgSlug}/projects/${data.projectId}/decisions`, 'POST', { ...body, requestId: id.requestId },
      { onSlow: () => setStatus(savingStatus(true)) },
    );
    sending.current = false;
    setSaving(false);
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
      if (JSON.stringify(latest.current.value) !== JSON.stringify(d)) {
        // Typed while the save was out (7.4.1: typing still works): that answer is kept on the device on the new base, and
        // the form keeps it when the new version arrives (CR-1).
        keep({ baseVersionNumber: saved, value: latest.current.value, savedAt: new Date().toISOString(), savePressedAt: null, retry: NO_RETRY });
      } else {
        store.current?.remove(key);
        setDraftSavedAt(null);
        setExtraEvidenceIds([]);
        setResetOnNextCurrent(true);
      }
      router.refresh();
      return;
    }
    // The contract's Error codes table (CC-1): S-05, S-29 or the page's own not-found. The draft is already on the
    // device, its press kept, so Retry is offered when the person comes back.
    const nav = navigationForOutcome(outcome, d.href);
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
  }, [data, key, keep, router]);

  // NFR-REL-05: one automatic retry when the browser says it is online again, of the unchanged draft, same id.
  useEffect(() => {
    const onOnline = () => {
      const pending = pendingAuto.current;
      if (pending === null || sending.current) return;
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

  function save(withoutUploads: boolean, files: { uploading: string[]; failed: string[] } = uploads, saveBase: number | null = base): void {
    if (saving) return;
    const errs = draftErrors(value, data, new Date());
    if (errs.length > 0) {
      setErrors(errs);
      setStatus(null);
      setWaiting(false);
      focusSummary.current = true;
      return;
    }
    const pendingFiles = [...files.uploading, ...files.failed];
    if (pendingFiles.length > 0 && !withoutUploads) { setWaiting(true); return; }
    setWaiting(false);
    void send(value, saveBase, retry, withoutUploads ? pendingFiles : []);
  }

  // UX-30: a Save that waited is sent once every chosen file has finished (the block reports each change of its uploads).
  const afterUploads = useRef<(s: { uploading: string[]; failed: string[] }) => void>(() => {});
  useLayoutEffect(() => {
    afterUploads.current = (s) => { if (waiting && s.uploading.length === 0 && s.failed.length === 0) save(false, s); };
  });

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    save(false);
  }

  const deciderName = (() => {
    const d = value.decidedBy;
    if (d === null) return '';
    if (d.kind === 'outside_role') return OUTSIDE_ROLE_LABELS[d.role];
    if (d.userId === data.viewer.userId) return `You (${data.viewer.name})`;
    const other = isDecision(data.current) && data.current.decidedBy?.kind === 'member' && data.current.decidedBy.user.userId === d.userId
      ? `${data.current.decidedBy.user.name} (former member)` : '';
    return data.members.find((m) => m.userId === d.userId)?.name ?? other;
  })();

  const signInHref = signInAgainHref(value.href, '');

  return (
    // SC 2.4.11: a control that takes focus anywhere in the answer form, the evidence block included, is brought wholly
    // into view, instantly rather than with the page's smooth scroll (app/globals.css:225): the browser reveals a focused
    // text control's caret, not its box, in a scroll it issues after this handler, and when both animate the browser's
    // wins and leaves the box 2 px below the fold at <= 768 px, where the document and not .app-main scrolls. An instant
    // scroll lands first, and the browser's if-needed reveal then finds the caret already in view.
    <form method="post" noValidate onSubmit={onSubmit} onFocus={(e) => { e.target.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); }} data-region-form="answer-form" data-ready={ready ? 'true' : undefined} aria-labelledby="s12-answer-form">
      {conflict !== null ? (
        <ConflictView
          current={conflict} mine={value} viewerId={data.viewer.userId}
          mineDecidedBy={deciderName} mineEvidence={evidenceItems.map((i) => i.fileName ?? i.label ?? i.url ?? 'Evidence')}
          mineKeptEvidence={extraEvidenceIds.length}
          onSaveMine={() => { const b = conflict.versionNumber; setConflict(null); setBase(b); save(false, uploads, b); }}
          onEditMine={() => {
            const b = conflict.versionNumber;
            setConflict(null); setBase(b); setStatus(null);
            keep({ baseVersionNumber: b, value, savedAt: new Date().toISOString(), savePressedAt: null, retry });
            requestAnimationFrame(() => document.getElementById(data.question.type === 'gate' ? FIELD_TARGET.scopeAnswer : 'decision-reason')?.focus());
          }}
          onDiscard={() => { store.current?.remove(key); setConflict(null); setStatus(null); setDraftSavedAt(null); setSeenCurrentId('discarded'); router.refresh(); }}
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
                    ? <a href={`#${FIELD_TARGET[e.field]}`}>{`${FIELD_LABEL[e.field]}: ${e.message}`}</a>
                    : e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DecisionFields data={data} value={value} errors={errors} disabled={false} onChange={edit} />

        <section data-region="evidence-block" aria-labelledby="s12-evidence">
          <h3 id="s12-evidence">Evidence</h3>
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
              setUploads(s);
              afterUploads.current(s);
              const now = latest.current.value;
              // The draft names the files moving now, so a reload can say which did not finish (M-18).
              if (!sameIds(s.uploading, now.notUploaded)) edit({ ...now, notUploaded: [...s.uploading] });
            }}
            onItemsChange={setEvidenceItems}
            notUploaded={restoredNotUploaded}
            fromVersionNumber={isDecision(data.current) ? data.current.versionNumber : null}
          />
        </section>

        {extraEvidenceIds.length > 0 ? (
          <div className="card" data-kept-evidence>
            <p>{keptEvidenceLine(extraEvidenceIds.length)}</p>
            <button type="button" className="btn btn--secondary btn--small" onClick={() => {
              const now = latest.current.value;
              setExtraEvidenceIds([]);
              edit({ ...now, evidenceIds: now.evidenceIds.filter((x) => !extraEvidenceIds.includes(x)) });
            }}>Leave it out</button>
          </div>
        ) : null}

        {waiting ? (
          <div className="card" data-upload-wait>
            <p>Waiting for <bdi>{fileList([...uploads.uploading, ...uploads.failed])}</bdi> to finish uploading.</p>
            <div className="form-actions">
              <button type="button" className="btn btn--secondary" onClick={() => save(true)}>Save without it</button>
              <button type="button" className="btn btn--secondary" onClick={() => setWaiting(false)}>Cancel</button>
            </div>
          </div>
        ) : null}

        <div className="decision-save-bar" ref={saveBar}>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={saving}>Save decision</button>
            {status?.next === 'retry' || (status === null && restoredPressed) ? <button type="button" className="btn btn--secondary" disabled={saving} onClick={() => save(false)}>Retry</button> : null}
            {status?.next === 'sign_in' ? <a className="btn btn--secondary" href={signInHref}>Sign in again</a> : null}
          </div>
          <SaveStatus status={status} draftSavedAt={draftSavedAt} storageUnavailable={storageUnavailable} />
          {leftOut.length > 0 && status !== null && (status.id === 'M-03' || status.id === 'M-04')
            ? <p>Saved without <bdi>{fileList(leftOut)}</bdi>. Add it in a new save once it has uploaded.</p>
            : null}
        </div>
        </fieldset>
      </div>
    </form>
  );
}
