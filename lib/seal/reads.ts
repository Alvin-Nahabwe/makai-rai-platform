import type { TenantTx } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { SealSourceRows, SealSourceTable } from '../integrity/sealCheck.mjs';
import type { StagePlanRows } from './manifest';

/**
 * The rows a seal of one stage is built from (SRS 5.4), in the `row_to_json` form of the contract's
 * `SEAL_SOURCE_SQL` (`lib/integrity/sealCheck.mjs`), narrowed with `$2` the project and `$3` the stage. The seal
 * builder runs these inside its one REPEATABLE READ transaction (SRS 5.3 item 9, NFR-INT-10), so every query reads
 * the same snapshot; each reader sets the session's time zone to UTC first, as `row_to_json`'s timestamps must be.
 *
 * - decisions and findings: of the project and stage;
 * - finding events, mitigation versions, accepted risks and mitigation evidence links: of those findings;
 * - decision evidence links: of those decision versions;
 * - evidence: every item those links name (the manifest lists evidence only through them);
 * - stage reviews: of the project; framework versions: every row (the reference lane);
 * - no seals row: the builder appends the header of the seal it is writing.
 *
 * Every value is a bind parameter; the text is constant.
 */
const OF_STAGE_FINDINGS = `SELECT f."id" FROM findings f WHERE f."orgId" = $1 AND f."projectId" = $2 AND f."stage" = $3`;
const OF_STAGE_DECISIONS = `SELECT v."id" FROM decision_versions v WHERE v."orgId" = $1 AND v."projectId" = $2 AND v."stage" = $3`;
const OF_STAGE_MITIGATIONS = `SELECT m."id" FROM mitigation_versions m WHERE m."orgId" = $1 AND m."findingId" IN (${OF_STAGE_FINDINGS})`;

export const STAGE_SOURCE_SQL: Readonly<Record<Exclude<SealSourceTable, 'seals'>, string>> = Object.freeze({
  decision_versions: `SELECT row_to_json(t) AS r FROM decision_versions t WHERE t."orgId" = $1 AND t."projectId" = $2 AND t."stage" = $3`,
  decision_evidence: `SELECT row_to_json(t) AS r FROM decision_evidence t WHERE t."orgId" = $1 AND t."versionId" IN (${OF_STAGE_DECISIONS})`,
  evidence: `SELECT row_to_json(t) AS r FROM evidence t WHERE t."orgId" = $1 AND t."id" IN (`
    + `SELECT d."evidenceId" FROM decision_evidence d WHERE d."orgId" = $1 AND d."versionId" IN (${OF_STAGE_DECISIONS}) UNION `
    + `SELECT e."evidenceId" FROM mitigation_evidence e WHERE e."orgId" = $1 AND e."versionId" IN (${OF_STAGE_MITIGATIONS}))`,
  stage_reviews: `SELECT row_to_json(t) AS r FROM stage_reviews t WHERE t."orgId" = $1 AND t."projectId" = $2`,
  framework_versions: `SELECT row_to_json(t) AS r FROM framework_versions t`,
  findings: `SELECT row_to_json(t) AS r FROM findings t WHERE t."orgId" = $1 AND t."projectId" = $2 AND t."stage" = $3`,
  finding_events: `SELECT row_to_json(t) AS r FROM finding_events t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`,
  mitigation_versions: `SELECT row_to_json(t) AS r FROM mitigation_versions t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`,
  mitigation_evidence: `SELECT row_to_json(t) AS r FROM mitigation_evidence t WHERE t."orgId" = $1 AND t."versionId" IN (${OF_STAGE_MITIGATIONS})`,
  accepted_risks: `SELECT row_to_json(t) AS r FROM accepted_risks t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`,
});

const DECISION_TABLES = ['decision_versions', 'decision_evidence', 'evidence', 'stage_reviews', 'framework_versions'] as const;
const FINDING_TABLES = ['findings', 'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks'] as const;

/** The highest `$n` a statement names: it is passed exactly that many parameters, since PostgreSQL refuses an unused one it cannot type. */
const parameterCount = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

