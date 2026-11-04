'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { ErrorSummary, Field, StatusLine } from '@/components/findings/FindingActions';
import { LocalTime } from '@/components/findings/LocalTime';
import { openDraftStore, type DraftKey, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import {
  characterCount, charCount, dueDateOf, emptyMitigationValue, KEPT_IN_FORM, KEPT_ON_DEVICE, mitigationFormErrors, mitigationRequestBody,
  mitigationSavedText, saveGate, TEXT_MAX, valueOf, writeFailure, type MitigationFormValue,
} from '@/lib/findings/formRules';
import { formatTime } from '@/lib/format/dates';
import type { FieldError, MitigationStatus } from '@/types/record';
import type { MitigationVersionView, UserRef } from '@/types/api';

export type MitigationFormProps = {
  orgSlug: string; projectId: string; findingId: string; base: MitigationVersionView | null;
  owners: UserRef[]; controls: ReadonlyArray<{ id: string; name: string }>; userId: string; orgId: string;
  /** Called after a save, so the toggle that holds the form can close it. */
  onSaved?: (text: string) => void;
  onClose?: () => void;
};

/**
 * A mitigation's status word (7.5.6): "Planned", "In progress", "Done", "Cancelled", and "Done, no artefact: <note>" for a done
 * version with no evidence (`noArtefactNote`). This is the one place the words are written: the mitigation form's radios use it
 * too (`plain`: no `status-label` class, because a radio's label is not a status shown in a list). They sit inside the element
 * that carries `data-claims-allowed` because the claims lint (FR-PUB-01) flags "progress" in any form, and this is a status
 * word of one mitigation of the team, not a statement about the platform or a stage.
 */
export function MitigationStatusWord({ status, noArtefactNote = null, plain = false }: { status: MitigationStatus; noArtefactNote?: string | null; plain?: boolean }): ReactElement {
  return (
    <span className={plain ? undefined : 'status-label'} data-claims-allowed="A mitigation's status word from 7.5.6; it describes one mitigation of the team, not the platform or a stage.">
      {status === 'planned' ? 'Planned'
        : status === 'in_progress' ? 'In progress'
        : status === 'cancelled' ? 'Cancelled'
        : noArtefactNote !== null ? <>Done, no artefact: <bdi>{noArtefactNote}</bdi></> : 'Done'}
    </span>
  );
}

/** The shape of a stored form value (a draft written by another build or by hand is not trusted). */
function isFormValue(v: unknown): v is MitigationFormValue {
  const o = v as Partial<MitigationFormValue> | null;
  return typeof o === 'object' && o !== null && typeof o.what === 'string' && typeof o.ownerUserId === 'string'
    && typeof o.due === 'object' && o.due !== null && typeof o.due.day === 'string' && typeof o.due.month === 'string' && typeof o.due.year === 'string'
    && (STATUSES as readonly unknown[]).includes(o.status) && Array.isArray(o.evidence) && Array.isArray(o.uploading)
    && typeof o.noArtefact === 'boolean' && typeof o.closureNote === 'string' && typeof o.cancelReason === 'string' && typeof o.changeNote === 'string';
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
  const [status, setStatus] = useState('');
  const [alert, setAlert] = useState<{ text: string; retry: boolean } | null>(null);
  const [conflict, setConflict] = useState<MitigationVersionView | null>(null);
  const [upload, setUpload] = useState<{ uploading: string[]; failed: string[] }>({ uploading: [], failed: [] });
  const [held, setHeld] = useState(false);
  const [notUploaded, setNotUploaded] = useState<string[]>([]);
  const [cannotKeep, setCannotKeep] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [evidenceKey, setEvidenceKey] = useState(0);
  const store = useRef<DraftStore | null>(null);
  const retry = useRef<RetryState>(NO_RETRY);
  const savePressedAt = useRef<string | null>(null);
  const restored = useRef(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const key: DraftKey = useMemo(() => ({
    userId: p.userId, orgId: p.orgId, projectId: p.projectId,
    target: { kind: 'mitigation', findingId: p.findingId, mitigationId: p.base?.mitigationId ?? null },
  }), [p.userId, p.orgId, p.projectId, p.findingId, p.base?.mitigationId]);

  // On mount only: open the browser's draft store and restore this form's draft, if any (UX-26). A draft that started from
  // another version than the current one shows the conflict at once.
  useEffect(() => {
    if (mounted.current) return;   // a refresh gives `base` a new identity; the draft is read once
    mounted.current = true;
    store.current = openDraftStore();
    if (store.current === null) { setCannotKeep(true); restored.current = true; return; }
    const draft = store.current.read<MitigationFormValue>(key, new Date());
    // A draft whose value is not a form value is dropped, not rendered (it would crash the section for seven days).
    if (draft !== null && !isFormValue(draft.value)) store.current.remove(key);
    else if (draft !== null) {
      setValue(draft.value); setDirty(true); setNotUploaded(draft.value.uploading);
      retry.current = draft.retry; savePressedAt.current = draft.savePressedAt;
      if (draft.baseVersionNumber !== (p.base?.versionNumber ?? null) && p.base !== null) setConflict(p.base);
    }
    restored.current = true;
  }, [key, p.base]);

  // Every change is written (UX-26). A refused write is said in words.
  useEffect(() => {
    if (!restored.current || !dirty || store.current === null) return;
    const kept = store.current.write(key, {
      baseVersionNumber: base?.versionNumber ?? null, value: { ...value, uploading: [...upload.uploading, ...upload.failed] },
      savedAt: new Date().toISOString(), savePressedAt: savePressedAt.current, retry: retry.current,
    });
    setCannotKeep(!kept);
  }, [value, dirty, key, base, upload]);

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
        setCannotKeep(!store.current.write(key, { baseVersionNumber: base?.versionNumber ?? null, value: { ...value, uploading: [...upload.uploading, ...upload.failed] },
          savedAt: new Date().toISOString(), savePressedAt: savePressedAt.current, retry: retry.current }));
      }
      const url = `/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}/mitigations${usingBase === null ? '' : `/${encodeURIComponent(usingBase.mitigationId)}`}`;
      const outcome = await sendWrite<MitigationVersionView>(url, 'POST', { requestId: next.requestId, ...body }, {
        onSlow: () => setStatus(`Still saving. The connection is slow. ${kept}`),
      });
      const failed = writeFailure(outcome, kept);
      if (failed === null && outcome.kind === 'saved') {
        store.current?.remove(key); retry.current = NO_RETRY; savePressedAt.current = null;
        const at = formatTime(outcome.body.receivedAt);
        const text = outcome.status === 200
          ? `Already saved as version ${outcome.body.versionNumber} of this mitigation at ${at}.`
          : mitigationSavedText(outcome.body, at);
        setDirty(false); setConflict(null); setHeld(false); setValue(emptyMitigationValue(null)); setEvidenceKey((n) => n + 1);
        setStatus(left.length === 0 ? text : `${text} Not attached: ${left.join(', ')}.`);
        p.onSaved?.(left.length === 0 ? text : `${text} Not attached: ${left.join(', ')}.`);
        router.refresh();
        return;
      }
      setStatus('');
      if (failed?.conflict?.code === 'base_version_moved') {
        setConflict(failed.conflict.current as MitigationVersionView);
      } else if (failed !== null && failed.fields.length > 0) {
        setConflict(null); setErrors(failed.fields); setAttempt((n) => n + 1);
      } else if (failed !== null) {
        setAlert({ text: failed.text, retry: failed.retry });
      }
    } catch (e) {
      // A fault in this page's own code after a reply: the person must not be left on "Saving...".
      setStatus('');
      setAlert({ text: `The reply could not be shown. Reload this page to see whether it saved. ${kept}`, retry: false });
      throw e;
    } finally {
      inFlight.current = false; setBusy(false);
    }
  };

  /** "Save mine as version N": the fields are checked against the newer version first; a problem returns to the form with its summary. */
  const saveOnto = (newer: MitigationVersionView) => {
    const problems = mitigationFormErrors(value, newer);
    setBase(newer);
    if (problems.length > 0) { setErrors(problems); setAttempt((n) => n + 1); setConflict(null); return; }
    void post(mitigationRequestBody(value, newer), base, [...upload.uploading, ...upload.failed]);
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
    const same = conflict.enteredBy.userId === p.userId;
    return (
      <section aria-labelledby={id('conflict')} className="card">
        <h3 id={id('conflict')} tabIndex={-1} ref={(el) => el?.focus()}>Someone saved a newer version of this mitigation</h3>
        <p role="alert">
          Version {conflict.versionNumber} was saved by {same ? 'you' : <bdi>{conflict.enteredBy.name}</bdi>} at <LocalTime at={conflict.receivedAt} />
          {same ? ', probably by an earlier attempt from this device or another device' : ' after you started'}. Review it, then save yours as version {conflict.versionNumber + 1} or discard it.
        </p>
        <p>The newer version: <bdi>{conflict.what}</bdi>, owner <bdi>{conflict.owner.name}</bdi>, due {conflict.dueDate}.</p>
        <p>Yours: <bdi>{value.what}</bdi>, due {value.due.day}/{value.due.month}/{value.due.year}.</p>
        <div className="form-actions">
          <button type="button" className="btn btn--primary" disabled={busy}
            onClick={() => saveOnto(conflict)}>Save mine as version {conflict.versionNumber + 1}</button>
          <button type="button" className="btn btn--secondary" onClick={() => { setBase(conflict); setConflict(null); setDirty(true); }}>Edit mine first</button>
          <button type="button" className="btn btn--secondary" onClick={() => { store.current?.remove(key); retry.current = NO_RETRY; setDirty(false); setBase(conflict); setValue(valueOf(conflict)); setConflict(null); setEvidenceKey((n) => n + 1); }}>Discard mine</button>
        </div>
        {alert === null ? null : <p role="alert">{alert.text}</p>}
        <StatusLine>{status}</StatusLine>
      </section>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} noValidate aria-labelledby={id('h')}>
      <h3 id={id('h')}>{base === null ? 'Add a mitigation' : 'Update this mitigation'}</h3>
      <ErrorSummary summary={errors.length === 1 ? 'There is a problem with this mitigation. Your answer is kept on this device.' : `There are ${errors.length} problems with this mitigation. Your answer is kept on this device.`} errors={errors} focusKey={attempt} />
      <fieldset>
        <legend>Status (required)</legend>
        {STATUSES.map((s) => (
          <label key={s}>
            <input type="radio" name={id('status')} value={s} checked={value.status === s} onChange={() => change({ status: s })} />{' '}
            <MitigationStatusWord status={s} plain />{' '}
          </label>
        ))}
      </fieldset>
      <Field id="ownerUserId" label="Owner (required)" error={err('ownerUserId')} help="Only members who can update mitigations are listed (owners, admins, assessors)."
        render={(a) => (
          <select {...a} name="ownerUserId" value={value.ownerUserId} onChange={(e) => change({ ownerUserId: e.target.value })}>
            <option value="">Choose an owner</option>
            {p.owners.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
          </select>
        )} />
      <fieldset id="dueDate" aria-describedby={err('dueDate') ? id('due-error') : undefined}>
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
        <Field id="changeNote" label="Why the date changed (required when the due date moves later)" error={err('changeNote')}
          render={(a) => <textarea {...a} name="changeNote" rows={2} value={value.changeNote} onChange={(e) => change({ changeNote: e.target.value })} />} />
      ) : null}
      <Field id="what" label="What will be done" error={err('what')}
        render={(a) => <textarea {...a} name="what" rows={3} value={value.what} onChange={(e) => change({ what: e.target.value })} />} />
      <p className="text-muted">{characterCount(charCount(value.what), TEXT_MAX)}</p>
      <Field id="followsControl" label="Follows a control (optional)" error={err('followsControl')}
        render={(a) => (
          <select {...a} name="followsControl" value={value.followsControl ?? ''} onChange={(e) => change({ followsControl: e.target.value === '' ? null : e.target.value })}>
            <option value="">No control</option>
            {p.controls.map((c) => <option key={c.id} value={c.id}>{c.id} {c.name}</option>)}
          </select>
        )} />
      {value.status === 'done' ? (
        <fieldset id="closureNote" aria-describedby={err('closureNote') ? id('closure-error') : undefined}>
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
            <Field id="closureNoteText" label="Say why (required)" error={null}
              render={(a) => <textarea {...a} name="closureNote" rows={2} value={value.closureNote} onChange={(e) => change({ closureNote: e.target.value })} />} />
          ) : null}
          {err('closureNote') ? <p id={id('closure-error')} className="form-error">{err('closureNote')}</p> : null}
        </fieldset>
      ) : null}
      {value.status === 'cancelled' ? (
        <Field id="cancelReason" label="Why it is cancelled (required)" error={err('cancelReason')}
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
        <button type="submit" className="btn btn--primary" disabled={busy}>Save mitigation</button>
        {p.onClose ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={p.onClose}>Close</button> : null}
        {dirty ? <span>Draft on this device, not saved yet</span> : null}
      </div>
      {cannotKeep ? <p>This browser cannot keep drafts. Save before leaving this page.</p> : null}
      {alert === null ? null : (
        <p role="alert">{alert.text}{alert.retry ? <>{' '}<button type="button" className="btn btn--secondary btn--small" disabled={busy} onClick={() => save({ skipGate: upload.uploading.length + upload.failed.length > 0 })}>Retry</button></> : null}</p>
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
  const [saved, setSaved] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const draft = openDraftStore()?.read(
      { userId: p.userId, orgId: p.orgId, projectId: p.projectId, target: { kind: 'mitigation', findingId: p.findingId, mitigationId: p.base?.mitigationId ?? null } } satisfies DraftKey,
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
