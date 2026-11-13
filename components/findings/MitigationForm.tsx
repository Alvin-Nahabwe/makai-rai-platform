'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { ErrorSummary, FailureText, Field, StatusLine } from '@/components/findings/FindingActions';
import { LocalTime } from '@/components/ui/LocalTime';
import { openDraftStore, type DraftKey, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import {
  characterCount, charCount, conflictAction, dueDateOf, emptyMitigationValue, isNewerVersion, KEPT_IN_FORM, KEPT_ON_DEVICE, mitigationDraftTarget,
  mitigationFormErrors, mitigationRequestBody, mitigationSavedText, activeUpload, formSummary, restoreMitigationDraft, saveGate, TEXT_MAX, writeFailure, writeMitigationDraft,
  type ConflictChoice, type MitigationFormValue,
} from '@/lib/findings/formRules';
import { formatDay, formatTime } from '@/lib/format/dates';
import type { FieldError, MitigationStatus } from '@/types/record';
import type { MitigationVersionView, UserRef } from '@/types/api';

export type MitigationFormProps = {
  orgSlug: string; projectId: string; findingId: string; base: MitigationVersionView | null;
  owners: UserRef[]; controls: ReadonlyArray<{ id: string; name: string }>; userId: string; orgId: string;
  /** Called after a save, so the toggle that holds the form can close it. */
  onSaved?: (text: ReactNode) => void;
  onClose?: () => void;
};

/**
 * A mitigation's status word (7.5.6): "Planned", "In progress", "Done", "Cancelled", and "Done, no artefact: <note>" for a done
 * version with no evidence (`noArtefactNote`). This is the one place the words are written: the mitigation form's radios use it
 * too (`plain`: no `status-label` class, because a radio's label is not a status shown in a list). "In progress" is exempt from the
 * claims lint (FR-PUB-01 flags "progress" in any form) by its entry in __tests__/lint/claim-allowlist.json: it is the status
 * word of one mitigation of the team, not a statement about the platform or a stage.
 */
export function MitigationStatusWord({ status, noArtefactNote = null, plain = false }: { status: MitigationStatus; noArtefactNote?: string | null; plain?: boolean }): ReactElement {
  return (
    <span className={plain ? undefined : 'status-label'}>
      {status === 'planned' ? 'Planned'
        : status === 'in_progress'
          ? 'In progress'
        : status === 'cancelled' ? 'Cancelled'
        : noArtefactNote !== null ? <>Done, no artefact: <bdi>{noArtefactNote}</bdi></> : 'Done'}
    </span>
  );
}

/** "Not attached: a.pdf, b.pdf." with each file name inside <bdi>, so a name with direction controls cannot reorder the sentence (UX-30). */
export function NotAttached({ names }: { names: readonly string[] }): ReactElement {
  return <>Not attached: {names.map((n, i) => <span key={i}>{i > 0 ? ', ' : ''}<bdi>{n}</bdi></span>)}.</>;
}

/** The saved line, with the files left out when the person chose "Save without it". */
function savedLine(text: string, left: readonly string[]): ReactNode {
  return left.length === 0 ? text : <>{text} <NotAttached names={left} /></>;
}

/**
 * The conflict view of 7.4.4 (W-4): the newer version beside the draft, who saved it and when, and the three actions. Nothing is merged.
 * Dates are written "10 Nov 2026" (7.5.8); a newer version with no wording leaves its clause out.
 */
export function MitigationConflictView(p: {
  newer: MitigationVersionView; mine: MitigationFormValue; userId: string; busy: boolean; alert: { text: string; name?: string } | null; status: ReactNode;
  onSaveMine: () => void; onEditFirst: () => void; onDiscard: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = `mit-conflict-${useId().replace(/:/g, '')}`;
  useEffect(() => { headingRef.current?.focus(); }, [p.newer.versionNumber]);
  const same = p.newer.enteredBy.userId === p.userId;
  const mineDue = dueDateOf(p.mine.due);
  return (
    <section aria-labelledby={headingId} className="card">
      <h3 id={headingId} tabIndex={-1} ref={headingRef}>Someone saved a newer version of this mitigation</h3>
      <p role="alert">
        Version {p.newer.versionNumber} was saved by {same ? 'you' : <bdi>{p.newer.enteredBy.name}</bdi>} at <LocalTime at={p.newer.receivedAt} />
        {same ? ', probably by an earlier attempt from this device or another device' : ' after you started'}. Review it, then save yours as version {p.newer.versionNumber + 1} or discard it.
      </p>
      <p>The newer version: {p.newer.what === null ? null : <><bdi>{p.newer.what}</bdi>, </>}owner <bdi>{p.newer.owner.name}</bdi>, due {formatDay(p.newer.dueDate)}.</p>
      <p>Yours: <bdi>{p.mine.what}</bdi>{mineDue === null ? '' : `, due ${formatDay(mineDue)}`}.</p>
      <div className="form-actions">
        <button type="button" className="btn btn--primary" aria-disabled={p.busy ? true : undefined} onClick={p.onSaveMine}>Save mine as version {p.newer.versionNumber + 1}</button>
        <button type="button" className="btn btn--secondary" onClick={p.onEditFirst}>Edit mine first</button>
        <button type="button" className="btn btn--secondary" onClick={p.onDiscard}>Discard mine</button>
      </div>
      {p.alert === null ? null : <p role="alert"><FailureText text={p.alert.text} name={p.alert.name} /></p>}
      <StatusLine>{p.status}</StatusLine>
    </section>
  );
}

const STATUSES: readonly MitigationStatus[] = ['planned', 'in_progress', 'done', 'cancelled'];
const NO_RETRY: RetryState = { requestId: null, sentBody: null };

/**
 * The mitigation form of S-15 (W-5 note 3; FR-FND-03, FR-FND-04; UX-16, UX-24 to UX-27, UX-30): "Add a mitigation" and
 * "Update this mitigation" are the same form. Nothing is sent until Save is pressed (UX-24). What is typed is kept in the
 * browser under the account's mitigation key, with the version it started from inside the value and the request id of
 * the last send inside `retry`; it is restored on the next visit and deleted when the server confirms the save (UX-26).
 * Save checks the fields first (the summary takes focus and nothing is sent), then holds for a file still uploading
 * (UX-30), then sends route 6 or 7. A 409 `base_version_moved` shows the newer version beside the draft with "Save mine as
 * version N", "Edit mine first" and "Discard mine" (7.4.4); nothing is merged.
 */
export function MitigationForm(p: MitigationFormProps): ReactElement | null {
  const router = useRouter();
  const idBase = `mit-${useId().replace(/:/g, '')}`;
  const [base, setBase] = useState<MitigationVersionView | null>(p.base);   // moves to the newer version when "Edit mine first" is chosen
  const [value, setValue] = useState<MitigationFormValue>(() => emptyMitigationValue(p.base));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ReactNode>('');
  const [alert, setAlert] = useState<{ text: string; retry: boolean; name?: string } | null>(null);
  const [conflict, setConflict] = useState<MitigationVersionView | null>(null);
  const [rawUpload, setUpload] = useState<{ uploading: string[]; failed: string[] }>({ uploading: [], failed: [] });
  const [held, setHeld] = useState(false);
  const [notUploaded, setNotUploaded] = useState<string[]>([]);
  const [cannotKeep, setCannotKeep] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [evidenceKey, setEvidenceKey] = useState(0);
  const upload = useMemo(() => activeUpload(value.status, rawUpload), [value.status, rawUpload]);   // the evidence block is gone, with its uploads, unless the status is Done
  const store = useRef<DraftStore | null>(null);
  const retry = useRef<RetryState>(NO_RETRY);
  const savePressedAt = useRef<string | null>(null);
  const restored = useRef(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const key: DraftKey = useMemo(
    () => mitigationDraftTarget({ userId: p.userId, orgId: p.orgId, projectId: p.projectId, findingId: p.findingId, mitigationId: p.base?.mitigationId ?? null }),
    [p.userId, p.orgId, p.projectId, p.findingId, p.base?.mitigationId]);

  // On mount only: open the browser's draft store and restore this form's draft, if any (UX-26). A draft that started from
  // another version than the current one shows the conflict at once.
  useEffect(() => {
    if (mounted.current) return;   // a refresh gives `base` a new identity; the draft is read once
    mounted.current = true;
    store.current = openDraftStore();
    if (store.current === null) { setCannotKeep(true); restored.current = true; return; }
    const r = restoreMitigationDraft(store.current, key, new Date(), p.base);
    if (r.kind === 'restored') {
      setValue(r.value); setDirty(true); setNotUploaded(r.value.uploading);
      retry.current = r.retry; savePressedAt.current = r.savePressedAt;
      if (r.conflict !== null) setConflict(r.conflict);
    }
    restored.current = true;
  }, [key, p.base]);

  // Every change is written (UX-26). A refused write is said in words.
  useEffect(() => {
    const kept = writeMitigationDraft(store.current, key, {
      restored: restored.current, dirty, conflict, base, value, upload, savePressedAt: savePressedAt.current, retry: retry.current, now: new Date(),
    });
    if (kept !== null) setCannotKeep(!kept);
  }, [value, dirty, key, base, upload, conflict]);

  const change = useCallback((patch: Partial<MitigationFormValue>) => {
    setValue((v) => ({ ...v, ...patch })); setDirty(true); setErrors([]); setHeld(false);
  }, []);

  const kept = cannotKeep ? KEPT_IN_FORM : KEPT_ON_DEVICE;
  const post = async (body: Record<string, unknown>, usingBase: MitigationVersionView | null, left: string[]) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setAlert(null); setStatus('Saving...');
    try {
      const next = requestIdFor(retry.current, body);
      retry.current = next.state;
      // The id is written to the draft before the send, so a reload after a timeout retries under the same id (UX-27).
      if (store.current !== null && dirty) {
        setCannotKeep(!store.current.write(key, { baseVersionNumber: usingBase?.versionNumber ?? null, value: { ...value, uploading: [...upload.uploading, ...upload.failed] },
          savedAt: new Date().toISOString(), savePressedAt: savePressedAt.current, retry: retry.current }));
      }
      const url = `/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}/mitigations${usingBase === null ? '' : `/${encodeURIComponent(usingBase.mitigationId)}`}`;
      const outcome = await sendWrite<MitigationVersionView>(url, 'POST', { requestId: next.requestId, ...body }, {
        onSlow: () => setStatus(`Still saving. The connection is slow. ${kept}`),
      });
      const failed = writeFailure(outcome, kept);
      if (failed === null && outcome.kind === 'saved') {
        store.current?.remove(key); retry.current = NO_RETRY; savePressedAt.current = null;
        const line = savedLine(mitigationSavedText(outcome.body, formatTime(outcome.body.receivedAt)), left);
        setDirty(false); setConflict(null); setHeld(false); setValue(emptyMitigationValue(null)); setEvidenceKey((n) => n + 1);
        setStatus(line);
        p.onSaved?.(line);
        router.refresh();
        return;
      }
      setStatus('');
      if (failed?.conflict?.code === 'base_version_moved' && isNewerVersion(failed.conflict.current)) {
        setConflict(failed.conflict.current);
      } else if (failed?.conflict?.code === 'base_version_moved') {
        setAlert({ text: 'Someone saved a newer version first. Reload this page.', retry: false });
      } else if (failed !== null && failed.fields.length > 0) {
        setConflict(null); setErrors(failed.fields); setAttempt((n) => n + 1);
      } else if (failed !== null) {
        setAlert({ text: failed.text, retry: failed.retry, name: failed.nameInText });
      }
    } catch (e) {
      // A fault in this page's own code after a reply: the person must not be left on "Saving...".
      setStatus('');
      setAlert({ text: `The reply could not be shown. Reload this page to see whether it saved. ${kept}`, retry: false });
      console.error('MitigationForm: the reply to a save could not be shown', e);   // reported, not rethrown: every caller is a floating promise
    } finally {
      inFlight.current = false; setBusy(false);
    }
  };

  /** The three actions of 7.4.4 (`conflictAction` decides what each does). "Save mine" checks the fields against the newer version first. */
  const choose = (choice: ConflictChoice, newer: MitigationVersionView) => {
    const act = conflictAction(choice, newer, value);
    setBase(act.base); setValue(act.value);
    if (!act.keepDraft) { store.current?.remove(key); retry.current = NO_RETRY; setDirty(false); setEvidenceKey((n) => n + 1); setConflict(null); return; }
    setDirty(true);
    if (!act.send) { setConflict(null); return; }
    const problems = mitigationFormErrors(act.value, act.base);
    if (problems.length > 0) { setErrors(problems); setAttempt((n) => n + 1); setConflict(null); return; }
    void post(mitigationRequestBody(act.value, act.base), act.base, [...upload.uploading, ...upload.failed]);
  };

  const save = (opts: { skipGate?: boolean } = {}) => {
    savePressedAt.current = new Date().toISOString();
    const problems = mitigationFormErrors(value, base);
    setErrors(problems); setAttempt((n) => n + 1);
    if (problems.length > 0) return;
    const gate = saveGate(upload);
    if (!gate.send && opts.skipGate !== true) { setHeld(true); return; }
    setHeld(false);
    void post(mitigationRequestBody(value, base), base, opts.skipGate === true ? [...upload.uploading, ...upload.failed] : []);
  };

  if (p.base?.status === 'cancelled') return null;   // a cancelled mitigation cannot be changed again (5.3 item 11)
  const err = (f: string) => errors.find((e) => e.field === f)?.message ?? null;
  const due = dueDateOf(value.due);
  const later = base !== null && due !== null && due > base.dueDate;
  const gate = saveGate(upload);
  const wait = [...upload.uploading, ...upload.failed];
  const id = (n: string) => `${idBase}-${n}`;

  if (conflict !== null) {
    return (
      <MitigationConflictView
        newer={conflict} mine={value} userId={p.userId} busy={busy} alert={alert === null ? null : { text: alert.text, name: alert.name }} status={status}
        onSaveMine={() => choose('save_mine', conflict)} onEditFirst={() => choose('edit_first', conflict)} onDiscard={() => choose('discard', conflict)}
      />
    );
  }

  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate aria-labelledby={id('h')}>
      <h3 id={id('h')}>{base === null ? 'Add a mitigation' : 'Update this mitigation'}</h3>
      <ErrorSummary summary={formSummary('mitigation', errors.length, kept)} errors={errors} focusKey={attempt} prefix={`${idBase}-`} />
      <fieldset>
        <legend>Status (required)</legend>
        {STATUSES.map((s) => (
          <label key={s}>
            <input type="radio" name={id('status')} value={s} checked={value.status === s} onChange={() => change({ status: s })} />{' '}
            <MitigationStatusWord status={s} plain />{' '}
          </label>
        ))}
      </fieldset>
      <Field id={id('ownerUserId')} label="Owner (required)" error={err('ownerUserId')} help="Only members who can update mitigations are listed (owners, admins, assessors)."
        render={(a) => (
          <select {...a} name="ownerUserId" value={value.ownerUserId} onChange={(e) => change({ ownerUserId: e.target.value })}>
            <option value="">Choose an owner</option>
            {p.owners.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
          </select>
        )} />
      <fieldset id={id('dueDate')} aria-describedby={err('dueDate') ? id('due-error') : undefined}>
        <legend>Due date (required)</legend>
        {([['day', 'Day', 2], ['month', 'Month', 2], ['year', 'Year', 4]] as const).map(([part, label, size]) => (
          <span key={part}>
            <label htmlFor={id(part)}>{label}</label>{' '}
            <input id={id(part)} name={part} type="text" inputMode="numeric" size={size + 1} maxLength={size} value={value.due[part]}
              aria-invalid={err('dueDate') ? true : undefined} onChange={(e) => change({ due: { ...value.due, [part]: e.target.value } })} />{' '}
          </span>
        ))}
        {err('dueDate') ? <p id={id('due-error')} className="form-error">{err('dueDate')}</p> : null}
      </fieldset>
      {later ? (
        <Field id={id('changeNote')} label="Why the date changed (required when the due date moves later)" error={err('changeNote')}
          render={(a) => <textarea {...a} name="changeNote" rows={2} value={value.changeNote} onChange={(e) => change({ changeNote: e.target.value })} />} />
      ) : null}
      <Field id={id('what')} label="What will be done" error={err('what')}
        render={(a) => <textarea {...a} name="what" rows={3} value={value.what} onChange={(e) => change({ what: e.target.value })} />} />
      <p className="text-muted">{characterCount(charCount(value.what), TEXT_MAX)}</p>
      <Field id={id('followsControl')} label="Follows a control (optional)" error={err('followsControl')}
        render={(a) => (
          <select {...a} name="followsControl" value={value.followsControl ?? ''} onChange={(e) => change({ followsControl: e.target.value === '' ? null : e.target.value })}>
            <option value="">No control</option>
            {p.controls.map((c) => <option key={c.id} value={c.id}>{c.id} {c.name}</option>)}
          </select>
        )} />
      {value.status === 'done' ? (
        <fieldset id={id('closureNote')} aria-describedby={err('closureNote') ? id('closure-error') : undefined}>
          <legend>Closure evidence (required for Done)</legend>
          <EvidenceBlock
            key={evidenceKey} orgSlug={p.orgSlug} projectId={p.projectId} initial={value.evidence} disabled={busy} notUploaded={notUploaded}
            onChange={() => {}} onItemsChange={(items) => { setValue((v) => (v.evidence.length === items.length && v.evidence.every((e, i) => e.id === items[i].id) ? v : { ...v, evidence: items })); }}
            onUploadState={(s) => { setUpload(s); }}
          />
          <label>
            <input type="checkbox" name="noArtefact" checked={value.noArtefact} onChange={(e) => change({ noArtefact: e.target.checked })} /> There is no artefact
          </label>
          {value.noArtefact ? (
            <Field id={id('closureNoteText')} label="Say why (required)" error={null}
              render={(a) => <textarea {...a} name="closureNote" rows={2} value={value.closureNote} onChange={(e) => change({ closureNote: e.target.value })} />} />
          ) : null}
          {err('closureNote') ? <p id={id('closure-error')} className="form-error">{err('closureNote')}</p> : null}
        </fieldset>
      ) : null}
      {value.status === 'cancelled' ? (
        <Field id={id('cancelReason')} label="Why it is cancelled (required)" error={err('cancelReason')}
          render={(a) => <textarea {...a} name="cancelReason" rows={2} value={value.cancelReason} onChange={(e) => change({ cancelReason: e.target.value })} />} />
      ) : null}
      {held && !gate.send ? (
        <div role="alert">
          <p>Waiting for {wait.map((n, i) => <span key={n + i}>{i > 0 ? ', ' : ''}<bdi>{n}</bdi></span>)} to finish uploading.</p>
          <button type="button" className="btn btn--secondary" onClick={() => save({ skipGate: true })}>Save without it</button>{' '}
          <button type="button" className="btn btn--secondary" onClick={() => setHeld(false)}>Cancel</button>
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn--primary" aria-disabled={busy ? true : undefined}>Save mitigation</button>
        {p.onClose ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={p.onClose}>Close</button> : null}
        {dirty ? <span>Draft on this device, not saved yet</span> : null}
      </div>
      {cannotKeep ? <p>This browser cannot keep drafts. Save before leaving this page.</p> : null}
      {alert === null ? null : (
        <p role="alert"><FailureText text={alert.text} name={alert.name} />{alert.retry ? <>{' '}<button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={() => save({ skipGate: upload.uploading.length + upload.failed.length > 0 })}>Retry</button></> : null}</p>
      )}
      <StatusLine>{status}</StatusLine>
    </form>
  );
}

/**
 * The button that opens the form ("Add a mitigation" or "Update this mitigation") and keeps the saved line after the form
 * closes. A draft on this device opens the form at once, so nothing typed is lost. Used by `FindingPageView`.
 */
export function MitigationFormToggle(p: MitigationFormProps & { label: 'Add a mitigation' | 'Update this mitigation' }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ReactNode>('');
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const draft = openDraftStore()?.read(
      mitigationDraftTarget({ userId: p.userId, orgId: p.orgId, projectId: p.projectId, findingId: p.findingId, mitigationId: p.base?.mitigationId ?? null }),
      new Date(),
    );
    // After the first paint, so server and client markup agree; a draft on this device opens the form (UX-26).
    if (draft) queueMicrotask(() => setOpen(true));
  }, [p.userId, p.orgId, p.projectId, p.findingId, p.base?.mitigationId]);
  if (p.base?.status === 'cancelled') return null;
  return (
    <div>
      {open ? (
        <MitigationForm {...p} onSaved={(t) => { setSaved(t); setOpen(false); }} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }} />
      ) : (
        <button type="button" ref={trigger} className="btn btn--secondary" onClick={() => setOpen(true)}>{p.label}</button>
      )}
      <StatusLine>{saved}</StatusLine>
    </div>
  );
}
