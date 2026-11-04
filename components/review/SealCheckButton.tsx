'use client';

import { useState, type CSSProperties, type ReactElement } from 'react';
import { formatDay } from '@/lib/format/dates';
import type { SealCheckResult } from '@/types/seal';

export type SealCheckButtonProps = { orgSlug: string; projectId: string; reviewId: string; sealId: string };

/**
 * M-29's sentence for a check result (SRS 7.5.7 line 2576). "<n> field(s)" is written "1 field" and "<n> fields",
 * and `n` is the erased field count (owner question B11 default); clock warnings stay in the route's JSON and are
 * not shown (owner question B10 default). A fingerprint mismatch names the path `fingerprint`.
 */
export function sealCheckMessage(r: SealCheckResult): string {
  if (r.kind === 'valid') {
    if (r.erasedFields === 0 || r.erasedOn === null) return 'Matches the record.';
    const n = r.erasedFields === 1 ? '1 field' : `${r.erasedFields} fields`;
    return `Matches the record. ${n} erased on ${formatDay(r.erasedOn)} on the organisation's instruction.`;
  }
  const at = r.kind === 'mismatch' ? r.firstDifference : 'fingerprint';
  return `Does not match the record. First difference: ${at}. Contact MAK-AI through Help and contact.`;
}

/** Route 14 (contract Routes): a read, so it carries no request id (UX-27). Every segment is encoded. */
export function sealCheckPath(p: SealCheckButtonProps): string {
  const e = encodeURIComponent;
  return `/api/v1/orgs/${e(p.orgSlug)}/projects/${e(p.projectId)}/reviews/${e(p.reviewId)}/seals/${e(p.sealId)}/check`;
}

const DID_NOT_RUN = 'The check did not run. Try again.';

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
    if (typeof s === 'number' && Number.isFinite(s) && s > 0) return `Too many checks. Try again in ${wait(Math.ceil(s))}.`;
  }
  return DID_NOT_RUN;
}

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' };
const STATUS: CSSProperties = { margin: 0, overflowWrap: 'anywhere' };

/**
 * "Check this seal" on S-16 (UX-19; every member, call U11): a native button that GETs route 14 and puts M-29's
 * sentence into the polite status region beside it (WCAG 4.1.3). Focus stays on the button: while a check runs it is
 * marked `aria-disabled` rather than `disabled`, which would drop focus, and a second press is ignored. The region
 * is rendered empty from the start, so the result is announced when it arrives; "checking" is not announced.
 */
export function SealCheckButton(props: SealCheckButtonProps): ReactElement {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(sealCheckPath(props), { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
      // A body that is not JSON is read as no result: the line then says the check did not run.
      const body: unknown = await res.json().catch(() => null);
      setMessage(checkResponseMessage(res.status, body));
    } catch {
      // No reply at all (offline, connection dropped): the person is told, and may press again.
      setMessage(DID_NOT_RUN);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={ROW}>
      <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} onClick={() => { void check(); }}>Check this seal</button>
      <p role="status" style={STATUS}>{message}</p>
    </div>
  );
}
