'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { REQUEST_MESSAGES, WITHDRAW_COPY, WITHDRAWAL_CODE_LABELS, WITHDRAWAL_CODES } from '@/lib/decision/copy';
import { reasonFieldError } from '@/lib/decision/rules';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError, Stage, WithdrawalCode } from '@/types/record';

export type WithdrawDecisionProps = {
  orgSlug: string; projectId: string; stage: Stage; questionId: string; current: DecisionVersionView; canWithdraw: boolean;
};

/** S-13's result lines for a withdrawal (7.4.2 S-13 row). The failure lines are builder copy (7.4.2 says "Pattern"). */
export const WITHDRAW_TEXT = Object.freeze({
  withdrawing: 'Withdrawing...',
  withdrawn: 'Withdrawn. The question has no current decision.',
  network: 'Not withdrawn: connection lost. Nothing was changed. Retry.',
  moved: 'Not withdrawn: someone saved a newer version. Reload the page to see it.',
  forbidden: 'Not withdrawn: your role in this organisation no longer allows this.',
  archived: 'Not withdrawn: this project is archived. Owners and admins can unarchive it.',
  signedOut: 'Not withdrawn: you have been signed out. Sign in again to withdraw it.',
  server: 'Not withdrawn: the server had a problem. Retry.',
});

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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const firstField = useRef<HTMLSelectElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) firstField.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!p.canWithdraw || p.current.status === 'withdrawn') {
    return status === '' ? null : <p role="status" data-withdraw-status>{status}</p>;
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
    if (outcome.kind === 'saved' && typeof (outcome.body as Partial<DecisionVersionView> | undefined)?.versionNumber === 'number') {
      setStatus(WITHDRAW_TEXT.withdrawn);
      setOpen(false);
      router.refresh();
      return;
    }
    setStatus('');
    if (outcome.kind === 'rejected' && outcome.status === 422) { setErrors(outcome.body.fields ?? [{ field: 'reason', message: outcome.body.error }]); return; }
    const code409 = outcome.kind === 'rejected' && outcome.status === 409 ? outcome.body.code : null;
    setFailure(
      outcome.kind === 'not_saved' ? WITHDRAW_TEXT.network
        : outcome.status === 401 ? WITHDRAW_TEXT.signedOut
          : outcome.status === 403 ? WITHDRAW_TEXT.forbidden
            : code409 === 'base_version_moved' ? WITHDRAW_TEXT.moved
              : code409 === 'project_archived' ? WITHDRAW_TEXT.archived
                : WITHDRAW_TEXT.server,
    );
  }

  return (
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
      {failure === WITHDRAW_TEXT.network || failure === WITHDRAW_TEXT.server
        ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { void confirm(); }}>Retry</button>
        : null}
    </div>
  );
}

