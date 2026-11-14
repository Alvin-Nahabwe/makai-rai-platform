'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { DateBoxes, ErrorSummary, FailureText, Field, SelectBox, StatusLine } from '@/components/findings/FindingActions';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { LocalTime } from '@/components/ui/LocalTime';
import { Select } from '@/components/ui/Select';
import { FieldError as KitFieldError } from '@/components/ui/TextInput';
import { FINDINGS_COPY } from '@/lib/findings/copy';
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
import './Findings.css';

const MF = FINDINGS_COPY.mitigationForm;

export type MitigationFormProps = {
  orgSlug: string; projectId: string; findingId: string; base: MitigationVersionView | null;
  owners: UserRef[]; controls: ReadonlyArray<{ id: string; name: string }>; userId: string; orgId: string;
  /** Called after a save, so the toggle that holds the form can close it. */
  onSaved?: (text: ReactNode) => void;
  onClose?: () => void;
};

/**
 * A mitigation's status word (7.5.6): "Planned", "In progress", "Done", "Cancelled", and "Done, nothing attached: <note>" for a done
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
        : noArtefactNote !== null ? <>{MF.doneNothingAttached} <bdi>{noArtefactNote}</bdi></> : 'Done'}
    </span>
  );
}

/** "Not attached: a.pdf, b.pdf." with each file name inside <bdi>, so a name with direction controls cannot reorder the sentence (UX-30). */
export function NotAttached({ names }: { names: readonly string[] }): ReactElement {
  return <>{MF.notAttached} {names.map((n, i) => <span key={i}>{i > 0 ? ', ' : ''}<bdi>{n}</bdi></span>)}.</>;
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
    <section aria-labelledby={headingId} className="finding-form">
      <h3 id={headingId} tabIndex={-1} ref={headingRef}>{MF.conflictHeading}</h3>
      <p role="alert">
        {same
          ? <>{`${MF.conflictYouSaved(p.newer.versionNumber)} `}<LocalTime at={p.newer.receivedAt} />{MF.conflictYouRest(p.newer.versionNumber + 1)}</>
          : <><bdi>{p.newer.enteredBy.name}</bdi>{` ${MF.conflictOtherSaved(p.newer.versionNumber)} `}<LocalTime at={p.newer.receivedAt} />{MF.conflictOtherRest(p.newer.versionNumber + 1)}</>}
      </p>
      <p>{MF.newerVersion} {p.newer.what === null ? null : <><bdi>{p.newer.what}</bdi>, </>}{MF.assignedTo} <bdi>{p.newer.owner.name}</bdi>{MF.dueClause(formatDay(p.newer.dueDate))}</p>
      <p>{MF.yours} <bdi>{p.mine.what}</bdi>{mineDue === null ? '' : MF.yoursDue(formatDay(mineDue))}.</p>
      <div className="finding-actions">
        <Button variant="primary" busy={p.busy} onClick={p.onSaveMine}>{MF.saveMine}</Button>
        <Button variant="secondary" onClick={p.onEditFirst}>{MF.editMine}</Button>
        <Button variant="secondary" onClick={p.onDiscard}>{MF.discardMine}</Button>
      </div>
      {p.alert === null ? null : <p role="alert" className="finding-alert"><FailureText text={p.alert.text} name={p.alert.name} /></p>}
      <StatusLine>{p.status}</StatusLine>
    </section>
  );
}

