import type { SealManifestV1, SealCheckResult } from '../../types/seal';

export declare const SEAL_SOURCE_TABLES: readonly [
  'seals', 'stage_reviews', 'framework_versions', 'decision_versions', 'decision_evidence', 'evidence',
  'findings', 'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks',
];
export type SealSourceTable = (typeof SEAL_SOURCE_TABLES)[number];
/**
 * Each row exactly as PostgreSQL `row_to_json` writes it in a session with `TimeZone` set to `UTC`
 * (timestamptz as ISO text, bytea as `\x` hex text, date `YYYY-MM-DD`).
 */
export type SealSourceRows = Readonly<Record<SealSourceTable, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
/** `row_to_json` of a `tombstones` row. */
export type TombstoneRow = Readonly<Record<string, unknown>>;
/** One `SELECT row_to_json(t) AS r FROM <table> t WHERE ...` per table, `$1` the organisation id. */
export declare const SEAL_SOURCE_SQL: Readonly<Record<SealSourceTable | 'tombstones', string>>;

export type SealedIdSet = {
  decisionVersions: string[]; evidence: string[]; findings: string[]; findingEvents: string[];
  mitigationVersions: string[]; acceptedRisks: string[];
};

/** Each array sorted, no duplicates. */
export function manifestIds(m: SealManifestV1): SealedIdSet;
export function checkSealRows(input: {
  manifestBytes: Uint8Array; fingerprint: string; rows: SealSourceRows; tombstones: TombstoneRow[];
}): SealCheckResult;

/** REV-a internal: the seal check and the seal builder call these; other units call only the names above. */
export interface ManifestPlan {
  sealId: string;
  questions: ReadonlyArray<{ question: string; derivedFrom: string | null }>;
  ids: SealedIdSet;
}
/** `tombstones`: read in the same snapshot as `rows`; a field erased before sealing is sealed with its tombstone's digest (ruling b). */
export function manifestFromRows(rows: SealSourceRows, plan: ManifestPlan, tombstones?: TombstoneRow[]): SealManifestV1;
export function planFromManifest(m: SealManifestV1): ManifestPlan;
