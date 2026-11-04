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
import { draftErrors, draftFromCurrent, draftKeyFor, isDecision, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { conflictCurrent, savingStatus, statusForOutcome, type SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
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

  const store = useRef<DraftStore | null>(null);
  const summary = useRef<HTMLParagraphElement | null>(null);
  const focusSummary = useRef(false);
  // The draft as last sent when its reply said nothing was saved for sure; the `online` event sends it once.
  const pendingAuto = useRef<{ body: Record<string, unknown>; state: RetryState } | null>(null);
  // Read by the evidence block's callbacks, which its own effects call: a layout effect, so it is current before
  // any child's passive effect of the same commit runs.
  const latest = useRef({ value, base, retry });
  useLayoutEffect(() => { latest.current = { value, base, retry }; });

  // A new current version arrived (a save, or someone else's, after router.refresh): open from it, as on a new page.
  if ((data.current?.id ?? null) !== seenCurrentId) {
    setSeenCurrentId(data.current?.id ?? null);
    if (status === null || status.next === 'none') {
      setValue(draftFromCurrent(data));
      setBase(currentNumber);
      setRetry(NO_RETRY);
      setEvidenceInitial(data.current?.evidence ?? []);
      setEvidenceItems(data.current?.evidence ?? []);
      setEvidenceKey(`${data.current?.id ?? 'none'}:open`);
    }
  }

  // On open: the store (or none: a private window), the purge of drafts past seven days, and this question's draft.
  useEffect(() => {
    const s = openDraftStore();
    store.current = s;
    // localStorage exists only in the browser, after hydration: a one-shot read on mount, as ThemeToggle's.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // The evidence block shows the restored ids it can name: those of the current version still in the answer.
    const carried = (data.current?.evidence ?? []).filter((e) => restored.evidenceIds.includes(e.id));
    setEvidenceInitial(carried);
    setEvidenceItems(carried);
    setEvidenceKey(`${data.current?.id ?? 'none'}:restored`);
    if (found.baseVersionNumber !== currentNumber && data.current !== null) setConflict(data.current);
    // Read once on open, for this question's key: the page gives the form a key per question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusSummary.current) { focusSummary.current = false; summary.current?.focus(); }
  });

  /** Keeps the draft on this device; false when the browser refused it. */
  const keep = useCallback((d: StoredDraft<DecisionDraft>): void => {
    const s = store.current;
    if (s === null) return;
    if (s.write(key, d)) { setDraftSavedAt(d.savedAt); setStorageUnavailable(false); } else setStorageUnavailable(true);
  }, [key]);

  /** An edit: kept on this device, never sent (UX-24). An edit after a press is no longer the answer that was pressed. */
  const edit = useCallback((next: DecisionDraft): void => {
    setValue(next);
    pendingAuto.current = null;
    keep({ baseVersionNumber: latest.current.base, value: next, savedAt: new Date().toISOString(), savePressedAt: null, retry: latest.current.retry });
  }, [keep]);

  const send = useCallback(async (d: DecisionDraft, saveBase: number | null, state: RetryState, omitted: string[]): Promise<void> => {
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
    setSaving(false);
    const next = statusForOutcome(outcome, { viewerId: data.viewer.userId, timeText: formatTime });
    if (outcome.kind === 'saved') {
      store.current?.remove(key);
      setDraftSavedAt(null);
      setLeftOut(omitted);
      setStatus(next);
      router.refresh();
      return;
    }
    if (outcome.kind === 'not_saved') pendingAuto.current = { body, state: id.state };
    if (next.next === 'fix') {
      const fields = outcome.kind === 'rejected' ? outcome.body.fields ?? [] : [];
      setErrors(fields.length > 0 ? fields : [{ field: 'form', message: next.text }]);
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
      pendingAuto.current = null;
      if (pending === null) return;
      const { value: v, base: b } = latest.current;
      const body = toSaveBody(v, data, b) as unknown as Record<string, unknown>;
      // Only the answer whose reply was lost: an edit since then clears `pendingAuto`, and the body must still match.
      if (requestIdFor(pending.state, body).requestId !== pending.state.requestId) return;
      void send(v, b, pending.state, []);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [data, send]);

  function save(withoutUploads: boolean, files: { uploading: string[]; failed: string[] } = uploads): void {
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
    void send(value, base, retry, withoutUploads ? pendingFiles : []);
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
    return data.members.find((m) => m.userId === d.userId)?.name ?? '';
  })();

  const signInHref = signInAgainHref(value.href, '');
  const summaryErrors = errors;

  return (
    <form method="post" noValidate onSubmit={onSubmit} data-region-form="answer-form" aria-labelledby="s12-answer-form">
      {conflict !== null ? (
        <ConflictView
          current={conflict} mine={value} viewerId={data.viewer.userId}
          mineDecidedBy={deciderName} mineEvidence={evidenceItems.map((i) => i.fileName ?? i.label ?? i.url ?? 'Evidence')}
          onSaveMine={() => { const b = conflict.versionNumber; setConflict(null); setBase(b); void send(value, b, retry, []); }}
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
        {summaryErrors.length > 0 ? (
          <div role="alert" className="card" data-error-summary>
            <p tabIndex={-1} ref={summary}><strong>{problemSummary(summaryErrors.length)}</strong></p>
            <ul>
              {summaryErrors.map((e) => (
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
              if (sameIds(ids, now.evidenceIds)) return;   // the block's first report repeats what the form opened with
              edit({ ...now, evidenceIds: ids });
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

        {waiting ? (
          <div className="card" data-upload-wait>
            <p>Waiting for <bdi>{fileList([...uploads.uploading, ...uploads.failed])}</bdi> to finish uploading.</p>
            <div className="form-actions">
              <button type="button" className="btn btn--secondary" onClick={() => save(true)}>Save without it</button>
              <button type="button" className="btn btn--secondary" onClick={() => setWaiting(false)}>Cancel</button>
            </div>
          </div>
        ) : null}

        <div className="form-actions decision-save-bar">
          <button type="submit" className="btn btn--primary" disabled={saving}>Save decision</button>
          {status?.next === 'retry' ? <button type="button" className="btn btn--secondary" disabled={saving} onClick={() => save(false)}>Retry</button> : null}
          {status?.next === 'sign_in' ? <a className="btn btn--secondary" href={signInHref}>Sign in again</a> : null}
        </div>
        <SaveStatus status={status} draftSavedAt={draftSavedAt} storageUnavailable={storageUnavailable} />
        {leftOut.length > 0 && status !== null && (status.id === 'M-03' || status.id === 'M-04')
          ? <p>Saved without <bdi>{fileList(leftOut)}</bdi>. Add it in a new save once it has uploaded.</p>
          : null}
      </div>
    </form>
  );
}

/** A stored value that has the draft's shape; anything else (an older shape, a hand edit) is ignored. */
function isDraftValue(v: unknown): v is DecisionDraft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const date = d.date as Record<string, unknown> | null;
  return typeof d.reason === 'string' && strings(d.optionsInPlace) && strings(d.evidenceIds) && strings(d.notUploaded)
    && typeof date === 'object' && date !== null && ['day', 'month', 'year'].every((k) => typeof date[k] === 'string')
    && (d.status === null || typeof d.status === 'string') && (d.scopeAnswer === null || typeof d.scopeAnswer === 'string')
    && (d.reasonCode === null || typeof d.reasonCode === 'string') && (d.decidedBy === null || typeof d.decidedBy === 'object');
}