async function readTables(tx: TenantTx, tables: readonly (keyof typeof STAGE_SOURCE_SQL)[], orgId: string, projectId: string, stage: Stage): Promise<Partial<SealSourceRows>> {
  await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
  const params = [orgId, projectId, stage];
  const out: Partial<Record<SealSourceTable, Record<string, unknown>[]>> = {};
  for (const t of tables) {
    const sql = STAGE_SOURCE_SQL[t];
    const rows = await tx.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(sql, ...params.slice(0, parameterCount(sql)));
    out[t] = rows.map((x) => x.r);
  }
  return out;
}

/** The organisation of the transaction, as `withOrg` set it; the queries name it, row-level security enforces it. */
export async function currentOrg(tx: TenantTx): Promise<string> {
  const [{ org }] = await tx.$queryRaw<{ org: string | null }[]>`SELECT NULLIF(current_setting('app.current_org_id', true), '') AS org`;
  if (org === null) throw new Error('lib/seal/reads: no organisation is set on this transaction (call inside withOrg)');
  return org;
}

/** The decision side of a stage: its versions, their evidence links and evidence, the project's stage reviews, every content version. */
export async function readStageDecisionRows(tx: TenantTx, projectId: string, stage: Stage): Promise<Partial<SealSourceRows>> {
  return readTables(tx, DECISION_TABLES, await currentOrg(tx), projectId, stage);
}

/** The finding side of a stage: its findings, their events, mitigation versions and links, and accepted risks. */
export async function readStageFindingRows(tx: TenantTx, projectId: string, stage: Stage): Promise<Partial<SealSourceRows>> {
  return readTables(tx, FINDING_TABLES, await currentOrg(tx), projectId, stage);
}

/** `json_agg` of `columns` of `from`, or `[]` when it has no row. */
const agg = (columns: readonly string[], from: string) =>
  `(SELECT coalesce(json_agg(json_build_object(${columns.map((c) => `'${c}', t."${c}"`).join(', ')})), '[]'::json) FROM ${from})`;

/**
 * The rows `stagePlan` reads, and no other column: what "changed since seal" plans the stage's ids from now (FR-REV-05,
 * SRS line 993). The same rows as `STAGE_SOURCE_SQL` names, with only the columns `stagePlan` and `stageIdsNow` read
 * (ids, `stage`, `questionId`, `versionNumber`, `status`, `scopeAnswer`, `findingId`, `mitigationId`, `findingSeq` and
 * the link columns), so no free text, no timestamp and no digest is read, sent or parsed. One statement: each table is
 * one `json_agg` value, parsed once, not row by row (NFR-PERF-04; FIX-12). Its type holds only the tables the plan
 * reads, so nothing that reads evidence, reviews or seals (the seal builder, the seal check, documents) can be given
 * these rows: those read `readStageRows`.
 */
const PLAN_SQL = `SELECT
  ${agg(['id', 'stage', 'questionId', 'versionNumber', 'status', 'scopeAnswer'], `decision_versions t WHERE t."orgId" = $1 AND t."projectId" = $2 AND t."stage" = $3`)} AS "decision_versions",
  ${agg(['versionId', 'evidenceId'], `decision_evidence t WHERE t."orgId" = $1 AND t."versionId" IN (${OF_STAGE_DECISIONS})`)} AS "decision_evidence",
  ${agg(['id', 'stage'], `findings t WHERE t."orgId" = $1 AND t."projectId" = $2 AND t."stage" = $3`)} AS "findings",
  ${agg(['id', 'findingId'], `finding_events t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`)} AS "finding_events",
  ${agg(['id', 'findingId', 'mitigationId', 'versionNumber'], `mitigation_versions t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`)} AS "mitigation_versions",
  ${agg(['versionId', 'evidenceId'], `mitigation_evidence t WHERE t."orgId" = $1 AND t."versionId" IN (${OF_STAGE_MITIGATIONS})`)} AS "mitigation_evidence",
  ${agg(['id', 'findingId', 'findingSeq'], `accepted_risks t WHERE t."orgId" = $1 AND t."findingId" IN (${OF_STAGE_FINDINGS})`)} AS "accepted_risks"`;

export async function readStagePlanRows(tx: TenantTx, projectId: string, stage: Stage): Promise<StagePlanRows> {
  const [rows] = await tx.$queryRawUnsafe<StagePlanRows[]>(PLAN_SQL, await currentOrg(tx), projectId, stage);
  return rows;
}
