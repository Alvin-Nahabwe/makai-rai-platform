'use client';

import { useRouter } from 'next/navigation';
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Icon } from '@/components/ui/Icon';
import { FieldError as KitFieldError, FieldHint, FieldLabel } from '@/components/ui/TextInput';
import '@/components/ui/TextInput.css';
import '@/components/ui/TextArea.css';
import '@/components/ui/Select.css';
import './Findings.css';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { characterCount, KEPT_IN_FORM, reasonErrors, writeFailure, type WriteFailure } from '@/lib/findings/formRules';
import type { FieldError } from '@/types/record';

/**
 * One write of S-14 or S-15 from the browser (UX-25, UX-27): sends with `sendWrite`, keeps the request id of an unchanged
 * body for Retry and makes a new one when the body changed, reports "slow" after 10 seconds, and turns every outcome into
 * the failure text of `writeFailure`. `send` answers the saved reply, or `null` after it has set `failure`. A second press
 * while one is in flight does nothing. After a save the retry state is cleared, so the same action later (reopening again)
 * is a new request and not a replay of the first.
 */
export function useFindingWrite(url: string, kept: string): {
  phase: 'idle' | 'saving' | 'slow'; failure: WriteFailure | null;
  send: <T>(body: Record<string, unknown>) => Promise<{ status: number; body: T } | null>;
  clearFailure: () => void;
} {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'slow'>('idle');
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const busy = useRef(false);
  const send = useCallback(async <T,>(body: Record<string, unknown>) => {
    if (busy.current) return null;
    busy.current = true;
    setPhase('saving');
    setFailure(null);
    try {
      const next = requestIdFor(retry.current, body);
      retry.current = next.state;
      const outcome = await sendWrite<T>(url, 'POST', { requestId: next.requestId, ...body }, { onSlow: () => setPhase('slow') });
      const failed = writeFailure(outcome, kept);
      if (failed !== null || outcome.kind !== 'saved') {
        setFailure(failed);
        return null;
      }
      retry.current = { requestId: null, sentBody: null };
      return { status: outcome.status, body: outcome.body };
    } finally {
      busy.current = false;
      setPhase('idle');
    }
  }, [url, kept]);
  return { phase, failure, send, clearFailure: () => setFailure(null) };
}

/** A failure's sentence with the member's name inside <bdi> (a name can carry direction controls that would reorder the time after it). */
export function FailureText({ text, name }: { text: string; name?: string }): ReactElement {
  const at = name === undefined ? -1 : text.indexOf(name);
  if (name === undefined || at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<bdi>{name}</bdi>{text.slice(at + name.length)}</>;
}

/**
 * A polite live region that keeps its place in the page: the element is always there so the screen reader has registered
 * it, and it takes `role="status"` only while it holds text (so a page shows one status at a time).
 */
export function StatusLine({ children }: { children?: ReactNode }): ReactElement {
  const has = children !== undefined && children !== null && children !== false && children !== '';
  return <div aria-live="polite" role={has ? 'status' : undefined}>{has ? children : null}</div>;
}

/** The summary a failed Save shows and takes focus (WCAG 3.3.1; the forms guide: "Block and route focus"): one link per field. */
export function ErrorSummary({ summary, errors, focusKey, prefix = '' }: { summary: string; errors: readonly FieldError[]; focusKey: number; prefix?: string }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (errors.length > 0) ref.current?.focus(); }, [focusKey]);   // eslint-disable-line react-hooks/exhaustive-deps -- only a new Save press moves focus
  if (errors.length === 0) return null;
  return (
    <div role="alert" tabIndex={-1} ref={ref} className="form-error">
      <p>{summary}</p>
      <ul>{errors.map((e) => <li key={e.field}><a href={`#${prefix}${e.field}`}>{e.message}</a></li>)}</ul>
    </div>
  );
}

/**
 * A labelled control with its help and error linked by `aria-describedby` (the forms guide), drawn with the kit's field
 * parts (`div.ui-field`, `FieldLabel`, `FieldHint`, `FieldError`). It stays for the controls the kit's own fields cannot
 * carry with the same ids: the help's id is `<id>-help` (the kit's is `<id>-hint`), and the control is the caller's,
 * which wears the kit's class (`ui-input`, `ui-textarea`, `ui-select`).
 */
export function Field(p: {
  id: string; label: string; error?: string | null; help?: string;
  render: (a: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactElement;
  /** Shown after the control, before the error: a textarea's count. */
  after?: ReactNode;
}): ReactElement {
  const helpId = `${p.id}-help`;
  const errorId = `${p.id}-error`;
  const describedBy = [p.help ? helpId : null, p.error ? errorId : null].filter((x): x is string => x !== null).join(' ');
  return (
    <div className="ui-field">
      <FieldLabel htmlFor={p.id} label={p.label} />
      {p.help ? <FieldHint id={helpId}>{p.help}</FieldHint> : null}
      {p.render({ id: p.id, ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }), ...(p.error ? { 'aria-invalid': true as const } : {}) })}
      {p.after}
      {p.error ? <KitFieldError id={errorId} message={p.error} /> : null}
    </div>
  );
}

/** A native select in the kit's look: the wrap and the chevron of `components/ui/Select.tsx`, for a select `Field` labels. */
export function SelectBox({ children }: { children: ReactElement }): ReactElement {
  return (
    <div className="ui-select__wrap">
      {children}
      <span className="ui-select__icon"><Icon name="chevron-down" size={20} /></span>
    </div>
  );
}

