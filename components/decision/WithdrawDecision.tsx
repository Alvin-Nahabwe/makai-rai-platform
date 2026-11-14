'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Select } from '@/components/ui/Select';
import { FieldError as FieldErrorText, FieldLabel } from '@/components/ui/TextInput';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { REQUEST_MESSAGES, WITHDRAW_COPY, WITHDRAWAL_CODE_LABELS, WITHDRAWAL_CODES } from '@/lib/decision/copy';
import { reasonFieldError } from '@/lib/decision/rules';
import { WITHDRAW_TEXT, withdrawOutcome } from '@/lib/question/saveOutcome';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError, Stage, WithdrawalCode } from '@/types/record';
import './WithdrawDecision.css';
import '@/components/ui/textAreaStyles';
import '@/components/ui/buttonStyles';

export type WithdrawDecisionProps = {
  orgSlug: string; projectId: string; stage: Stage; questionId: string; current: DecisionVersionView; canWithdraw: boolean;
  /** S-12 holds the control in its "More" menu; S-13 shows it as it is. */
  inMoreMenu?: boolean;
};

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
/** The ids of the confirmation's two fields: the kit's Select takes no ref, so it is focused by its id. */
const CODE_ID = 'withdraw-code';
const REASON_ID = 'withdraw-reason';
const FIELD_ID: Readonly<Record<string, string>> = { withdrawalCode: CODE_ID, reason: REASON_ID };

/**
 * Withdraw this decision (FR-DEC-08, UX-29, UX-42), on S-12 and S-13: a new version with status "withdrawn", through
 * route 2. The inline confirmation names the question and the consequence, its button repeats the action, and it holds
 * what kind of mistake it was and the explanation, both required. Focus moves to its first field when it opens and back
 * to the trigger on Cancel. A pressed Retry stays, busy and focused, while its own request is out; after a failure that
 * can be retried focus is on Retry, after one that cannot it is on the control, and after a withdrawal on the result line
 * (register D-398 item 4). Nothing is shown when the person may not withdraw this version (an assessor may withdraw only a version
 * they entered; owners and admins any): the server refuses anyway (DEC-a obligation D3). The status is said in this
 * component's own `role="status"`; failures in `role="alert"`.
 */
