import type { Prisma } from '@prisma/client';
import { cache } from 'react';
import { identityDb } from './identity';
import { currentLegalText, legalTextHistory } from '../legal/registry';
import { LEGAL_KIND_NAMES, type AcceptancePair } from '../legal/kinds';
import { formatDay } from '../format/dates';
import { AppError } from '../http/errors';
import {
  ACCEPTED_KINDS, CONSENT_TYPE_FOR, type AcceptanceView, type AcceptedKind, type LegalTextVersion,
} from '../../types/legal';

/**
 * An account's acceptances of the three legal texts (FR-ACC-03, FR-ACC-04): one `consent_records`
 * row per kind and version, on the identity lane, and the sets the acceptance gate, S-05 and S-21
 * read from them.
 *
 * A row COUNTS for kind k when it is granted, not voided, of `CONSENT_TYPE_FOR[k]`, and its
 * (version, textHash) equals a version of `legalTextHistory(k)`. So a pre-v1 row (version '1.0',
 * no hash) never counts: the words it accepted cannot be shown (SRS call 4, line 5711).
 *
 * A kind is CURRENT when a counting row is of the current version. Otherwise it is MISSING when no
 * row counts, or when any version newer than the newest counted one is `acceptance: required`
 * (FR-ACC-04: a required version blocks even when a later offered one is current, so v1 accepted,
 * v2 required, v3 offered is missing; accepting the current version clears it); else OFFERED.
 * Nothing here catches: a database error reaches the gate as an error, never as "nothing missing".
 */

type ConsentType = (typeof CONSENT_TYPE_FOR)[AcceptedKind];
type AcceptanceRow = { consentType: string; version: string; textHash: string | null; grantedAt: Date };

/** Prisma drops a `where` key whose value is undefined, so an empty id would read every account's rows. */
function accountId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length === 0) throw new TypeError('an account id is required');
  return userId;
}

function consentTypeOf(kind: AcceptedKind): ConsentType {
  if (!Object.hasOwn(CONSENT_TYPE_FOR, kind)) throw new TypeError(`not an accepted kind: ${String(kind)}`);
  return CONSENT_TYPE_FOR[kind];
}

/**
 * The account's granted, non-voided rows of the three kinds, read once per server request: the gates (every layout and
 * page runs requireIdentity), the shell's newer-text notice and S-05 all read through it. React's `cache()` keeps one
 * table per request and none outside one, so a failed read refuses its own request only and never reaches another.
 * recordAcceptances writes after its read; no reader of the same request reads after a write.
 */
const rowsOf = cache((userId: string): Promise<AcceptanceRow[]> => {
  return identityDb.consentRecord.findMany({
    where: {
      userId: accountId(userId), granted: true, voidedAt: null,
      consentType: { in: ACCEPTED_KINDS.map(consentTypeOf) },
    },
    select: { consentType: true, version: true, textHash: true, grantedAt: true },
    orderBy: { grantedAt: 'asc' },
  });
});

const isOf = (row: AcceptanceRow, text: LegalTextVersion) => row.version === text.version && row.textHash === text.sha256;

/** 'current', 'missing' or 'offered' by the rules above; `history` is oldest first, as the registry keeps it. */
function standing(kind: AcceptedKind, rows: readonly AcceptanceRow[]): { state: 'current' | 'missing' | 'offered'; current: LegalTextVersion } {
  const current = currentLegalText(kind);
  const history = legalTextHistory(kind);
  const ofKind = rows.filter((r) => r.consentType === consentTypeOf(kind));
  if (ofKind.some((r) => isOf(r, current))) return { state: 'current', current };
  // The index of the newest version a counting row is of; -1 when none counts.
  const newestCounted = history.reduce((at, t, i) => (ofKind.some((r) => isOf(r, t)) ? i : at), -1);
  if (newestCounted === -1 || history.slice(newestCounted + 1).some((t) => t.acceptance === 'required')) return { state: 'missing', current };
  return { state: 'offered', current };
}

/** The kinds the account must accept before any other page or API route is usable (gate 3, SRS 7.1.2). */
export async function missingAcceptances(userId: string): Promise<AcceptedKind[]> {
  const rows = await rowsOf(userId);
  return ACCEPTED_KINDS.filter((k) => standing(k, rows).state === 'missing');
}

/** The current versions offered without blocking (M-39): accepted before, newer one `offered`. */
export async function offeredAcceptances(userId: string): Promise<LegalTextVersion[]> {
  const rows = await rowsOf(userId);
  return ACCEPTED_KINDS.map((k) => standing(k, rows)).filter((s) => s.state === 'offered').map((s) => s.current);
}

/**
 * The rows that record acceptance of the current version of each kind: version and hash from the
 * registry at write time, never from a caller, and no client address (SRS 9.5 step 6, line 3690).
 * Pure, so route 31 inserts them inside its own transaction.
 */
export function acceptanceRows(userId: string, kinds: readonly AcceptedKind[]): Prisma.ConsentRecordCreateManyInput[] {
  return kinds.map((kind) => {
    const current = currentLegalText(kind);
    return { userId, consentType: consentTypeOf(kind), version: current.version, textHash: current.sha256, granted: true };
  });
}

/**
 * Threat A5 (FR-ACC-03): an acceptance counts only for the text the person was shown. When a posted
 * version is not the current one (a newer text was published after S-04 or S-05 rendered), this
 * throws 409 `legal_text_changed` with M-39's sentence for each such kind and `missing` naming
 * them, so the page reloads with the new text; nothing is written.
 */
export function assertCurrentVersions(acceptances: readonly AcceptancePair[]): void {
  const stale = ACCEPTED_KINDS.filter((k) => acceptances.some((a) => a.kind === k && a.version !== currentLegalText(k).version));
  if (stale.length === 0) return;
  const text = stale.map((k) => `A new version of the ${LEGAL_KIND_NAMES[k]} was published on ${formatDay(currentLegalText(k).publishedOn)}.`).join(' ');
  throw new AppError(409, 'legal_text_changed', text, { missing: stale });
}

/** Records acceptance of the current version of each kind given; a kind whose current version already counts gets no second row. */
export async function recordAcceptances(userId: string, kinds: readonly AcceptedKind[]): Promise<void> {
  const rows = await rowsOf(userId);
  const toRecord = [...new Set(kinds)].filter((k) => standing(k, rows).state !== 'current');
  if (toRecord.length === 0) return;
  await identityDb.consentRecord.createMany({ data: acceptanceRows(userId, toRecord) });
}

/** S-21's record (FR-ACC-03): the latest row of each kind, counting or not, oldest kind order first. */
export async function myAcceptances(userId: string): Promise<AcceptanceView[]> {
  const rows = await rowsOf(userId);
  return ACCEPTED_KINDS.flatMap((kind): AcceptanceView[] => {
    const latest = rows.filter((r) => r.consentType === consentTypeOf(kind)).at(-1);
    return latest === undefined ? [] : [{ kind, version: latest.version, sha256: latest.textHash, acceptedAt: latest.grantedAt.toISOString() }];
  });
}