export type FindingActionsProps = {
  orgSlug: string; projectId: string; findingId: string; findingTitle: string;
  /** The finding is closed by a mitigation or an accepted risk. */
  closed: boolean; withdrawn: boolean;
  canReopen: boolean; canWithdraw: boolean;
  /** M-26: shown where an action is absent for the role (UX-17); null where the role holds it. */
  cannotAccept: string | null; cannotReopen: string | null;
  /** The accepted-risk form (a client component), rendered here so it sits in "Other ways to close this finding". */
  acceptForm: ReactNode;
};

/**
 * "Other ways to close this finding" (W-5 note 6): the accept form, Withdraw for a team finding's raiser, owners and admins, and,
 * once the finding is closed, Reopen this finding. One client component keeps all three and the page's status, so
 * "Reopened." survives the refresh that turns the finding open again. Every control only asks: each write is re-checked by its route.
 */
export function FindingActions(p: FindingActionsProps): ReactElement {
  const router = useRouter();
  const base = `/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}`;
  const [message, setMessage] = useState<ReactNode>('');
  const [open, setOpen] = useState<'withdraw' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const withdrawTrigger = useRef<HTMLButtonElement>(null);
  const reopenTrigger = useRef<HTMLButtonElement>(null);
  const confirmWrap = useRef<HTMLDivElement>(null);
  const rid = `act-${useId().replace(/:/g, '')}`;
  const withdraw = useFindingWrite(`${base}/withdrawal`, KEPT_IN_FORM);
  const reopen = useFindingWrite(`${base}/reopen`, KEPT_IN_FORM);
  const w = open === 'reopen' ? reopen : withdraw;
  // The accept form reports its saved line here, so it survives the refresh that remounts the form behind its trigger (CR-1).
  const accept = isValidElement(p.acceptForm)
    ? cloneElement(p.acceptForm as ReactElement<{ onAccepted?: (t: ReactNode) => void }>, { onAccepted: (t: ReactNode) => setMessage(t) })
    : p.acceptForm;

  // Opening the confirmation puts focus on its action button (UX-42); Cancel puts it back on what opened it.
  useEffect(() => {
    if (open === 'withdraw') confirmWrap.current?.querySelector<HTMLButtonElement>('.ui-confirm__actions button:last-child')?.focus();
  }, [open]);
  const close = (back: React.RefObject<HTMLButtonElement | null>) => {
    setOpen(null); setReason(''); setErrors([]); w.clearFailure();
    requestAnimationFrame(() => back.current?.focus());
  };

  const submit = async (kind: 'withdraw' | 'reopen') => {
    const problems = reasonErrors(reason);
    setErrors(problems); setAttempt((n) => n + 1);
    if (problems.length > 0) return;
    const hook = kind === 'withdraw' ? withdraw : reopen;
    const sent = await hook.send({ reason: reason.trim(), eventCode: null });
    if (sent === null) return;
    setMessage(kind === 'withdraw' ? 'Withdrawn.' : 'Reopened.');
    setOpen(null); setReason('');
    router.refresh();
  };

  const reasonField = (
    <>
      <ErrorSummary summary="There is a problem with this reason. What you typed is kept." errors={errors} focusKey={attempt} prefix={`${rid}-`} />
      <Field
        id={`${rid}-reason`} label="Reason (required)" error={errors[0]?.message ?? w.failure?.fields.find((f) => f.field === 'reason')?.message ?? null}
        render={(a) => <textarea {...a} name="reason" rows={3} value={reason} onChange={(e) => { setReason(e.target.value); if (errors.length) setErrors([]); }} />}
      />
      <p className="text-muted" aria-live="off">{characterCount(Array.from(reason).length)}</p>
    </>
  );

  return (
    <div>
      {p.withdrawn ? null : p.closed ? (
        <>
        {accept}
        {p.canReopen ? (
          open === 'reopen' ? (
            <form method="post" onSubmit={(e) => { e.preventDefault(); void submit('reopen'); }} noValidate>
              <h3>Reopen this finding</h3>
              {reasonField}
              <div className="form-actions">
                <button type="submit" className="btn btn--primary" aria-disabled={reopen.phase !== 'idle' ? true : undefined}>Reopen finding</button>
                <button type="button" className="btn btn--secondary" onClick={() => close(reopenTrigger)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button type="button" ref={reopenTrigger} className="btn btn--secondary" onClick={() => setOpen('reopen')}>Reopen this finding</button>
          )
        ) : <p>{p.cannotReopen}</p>}
        </>
      ) : (
        <>
          {accept}
          {p.cannotAccept === null ? null : <p>{p.cannotAccept}</p>}
          {p.canWithdraw ? (
            open === 'withdraw' ? (
              <div ref={confirmWrap}>
                <InlineConfirm
                  objectName={`Finding: ${p.findingTitle}`} consequence="It stays listed as withdrawn and counts as neither open nor closed."
                  actionLabel="Withdraw finding" busy={withdraw.phase !== 'idle'}
                  onConfirm={() => submit('withdraw')} onCancel={() => close(withdrawTrigger)}
                >{reasonField}</InlineConfirm>
              </div>
            ) : (
              <button type="button" ref={withdrawTrigger} className="btn btn--secondary" onClick={() => setOpen('withdraw')}>Withdraw</button>
            )
          ) : null}
        </>
      )}
      {w.failure === null ? null : <p role="alert"><FailureText text={w.failure.text} name={w.failure.nameInText} /></p>}
      <StatusLine>{w.phase === 'saving' ? 'Saving...' : w.phase === 'slow' ? 'Still saving. The connection is slow.' : message}</StatusLine>
    </div>
  );
}