export function WithdrawDecision(p: WithdrawDecisionProps): ReactElement | null {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<WithdrawalCode | ''>('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  // A refusal by the identity gate (new terms, a password to change) links to where it is passed, as the save path does.
  const [action, setAction] = useState<{ label: string; href: string } | null>(null);
  const [retry, setRetry] = useState<RetryState>(NO_RETRY);
  const [canRetry, setCanRetry] = useState(false);
  // True from a press of Retry until its answer: the Retry stays mounted, busy, so focus stays on it.
  const [retrying, setRetrying] = useState(false);
  const [seenCurrentId, setSeenCurrentId] = useState(p.current.id);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const result = useRef<HTMLParagraphElement | null>(null);
  const retryButton = useRef<HTMLButtonElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  // Set when an answer arrives that leaves a failure: focus then goes to Retry, or to the control when there is none.
  const afterFailure = useRef(false);
  // Set when a press is refused with field errors (the browser's own check or a 422): the first field in error takes focus.
  const focusError = useRef(false);

  useEffect(() => {
    // The kit's Select takes no ref: its first field is found by its id.
    if (open) document.getElementById(CODE_ID)?.focus();
    else if (wasOpen.current) {
      trigger.current?.focus();
      // At narrow widths closing the confirmation fixes the save bar again and the page above shrinks, which can leave the
      // trigger that took focus above the viewport (measured at 320 by 568): after that layout, bring it into view
      // (instant: html has smooth scrolling), above the bar by the page's scroll padding.
      const back = trigger.current;
      requestAnimationFrame(() => { if (document.activeElement === back) back?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); });
    }
    wasOpen.current = open;
  }, [open]);

  // After a withdrawal the control is gone (the question has no decision left to withdraw), so focus, which was in the
  // confirmation, moves to the result line instead of falling to the page (F12): once when the reply comes (after the
  // effect above has returned focus to the trigger), and again when the refresh brings the withdrawn version and the
  // line is the only thing left. Declared after that effect so it runs after it.
  useEffect(() => {
    if (status === WITHDRAW_TEXT.withdrawn) result.current?.focus();
  }, [status, p.current.id]);

  // Focus is moved only from inside this control or from the page body: a person who went back to the decision form while
  // the withdrawal was out keeps their place (a Retry that takes focus from a field would re-send on the next Space).
  useEffect(() => {
    if (!afterFailure.current) return;
    afterFailure.current = false;
    const active = document.activeElement;
    const onBody = active === null || active === document.body;
    if (!onBody && !(container.current?.contains(active) ?? false)) return;
    if (retryButton.current !== null) retryButton.current.focus();
    else if (onBody) container.current?.focus();
  });

  // A refused press says so where the person is: the first field in error takes focus (WCAG 3.3.1, 4.1.3), from inside
  // this control or from the body only. An error on a field the confirmation does not show leaves focus to the effect above.
  useEffect(() => {
    if (!focusError.current) return;
    focusError.current = false;
    const id = errors.length === 0 ? undefined : FIELD_ID[errors[0].field];
    const active = document.activeElement;
    const fromHere = active === null || active === document.body || (container.current?.contains(active) ?? false);
    if (id !== undefined && fromHere) document.getElementById(id)?.focus();
  });

  // A later version that is not a withdrawal (a new decision saved after one) makes the last result stale.
  if (p.current.id !== seenCurrentId) {
    setSeenCurrentId(p.current.id);
    if (p.current.status !== 'withdrawn') { setStatus(''); setFailure(''); setAction(null); setCanRetry(false); }
  }

  if (!p.canWithdraw || p.current.status === 'withdrawn') {
    return status === '' ? null : <p role="status" data-withdraw-status tabIndex={-1} ref={result}>{status}</p>;
  }
  const err = (f: string) => errors.find((e) => e.field === f);

  async function confirm(): Promise<void> {
    const fields: FieldError[] = [];
    if (code === '' || !WITHDRAWAL_CODES.includes(code)) fields.push({ field: 'withdrawalCode', message: REQUEST_MESSAGES.withdrawalCode });
    const r = reasonFieldError(reason);
    if (r !== null) fields.push(r);
    setErrors(fields);
    if (fields.length > 0) { setRetrying(false); focusError.current = true; return; }
    const body = { stage: p.stage, baseVersionNumber: p.current.versionNumber, withdrawalCode: code, reason };
    const id = requestIdFor(retry, body);
    setRetry(id.state);
    setBusy(true);
    setFailure('');
    setAction(null);
    setStatus(WITHDRAW_TEXT.withdrawing);
    const outcome = await sendWrite<DecisionVersionView>(
      `/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/questions/${p.questionId}/withdrawal`, 'POST', { ...body, requestId: id.requestId },
      { onSlow: () => {} },
    );
    setBusy(false);
    setRetrying(false);
    const res = withdrawOutcome(outcome, window.location.pathname);
    if (res.kind === 'withdrawn') {
      setStatus(WITHDRAW_TEXT.withdrawn);
      setOpen(false);
      router.refresh();
      return;
    }
    setStatus('');
    afterFailure.current = true;   // a pressed Retry may be gone: focus goes to Retry, or to the control from the body
    if (res.kind === 'fix') { setErrors(res.fields); focusError.current = true; return; }
    setFailure(res.text);
    setAction(res.action ?? null);
    setCanRetry(res.retry);
  }

  const control = (
    // tabIndex -1: after a failure that cannot be retried, focus comes to the control rather than falling to the page.
    <div className="withdraw-decision" ref={container} tabIndex={-1}>
      {open ? (
        <div data-inline-confirm>
          <InlineConfirm
            objectName={WITHDRAW_COPY.objectName(p.current.versionNumber, p.questionId)}
            consequence={WITHDRAW_COPY.consequence}
            actionLabel={WITHDRAW_COPY.action}
            busy={busy}
            destructive
            onConfirm={confirm}
            onCancel={() => { setOpen(false); setErrors([]); setFailure(''); setAction(null); }}
          >
            <Select
              id={CODE_ID} name="withdrawalCode" label={WITHDRAW_COPY.codeLabel} required placeholder={WITHDRAW_COPY.chooseOne}
              value={code} error={err('withdrawalCode')?.message}
              options={WITHDRAWAL_CODES.map((c) => ({ value: c, label: WITHDRAWAL_CODE_LABELS[c] }))}
              onChange={(e) => setCode(e.target.value as WithdrawalCode | '')}
            />
            {/* The reason has no count line, so the kit's TextArea (which draws one) is not used: its parts are. */}
            <div className="ui-field">
              <FieldLabel htmlFor={REASON_ID} label={WITHDRAW_COPY.reasonLabel} required />
              <textarea
                id={REASON_ID} name="reason" rows={3} value={reason}
                className={err('reason') !== undefined ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'}
                aria-invalid={err('reason') !== undefined || undefined}
                aria-describedby={err('reason') !== undefined ? 'withdraw-reason-error' : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              {err('reason') !== undefined ? <FieldErrorText id="withdraw-reason-error" message={err('reason')!.message} /> : null}
            </div>
          </InlineConfirm>
        </div>
      ) : (
        <Button variant="secondary" ref={trigger} onClick={() => { setOpen(true); setStatus(''); }}>{WITHDRAW_COPY.trigger}</Button>
      )}
      <p role="status" data-withdraw-status tabIndex={-1} ref={result}>{status}</p>
      <p role="alert" data-withdraw-alert>{failure}</p>
      {/* A native link in the kit's button classes, as the save path's gate link (DecisionForm): ButtonLink is next/link. */}
      {action !== null && failure !== '' ? <a className="ui-button ui-button--secondary" href={action.href}>{action.label}</a> : null}
      {canRetry && (failure !== '' || retrying)
        ? <Button variant="secondary" ref={retryButton} busy={busy} onClick={() => { setRetrying(true); void confirm(); }}>{WITHDRAW_COPY.retry}</Button>
        : null}
    </div>
  );
  return p.inMoreMenu ? <details className="more-menu"><summary>{WITHDRAW_COPY.more}</summary>{control}</details> : control;
}

