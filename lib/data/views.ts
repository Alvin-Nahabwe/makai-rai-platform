import type { CalendarDate, EvidenceKind } from '../../types/record';
import type { EvidenceItemView, UserRef } from '../../types/api';
import { lookupUserNames } from './identity';
import type { TenantTx } from './tenant';

/**
 * The shared read views every record unit composes (00-contract.md, Services, K0a; findings
 * F19 (a), F32): names with the former-member rule, evidence with its erased mark, and the
 * erased fields of record rows. Everything is read inside the caller's transaction, under its
 * organisation; only names come from the identity lane (`lookupUserNames`).
 */

/** The membership changes whose row names its member as targetUserId (contract, Data model, `Membership`). */
const MEMBER_ACTIONS = ['member_joined', 'member_role_changed', 'member_removed', 'member_left'];

/**
 * FR-DEC-01: 'member' (holds a membership of the organisation), 'former' (holds none, and at
 * least one membership-change row of the organisation names them as targetUserId), or 'never'.
 * Rows the definer functions write as the platform administrator never name them as a member's
 * target, so the administrator, who never holds a membership, always reads 'never' (R2-08).
 */
export async function memberHistory(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, 'member' | 'former' | 'never'>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, 'member' | 'former' | 'never'>();
  if (ids.length === 0) return out;
  const [members, named] = await Promise.all([
    tx.membership.findMany({ where: { userId: { in: ids } }, select: { userId: true } }),
    tx.organisationEvent.findMany({ where: { targetUserId: { in: ids }, action: { in: MEMBER_ACTIONS } }, select: { targetUserId: true }, distinct: ['targetUserId'] }),
  ]);
  const isMember = new Set(members.map((m) => m.userId));
  const wasMember = new Set(named.map((e) => e.targetUserId));
  for (const id of ids) out.set(id, isMember.has(id) ? 'member' : wasMember.has(id) ? 'former' : 'never');
  return out;
}

/**
 * `UserRef` for each id that is an account: its name (identity lane) and whether it is a former
 * member of the transaction's organisation. Accounts are scrubbed, never deleted (FR-EXP-03), so
 * every id a record carries has a row; an id with none is left out of the map.
 */
export async function userRefs(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, UserRef>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const [history, names] = await Promise.all([memberHistory(tx, ids), lookupUserNames(ids)]);
  const out = new Map<string, UserRef>();
  for (const id of ids) {
    const n = names.get(id);
    if (n) out.set(id, { userId: id, name: n.name, formerMember: history.get(id) === 'former' });
  }
  return out;
}

const isoUtc = (d: Date) => d.toISOString();

/**
 * FR-EVD-05: `EvidenceItemView` for each evidence id of the transaction's organisation, with
 * `erased` set from a tombstone of its bytes (targetTable 'evidence', no field): the UTC date
 * of the erasure. An erased file name, URL or label reads as null, as stored.
 */
export async function evidenceViews(tx: TenantTx, ids: readonly string[]): Promise<Map<string, EvidenceItemView>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await tx.evidence.findMany({
    where: { id: { in: wanted } },
    select: { id: true, kind: true, filename: true, mimeType: true, byteSize: true, sha256: true, url: true, label: true, uploadedById: true, uploadedAt: true },
  });
  const erased = await tx.$queryRaw<{ targetId: string; erasedOn: CalendarDate }[]>`
    SELECT "targetId", to_char(min("at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "erasedOn"
    FROM "tombstones"
    WHERE "targetTable" = 'evidence' AND "field" IS NULL AND "targetId" = ANY (${wanted}::text[])
    GROUP BY "targetId"`;
  const erasedOn = new Map(erased.map((e) => [e.targetId, e.erasedOn]));
  const refs = await userRefs(tx, rows.flatMap((r) => (r.uploadedById ? [r.uploadedById] : [])));
  const out = new Map<string, EvidenceItemView>();
  for (const r of rows) {
    out.set(r.id, {
      id: r.id, kind: r.kind as EvidenceKind, fileName: r.filename, mimeType: r.mimeType, byteSize: r.byteSize, sha256: r.sha256,
      url: r.url, label: r.label, uploadedBy: r.uploadedById ? refs.get(r.uploadedById) ?? null : null,
      uploadedAt: isoUtc(r.uploadedAt), erased: erasedOn.has(r.id) ? { erasedOn: erasedOn.get(r.id) as CalendarDate } : null,
    });
  }
  return out;
}

/**
 * FR-REV-08: for each id of `targetTable` with an erased free-text field, the erased fields
 * (digest field names, sorted) and the UTC date of the latest erasure.
 */
export async function erasedFields(
  tx: TenantTx,
  targetTable: string,
  ids: readonly string[],
): Promise<Map<string, { fields: string[]; erasedOn: CalendarDate }>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ targetId: string; fields: string[]; erasedOn: CalendarDate }[]>`
    SELECT "targetId", array_agg(DISTINCT "field" ORDER BY "field") AS "fields",
      to_char(max("at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "erasedOn"
    FROM "tombstones"
    WHERE "targetTable" = ${targetTable} AND "field" IS NOT NULL AND "targetId" = ANY (${wanted}::text[])
    GROUP BY "targetId"`;
  return new Map(rows.map((r) => [r.targetId, { fields: r.fields, erasedOn: r.erasedOn }]));
}
