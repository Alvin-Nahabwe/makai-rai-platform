'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { REQUEST_MESSAGES, WITHDRAW_COPY, WITHDRAWAL_CODE_LABELS, WITHDRAWAL_CODES } from '@/lib/decision/copy';
import { reasonFieldError } from '@/lib/decision/rules';
import { WITHDRAW_TEXT, withdrawOutcome } from '@/lib/question/saveOutcome';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError, Stage, WithdrawalCode } from '@/types/record';

export type WithdrawDecisionProps = {
  orgSlug: string; projectId: string; stage: Stage; questionId: string; current: DecisionVersionView; canWithdraw: boolean;
  /** S-12 holds the control in its "More" menu; S-13 shows it as it is. */
  inMoreMenu?: boolean;
};

const NO_RETRY: RetryState = { requestId: null, sentBody: null };

/**
 * Withdraw this decision (FR-DEC-08, UX-29, UX-42), on S-12 and S-13: a new version with status "withdrawn", through
 * route 2. The inline confirmation names the version and the consequence, its button repeats the action, and it holds
 * the withdrawal code and the reason, both required. Focus moves into it when it opens and back to the trigger on
 * Cancel. Nothing is shown when the person may not withdraw this version (an assessor may withdraw only a version
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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const firstField = useRef<HTMLSelectElement | null>(null);
  const wasOpen = useRef(false);
  const result = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (open) firstField.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // After a withdrawal the control is gone (the question has no decision left to withdraw), so focus, which was in the
  // confirmation, moves to the result line instead of falling to the page (F12).
  useEffect(() => {
    if (status === WITHDRAW_TEXT.withdrawn) result.current?.focus();
  }, [status]);

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
    if (fields.length > 0) return;
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
  }

  const control = (
    <div className="withdraw-decision">
      {open ? (
        <div data-inline-confirm>
          <InlineConfirm
            objectName={WITHDRAW_COPY.objectName(p.current.versionNumber, p.questionId)}
            consequence={WITHDRAW_COPY.consequence}
            actionLabel={WITHDRAW_COPY.action}
            busy={busy}
            onConfirm={confirm}
            onCancel={() => { setOpen(false); setErrors([]); setFailure(''); }}
          >
            <div className="form-group">
              <label htmlFor="withdraw-code">Withdrawal code (required)</label>
              <select
                id="withdraw-code" ref={firstField} value={code} aria-invalid={err('withdrawalCode') !== undefined || undefined}
                aria-describedby={err('withdrawalCode') !== undefined ? 'withdraw-code-error' : undefined}
                onChange={(e) => setCode(e.target.value as WithdrawalCode | '')}
              >
                <option value="">Choose a withdrawal code</option>
                {WITHDRAWAL_CODES.map((c) => <option key={c} value={c}>{WITHDRAWAL_CODE_LABELS[c]}</option>)}
              </select>
              {err('withdrawalCode') !== undefined ? <p id="withdraw-code-error" className="form-error">{err('withdrawalCode')!.message}</p> : null}
            </div>
            <div className="form-group">
              <label htmlFor="withdraw-reason">Reason (required)</label>
              <textarea
                id="withdraw-reason" rows={3} value={reason} aria-invalid={err('reason') !== undefined || undefined}
                aria-describedby={err('reason') !== undefined ? 'withdraw-reason-error' : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              {err('reason') !== undefined ? <p id="withdraw-reason-error" className="form-error">{err('reason')!.message}</p> : null}
            </div>
          </InlineConfirm>
        </div>
      ) : (
        <button type="button" ref={trigger} className="btn btn--secondary" onClick={() => { setOpen(true); setStatus(''); }}>{WITHDRAW_COPY.trigger}</button>
      )}
      <p role="status" data-withdraw-status>{status}</p>
      <p role="alert" data-withdraw-alert>{failure}</p>
      {failure !== '' && canRetry
        ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { void confirm(); }}>Retry</button>
        : null}
    </div>
  );
  return p.inMoreMenu ? <details className="more-menu"><summary>More</summary>{control}</details> : control;
}

