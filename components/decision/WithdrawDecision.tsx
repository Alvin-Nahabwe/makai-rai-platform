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
import '@/components/ui/TextArea.css';

export type WithdrawDecisionProps = {
  orgSlug: string; projectId: string; stage: Stage; questionId: string; current: DecisionVersionView; canWithdraw: boolean;
  /** S-12 holds the control in its "More" menu; S-13 shows it as it is. */
  inMoreMenu?: boolean;
};

const NO_RETRY: RetryState = { requestId: null, sentBody: null };

/**
 * Withdraw this decision (FR-DEC-08, UX-29, UX-42), on S-12 and S-13: a new version with status "withdrawn", through
 * route 2. The inline confirmation names the version and the consequence, its button repeats the action, and it holds
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

  useEffect(() => {
    // The kit's Select takes no ref: its first field is found by its id.
    if (open) document.getElementById('withdraw-code')?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // After a withdrawal the control is gone (the question has no decision left to withdraw), so focus, which was in the
  // confirmation, moves to the result line instead of falling to the page (F12): once when the reply comes (after the
  // effect above has returned focus to the trigger), and again when the refresh brings the withdrawn version and the
  // line is the only thing left. Declared after that effect so it runs after it.
  useEffect(() => {
    if (status === WITHDRAW_TEXT.withdrawn) result.current?.focus();
  }, [status, p.current.id]);

  useEffect(() => {
    if (!afterFailure.current) return;
    afterFailure.current = false;
    if (retryButton.current !== null) retryButton.current.focus();
    else if (document.activeElement === null || document.activeElement === document.body) container.current?.focus();
  });

  // A later version that is not a withdrawal (a new decision saved after one) makes the last result stale.
  if (p.current.id !== seenCurrentId) {
    setSeenCurrentId(p.current.id);
    if (p.current.status !== 'withdrawn') { setStatus(''); setFailure(''); setCanRetry(false); }
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
    if (fields.length > 0) { setRetrying(false); return; }
    const body = { stage: p.stage, baseVersionNumber: p.current.versionNumber, withdrawalCode: code, reason };
    const id = requestIdFor(retry, body);
    setRetry(id.state);
    setBusy(true);
    setFailure('');
    setStatus(WITHDRAW_TEXT.withdrawing);
    const outcome = await sendWrite<DecisionVersionView>(
      `/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/questions/${p.questionId}/withdrawal`, 'POST', { ...body, requestId: id.requestId },
      { onSlow: () => {} },
    );
    setBusy(false);
    setRetrying(false);
    const res = withdrawOutcome(outcome);
    if (res.kind === 'withdrawn') {
      setStatus(WITHDRAW_TEXT.withdrawn);
      setOpen(false);
      router.refresh();
      return;
    }
    setStatus('');
    if (res.kind === 'fix') { setErrors(res.fields); return; }
    setFailure(res.text);
    setCanRetry(res.retry);
    afterFailure.current = true;
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
            onCancel={() => { setOpen(false); setErrors([]); setFailure(''); }}
          >
            <Select
              id="withdraw-code" name="withdrawalCode" label={WITHDRAW_COPY.codeLabel} required placeholder={WITHDRAW_COPY.chooseOne}
              value={code} error={err('withdrawalCode')?.message}
              options={WITHDRAWAL_CODES.map((c) => ({ value: c, label: WITHDRAWAL_CODE_LABELS[c] }))}
              onChange={(e) => setCode(e.target.value as WithdrawalCode | '')}
            />
            {/* The reason has no count line, so the kit's TextArea (which draws one) is not used: its parts are. */}
            <div className="ui-field">
              <FieldLabel htmlFor="withdraw-reason" label={WITHDRAW_COPY.reasonLabel} required />
              <textarea
                id="withdraw-reason" name="reason" rows={3} value={reason}
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
      {canRetry && (failure !== '' || retrying)
        ? <Button variant="secondary" ref={retryButton} busy={busy} onClick={() => { setRetrying(true); void confirm(); }}>{WITHDRAW_COPY.retry}</Button>
        : null}
    </div>
  );
  return p.inMoreMenu ? <details className="more-menu"><summary>{WITHDRAW_COPY.more}</summary>{control}</details> : control;
}