const STATUSES: readonly MitigationStatus[] = ['planned', 'in_progress', 'done', 'cancelled'];
/** A textarea in the kit's class, with the kit's invalid border while its field has an error. */
const textareaClass = (error: string | null): string => (error ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea');
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
  // Each answer's text is a new node (B2), so a Retry that fails the same way is announced again.
  const [answers, setAnswers] = useState(0);
  // A Retry answered by a refusal Retry cannot fix removes the focused Retry: focus goes to the alert (B1, ruling L5-4).
  const [focusAlert, setFocusAlert] = useState(0);
  const alertBox = useRef<HTMLParagraphElement>(null);
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

  useEffect(() => {
    if (focusAlert > 0) alertBox.current?.focus();
  }, [focusAlert]);

  const change = useCallback((patch: Partial<MitigationFormValue>) => {
    setValue((v) => ({ ...v, ...patch })); setDirty(true); setErrors([]); setHeld(false);
  }, []);

  const kept = cannotKeep ? KEPT_IN_FORM : KEPT_ON_DEVICE;
  /**
   * Sends route 6 or 7. A Retry keeps the alert, and so the Retry button itself, mounted while its own request is in
   * flight (busy, with its focus), until the answer replaces the alert or, on a save, removes it (ruling X-4). While a
   * Retry is in flight the alert says "Saving..." in place of the failure it answers, so no stale "Not saved" line sits
   * on the page (B2); the answer is a new text node, so the same failure again is announced again.
   */
  const post = async (body: Record<string, unknown>, usingBase: MitigationVersionView | null, left: string[], retrying = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    if (retrying) { setAlert({ text: MF.saving, retry: true }); setAnswers((n) => n + 1); } else { setAlert(null); setStatus(MF.saving); }
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
        onSlow: () => (retrying ? setAlert({ text: MF.slow(kept), retry: true }) : setStatus(MF.slow(kept))),
      });
      const failed = writeFailure(outcome, kept);
      if (failed === null && outcome.kind === 'saved') {
        store.current?.remove(key); retry.current = NO_RETRY; savePressedAt.current = null;
        const line = savedLine(mitigationSavedText(outcome.body, formatTime(outcome.body.receivedAt)), left);
        setDirty(false); setConflict(null); setHeld(false); setAlert(null); setValue(emptyMitigationValue(null)); setEvidenceKey((n) => n + 1);
        setStatus(line);
        p.onSaved?.(line);
        router.refresh();
        return;
      }
      setStatus('');
      if (retrying) setAlert(null);   // the answer to a Retry replaces the alert it was pressed in
      if (failed?.conflict?.code === 'base_version_moved' && isNewerVersion(failed.conflict.current)) {
        setConflict(failed.conflict.current);
      } else if (failed?.conflict?.code === 'base_version_moved') {
        setAlert({ text: MF.newerFirst, retry: false }); setAnswers((n) => n + 1);
        if (retrying) setFocusAlert((n) => n + 1);
      } else if (failed !== null && failed.fields.length > 0) {
        setConflict(null); setErrors(failed.fields); setAttempt((n) => n + 1);
      } else if (failed !== null) {
        setAlert({ text: failed.text, retry: failed.retry, name: failed.nameInText }); setAnswers((n) => n + 1);
        if (retrying && !failed.retry) setFocusAlert((n) => n + 1);
      }
    } catch (e) {
      // A fault in this page's own code after a reply: the person must not be left on "Saving...".
      setStatus('');
      setAlert({ text: MF.replyNotShown(kept), retry: false }); setAnswers((n) => n + 1);
      if (retrying) setFocusAlert((n) => n + 1);
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

  const save = (opts: { skipGate?: boolean; retrying?: boolean } = {}) => {
    if (inFlight.current) return;   // a press while a send is in flight changes nothing
    savePressedAt.current = new Date().toISOString();
    const problems = mitigationFormErrors(value, base);
    setErrors(problems); setAttempt((n) => n + 1);
    if (problems.length > 0) return;
    const gate = saveGate(upload);
    if (!gate.send && opts.skipGate !== true) { setHeld(true); return; }
    setHeld(false);
    void post(mitigationRequestBody(value, base), base, opts.skipGate === true ? [...upload.uploading, ...upload.failed] : [], opts.retrying === true);
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
    <form method="post" className="finding-form" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate aria-labelledby={id('h')}>
      <h3 id={id('h')}>{base === null ? MF.addHeading : MF.updateHeading}</h3>
      <ErrorSummary summary={formSummary('mitigation', errors.length, kept)} errors={errors} focusKey={attempt} prefix={`${idBase}-`} />
      <fieldset className="finding-radios">
        <legend>{MF.status}</legend>
        {STATUSES.map((s) => (
          <label key={s} className="finding-radio">
            <input type="radio" name={id('status')} value={s} checked={value.status === s} onChange={() => change({ status: s })} />
            <MitigationStatusWord status={s} plain />
          </label>
        ))}
      </fieldset>
      <Field id={id('ownerUserId')} label={MF.assignedLabel} error={err('ownerUserId')} help={MF.assignedHelp}
        render={(a) => (
          <SelectBox>
            <select {...a} className={err('ownerUserId') ? 'ui-select ui-select--invalid' : 'ui-select'} name="ownerUserId" value={value.ownerUserId} onChange={(e) => change({ ownerUserId: e.target.value })}>
              <option value="">{MF.chooseAssigned}</option>
              {p.owners.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
            </select>
          </SelectBox>
        )} />
      <DateBoxes id={id('dueDate')} boxId={(part) => id(part)} legend={MF.dueLegend} value={value.due}
        onChange={(part, v) => change({ due: { ...value.due, [part]: v } })} error={err('dueDate')} errorId={id('due-error')} />
      {later ? (
        <Field id={id('changeNote')} label={MF.changeNote} error={err('changeNote')}
          render={(a) => <textarea {...a} className={textareaClass(err('changeNote'))} name="changeNote" rows={2} value={value.changeNote} onChange={(e) => change({ changeNote: e.target.value })} />} />
      ) : null}
      <Field id={id('what')} label={MF.what} error={err('what')}
        render={(a) => <textarea {...a} className={textareaClass(err('what'))} name="what" rows={3} value={value.what} onChange={(e) => change({ what: e.target.value })} />}
        after={<p className="ui-count">{characterCount(charCount(value.what), TEXT_MAX)}</p>} />
      <Select id={id('followsControl')} name="followsControl" label={MF.follows} error={err('followsControl') ?? undefined} value={value.followsControl ?? ''}
        placeholder={MF.noControl} options={p.controls.map((c) => ({ value: c.id, label: FINDINGS_COPY.finding.namedId(c.name, c.id) }))}
        onChange={(e) => change({ followsControl: e.target.value === '' ? null : e.target.value })} />
      {value.status === 'done' ? (
        <fieldset id={id('closureNote')} aria-describedby={err('closureNote') ? id('closure-error') : undefined}>
          <legend>{MF.evidenceLegend}</legend>
          <EvidenceBlock
            key={evidenceKey} orgSlug={p.orgSlug} projectId={p.projectId} initial={value.evidence} disabled={busy} notUploaded={notUploaded}
            onChange={() => {}} onItemsChange={(items) => { setValue((v) => (v.evidence.length === items.length && v.evidence.every((e, i) => e.id === items[i].id) ? v : { ...v, evidence: items })); }}
            onUploadState={(s) => { setUpload(s); }}
          />
          <Checkbox id={id('noArtefact')} name="noArtefact" label={MF.noArtefact} checked={value.noArtefact} onChange={(e) => change({ noArtefact: e.target.checked })} />
          {value.noArtefact ? (
            <Field id={id('closureNoteText')} label={MF.noArtefactWhy} error={null}
              render={(a) => <textarea {...a} className="ui-textarea" name="closureNote" rows={2} value={value.closureNote} onChange={(e) => change({ closureNote: e.target.value })} />} />
          ) : null}
          {err('closureNote') ? <KitFieldError id={id('closure-error')} message={err('closureNote') as string} /> : null}
        </fieldset>
      ) : null}
      {value.status === 'cancelled' ? (
        <Field id={id('cancelReason')} label={MF.cancelReason} error={err('cancelReason')}
          render={(a) => <textarea {...a} className={textareaClass(err('cancelReason'))} name="cancelReason" rows={2} value={value.cancelReason} onChange={(e) => change({ cancelReason: e.target.value })} />} />
      ) : null}
      {held && !gate.send ? (
        <div role="alert" className="finding-held">
          <p>{MF.waitingFor} {wait.map((n, i) => <span key={n + i}>{i > 0 ? ', ' : ''}<bdi>{n}</bdi></span>)} {MF.toFinishUploading}</p>
          <div className="finding-actions">
            <Button variant="secondary" onClick={() => save({ skipGate: true })}>{MF.saveWithout}</Button>
            <Button variant="secondary" onClick={() => setHeld(false)}>{MF.cancel}</Button>
          </div>
        </div>
      ) : null}
      <div className="finding-actions">
        <Button variant="primary" type="submit" busy={busy}>{MF.save}</Button>
        {p.onClose ? <Button variant="secondary" disabled={busy} onClick={p.onClose}>{MF.close}</Button> : null}
        {dirty ? <span className="finding-unsaved">{MF.unsaved}</span> : null}
      </div>
      {cannotKeep ? <p>{MF.cannotKeep}</p> : null}
      {alert === null ? null : (
        <p role="alert" className="finding-alert" ref={alertBox} tabIndex={-1}>
          <span key={answers}><FailureText text={alert.text} name={alert.name} /></span>
          {alert.retry ? <>{' '}<Button variant="secondary" size="compact" busy={busy} onClick={() => save({ skipGate: upload.uploading.length + upload.failed.length > 0, retrying: true })}>{MF.retry}</Button></> : null}
        </p>
      )}
      <StatusLine>{status}</StatusLine>
    </form>
  );
}

/**
 * The button that opens the form ("Add a mitigation" or "Update this mitigation") and keeps the saved line after the form
 * closes. A draft in this browser opens the form at once, so nothing typed is lost. Used by `FindingPageView`.
 * The form replaces the button, so a press puts focus on the form's first field, the chosen status (ruling X-4: focus
 * is never left on the page body); Close, and a save, put it back on the button (B1, ruling L5-4). A save can also remove
 * the button: Done closes the finding and Cancelled ends the card, and the refresh then renders no toggle. When the button
 * leaves the page while it holds focus (and not because it was pressed to open the form), focus goes to the element whose
 * id is `leaveFocusTo`, the page's mitigations heading, so it never falls to the page body.
 */
export function MitigationFormToggle(p: MitigationFormProps & { label: 'Add a mitigation' | 'Update this mitigation'; leaveFocusTo?: string }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ReactNode>('');
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const leaveFocusTo = p.leaveFocusTo;
  // The ref's cleanup runs while the button is still in the document, so `document.activeElement` still says whether it
  // held focus. The move waits for the end of that commit (a microtask, not a timer): only a button that really left the
  // document, with focus fallen to the body, moves it. Strict Mode's extra cleanup in development leaves the button in
  // place, and a person who has already moved on keeps their focus.
  const triggerRef = useCallback((el: HTMLButtonElement | null) => {
    trigger.current = el;
    if (el === null) return undefined;
    return () => {
      if (trigger.current === el) trigger.current = null;
      if (pressed.current || leaveFocusTo === undefined || document.activeElement !== el) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        if (!el.isConnected && (now === null || now === document.body)) document.getElementById(leaveFocusTo)?.focus();
      });
    };
  }, [leaveFocusTo]);
  // A save answers outside any event, so React may render the button after the next frame: focus goes to it in an
  // effect, once it is there (B1, ruling L5-4). A frame callback found no button on a production build, two runs in three.
  const [savedCount, setSavedCount] = useState(0);
  useEffect(() => {
    if (savedCount > 0) trigger.current?.focus();
  }, [savedCount]);
  useEffect(() => {
    if (!open || !pressed.current) return;
    pressed.current = false;
    const form = box.current;
    (form?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? form?.querySelector<HTMLElement>('input, select, textarea'))?.focus();
  }, [open]);
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
    <div ref={box}>
      {open ? (
        <MitigationForm {...p} onSaved={(t) => { setSaved(t); setOpen(false); setSavedCount((n) => n + 1); }} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }} />
      ) : (
        <Button variant="secondary" ref={triggerRef} onClick={() => { pressed.current = true; setOpen(true); }}>{p.label}</Button>
      )}
      <StatusLine>{saved}</StatusLine>
    </div>
  );
}
