import type { TenantTx } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { LoadedContent } from '@/types/content';
import { questionApplies, questionsInStage } from '@/lib/content/loader';
import { SEAL_SOURCE_TABLES, type ManifestPlan, type SealSourceRows } from '../integrity/sealCheck.mjs';
import { readStageDecisionRows, readStageFindingRows } from './reads';

type Row = Readonly<Record<string, unknown>>;

/**
 * Every row a seal of the stage is built from, every table key present and `seals` empty (the builder appends
 * its own header). The decision side is read before the finding side, through the module's own exports, so a
 * test can pause between them; inside one REPEATABLE READ transaction both see one snapshot (NFR-INT-10).
 */
export async function readStageRows(tx: TenantTx, projectId: string, stage: Stage): Promise<SealSourceRows> {
  const decisions = await readStageDecisionRows(tx, projectId, stage);
  const findings = await readStageFindingRows(tx, projectId, stage);
  const all = { ...decisions, ...findings, seals: [] } as Partial<SealSourceRows>;
  for (const t of SEAL_SOURCE_TABLES) if (!Array.isArray(all[t])) throw new Error(`readStageRows: no rows were read for ${t}`);
  return all as SealSourceRows;
}

const str = (r: Row, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string') throw new TypeError(`stagePlan: ${k} is not text`);
  return v;
};
const num = (r: Row, k: string): number => {
  const v = r[k];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`stagePlan: ${k} is not an integer`);
  return v;
};
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** The row with the highest `key` of each group. */
function latestBy(rows: readonly Row[], group: (r: Row) => string, key: string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const g = group(r);
    const cur = out.get(g);
    if (cur === undefined || num(r, key) > num(cur, key)) out.set(g, r);
  }
  return out;
}

/**
 * What a seal of the stage names (SRS 5.4; 5.3 items 2 and 11), from the stage's rows and the content current at
 * sealing. It reads ids, `questionId`, `versionNumber`, `status`, `scopeAnswer`, `findingId`, `mitigationId`,
 * `findingSeq` and the link columns, never free text.
 *
 * - questions: the content's questions of the stage, sorted; one whose gate's current scope answer makes
 *   `questionApplies` false is derived from that gate version (SRS line 1287);
 * - a question's version: its highest `versionNumber` (a withdrawal is a current version);
 * - findings: every finding of the stage, with every event, the highest version of each mitigation and the
 *   accepted risk with the highest `findingSeq`;
 * - evidence: what the chosen decision versions (not withdrawals) and mitigation versions link.
 *
 * Each id array is deduplicated and sorted by code unit, never left in database order. A current decision for a
 * question the content does not hold throws: whether it enters the manifest is a format decision (R-45).
 */
export function stagePlan(rows: SealSourceRows, a: { stage: Stage; content: LoadedContent }): Omit<ManifestPlan, 'sealId'> {
  const versions = rows.decision_versions.filter((r) => str(r, 'stage') === a.stage);
  const current = latestBy(versions, (r) => str(r, 'questionId'), 'versionNumber');
  const inStage = questionsInStage(a.content, a.stage);
  const known = new Set(inStage.map((q) => q.id));
  for (const q of current.keys()) {
    if (!known.has(q)) throw new Error(`stagePlan: ${q} has a current decision but is not a question of ${a.stage} in content ${a.content.semver}`);
  }

  const questions: { question: string; derivedFrom: string | null }[] = [];
  const decisionVersions: string[] = [];
  const entryVersions = new Set<string>();
  for (const q of inStage) {
    const gate = q.condition === undefined ? undefined : current.get(q.condition.questionId);
    const gateAnswer = gate === undefined || gate.status === 'withdrawn' ? null : (gate.scopeAnswer as 'yes' | 'no' | 'not_sure' | null);
    if (gate !== undefined && !questionApplies(a.content, q.id, gateAnswer)) {
      questions.push({ question: q.id, derivedFrom: str(gate, 'id') });
      decisionVersions.push(str(gate, 'id'));
      continue;
    }
    questions.push({ question: q.id, derivedFrom: null });
    const v = current.get(q.id);
    if (v === undefined) continue;
    decisionVersions.push(str(v, 'id'));
    if (v.status !== 'withdrawn') entryVersions.add(str(v, 'id'));
  }
  questions.sort((x, y) => (x.question < y.question ? -1 : x.question > y.question ? 1 : 0));

  const findings = rows.findings.filter((r) => str(r, 'stage') === a.stage).map((r) => str(r, 'id'));
  const ofFinding = new Set(findings);
  const findingEvents = rows.finding_events.filter((r) => ofFinding.has(str(r, 'findingId'))).map((r) => str(r, 'id'));
  const mitigations = [...latestBy(rows.mitigation_versions.filter((r) => ofFinding.has(str(r, 'findingId'))),
    (r) => `${str(r, 'findingId')}\u0000${str(r, 'mitigationId')}`, 'versionNumber').values()].map((r) => str(r, 'id'));
  const acceptedRisks = [...latestBy(rows.accepted_risks.filter((r) => ofFinding.has(str(r, 'findingId'))),
    (r) => str(r, 'findingId'), 'findingSeq').values()].map((r) => str(r, 'id'));

  const chosenMitigations = new Set(mitigations);
  const evidence = [
    ...rows.decision_evidence.filter((l) => entryVersions.has(str(l, 'versionId'))).map((l) => str(l, 'evidenceId')),
    ...rows.mitigation_evidence.filter((l) => chosenMitigations.has(str(l, 'versionId'))).map((l) => str(l, 'evidenceId')),
  ];

  return {
    questions,
    ids: {
      decisionVersions: sorted(decisionVersions),
      evidence: sorted(evidence),
      findings: sorted(findings),
      findingEvents: sorted(findingEvents),
      mitigationVersions: sorted(mitigations),
      acceptedRisks: sorted(acceptedRisks),
    },
  };
}
