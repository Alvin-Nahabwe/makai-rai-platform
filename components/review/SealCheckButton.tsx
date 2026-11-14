'use client';

import { useId, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import '@/components/ui/formStyles';
import { formatDay } from '@/lib/format/dates';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { SealCheckResult } from '@/types/seal';
import './review.css';

export type SealCheckButtonProps = { orgSlug: string; projectId: string; reviewId: string; sealId: string };

/**
 * M-29's sentence for a check result, in the vocabulary's own words (Task 18 Q3 (b)). `n` is the erased field count
 * (owner question B11 default); clock warnings stay in the route's JSON and are not shown (owner question B10 default).
 * The path of the first difference is not in the sentence: `sealCheckDetail` gives it, for the "Technical details"
 * disclosure (Task 18 Q3 (i)).
 */
export function sealCheckMessage(r: SealCheckResult): string {
  const c = REVIEW_COPY.check;
  if (r.kind === 'valid') {
    if (r.erasedFields === 0 || r.erasedOn === null) return c.valid;
    return r.erasedFields === 1 ? c.validErasedOne(formatDay(r.erasedOn)) : c.validErasedMany(r.erasedFields, formatDay(r.erasedOn));
  }
  return c.mismatch;
}

/** The first difference of a mismatch ("fingerprint" for a fingerprint mismatch), or null for a valid seal. */
export function sealCheckDetail(r: SealCheckResult): string | null {
  if (r.kind === 'valid') return null;
  return REVIEW_COPY.check.firstDifference(r.kind === 'mismatch' ? r.firstDifference : 'fingerprint');
}

/** Route 14 (contract Routes): a read, so it carries no request id (UX-27). Every segment is encoded. */
export function sealCheckPath(p: SealCheckButtonProps): string {
  const e = encodeURIComponent;
  return `/api/v1/orgs/${e(p.orgSlug)}/projects/${e(p.projectId)}/reviews/${e(p.reviewId)}/seals/${e(p.sealId)}/check`;
}

function wait(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function isResult(b: unknown): b is SealCheckResult {
  if (typeof b !== 'object' || b === null) return false;
  const kind = (b as { kind?: unknown }).kind;
  if (kind === 'fingerprint_mismatch') return true;
  if (kind === 'mismatch') return typeof (b as { firstDifference?: unknown }).firstDifference === 'string';
  if (kind !== 'valid') return false;
  const v = b as { erasedFields?: unknown; erasedOn?: unknown };
  return Number.isInteger(v.erasedFields) && (v.erasedOn === null || typeof v.erasedOn === 'string');
}

/**
 * The status line for a reply of route 14: M-29 for a result; on 429 the wait the limit gives (K0b's seal-check
 * limit, contract "Rate-limit keys"); otherwise, or for a reply that is not a result, that the check did not run,
 * which is never shown as a match.
 */
export function checkResponseMessage(status: number, body: unknown): string {
  if (status === 200 && isResult(body)) return sealCheckMessage(body);
  if (status === 429) {
    const s = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof s === 'number' && Number.isFinite(s) && s > 0) return REVIEW_COPY.check.tooMany(wait(Math.ceil(s)));
  }
  return REVIEW_COPY.check.didNotRun;
}

/** The technical detail of a reply of route 14: the first difference of a mismatch result, else null. */
export function checkResponseDetail(status: number, body: unknown): string | null {
  return status === 200 && isResult(body) ? sealCheckDetail(body) : null;
}

/**
 * "Check this seal" on S-16 (UX-19; every member, call U11): the kit's button that GETs route 14 and puts M-29's
 * sentence into the polite status region beside it (WCAG 4.1.3), with the first difference of a mismatch in a
 * "Technical details" disclosure inside that region. Focus stays on the button: while a check runs it shows the
 * kit's busy state rather than `disabled`, which would drop focus, and a second press is ignored. The region is
 * rendered empty from the start, so the result is announced when it arrives; "checking" is not announced. The
 * region is a native `div` in the kit's status classes: the kit's StatusRegion holds a string, not a disclosure.
 */
export function SealCheckButton(props: SealCheckButtonProps): ReactElement {
  const [result, setResult] = useState<{ message: string; detail: string | null }>({ message: '', detail: null });
  const [busy, setBusy] = useState(false);
  const helpId = useId();

  async function check(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setResult({ message: '', detail: null });
    try {
      const res = await fetch(sealCheckPath(props), { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
      // A body that is not JSON is read as no result: the line then says the check did not run.
      const body: unknown = await res.json().catch(() => null);
      setResult({ message: checkResponseMessage(res.status, body), detail: checkResponseDetail(res.status, body) });
    } catch {
      // No reply at all (offline, connection dropped): the person is told, and may press again.
      setResult({ message: REVIEW_COPY.check.didNotRun, detail: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-check">
      <div className="review-row">
        <Button variant="secondary" busy={busy} aria-describedby={helpId} onClick={() => { void check(); }}>{REVIEW_COPY.check.button}</Button>
        <p id={helpId} className="review-help">{REVIEW_COPY.check.help}</p>
      </div>
      <div role="status" className="ui-status review-status">{result.message}{result.detail !== null ? (
        <details className="review-details">
          <summary>{REVIEW_COPY.check.technicalDetails}</summary>
          <p>{result.detail}</p>
        </details>
      ) : null}</div>
    </div>
  );
}
