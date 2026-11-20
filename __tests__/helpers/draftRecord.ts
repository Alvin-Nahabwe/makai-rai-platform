import type { DecisionStatus, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, FindingView, UserRef } from '@/types/api';
import type { SealManifestV1 } from '@/types/seal';
import type { LoadedContent } from '@/types/content';
import type { DraftRecord } from '@/lib/data/documents';
import type { SealedDecision, SealedFinding, SnapshotStage } from '@/lib/documents/resolve';

/** Hand-built draft records over the fixture bundle (path to outputs, Task 8): decisions, findings and a whole record, with fixture ids only. */
export const TAKEN: UtcInstant = '2026-11-19T14:05:09.000Z';
export const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });

export function decisionOf(content: LoadedContent, qid: string, status: DecisionStatus | null, over: { scopeAnswer?: 'yes' | 'no' | null; reason?: string } = {}): SealedDecision {
  const stage = (content.questions.get(qid) as { stage: Stage }).stage;
  const na = content.reasonCodes.filter((c) => c.status === 'not_applicable')[0];
  return {
    row: {
      id: `dv-${qid}-1`, orgId: 'o', projectId: 'p', stage, questionId: qid, contentVersionId: 'cv1', versionNumber: 1, baseVersionNumber: null,
      status, scopeAnswer: over.scopeAnswer ?? null, optionsInPlace: [], reasonCode: status === 'not_applicable' ? na.code : null,
      reason: status === 'not_applicable' ? 'Whole register used.' : (over.reason ?? null),
      reasonSalt: null, decidedByUserId: 'u-Amina N.', decidedByRole: null, declaredOn: new Date('2026-10-12T00:00:00Z'), declaredPrecision: 'day',
      withdrawalCode: null, enteredById: 'u-enterer', enteredByRole: 'assessor', receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r',
      requestDigest: 'd', evidenceIds: [],
    },
    content: CV, enteredBy: user('Amina N.'), decidedBy: { kind: 'member', user: user('Amina N.') }, evidence: [], reasonErased: null,
  };
}

export type FindingSpec = {
  id: string; stage: Stage; source?: 'shortfall' | 'team'; questionId?: string | null; riskArea?: string | null; title?: string | null;
  state?: FindingView['state']; reason?: string;
};
export function findingOf(s: FindingSpec): SealedFinding {
  const view: FindingView = {
    id: s.id, projectId: 'p', stage: s.stage, source: s.source ?? 'team', questionId: s.questionId ?? null, decisionVersionId: null,
    riskArea: s.riskArea ?? null, title: s.title === undefined ? (s.source === 'shortfall' ? null : 'A team finding') : s.title, description: 'Described.',
    raisedBy: user('Amina N.'), raisedAt: '2026-10-29T08:00:00.000Z', state: s.state ?? 'open', openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0,
  };
  const acceptedRisk = s.state === 'closed_accepted_risk'
    ? { id: `ar-${s.id}`, findingId: s.id, acceptedBy: { kind: 'member' as const, user: user('Amina N.') }, accepterRole: 'owner' as const, reason: s.reason ?? null,
      lookAgainNote: null, lookAgainOn: null, enteredBy: user('Amina N.'), enteredByRole: 'owner' as const, findingSeq: 3, receivedAt: TAKEN, erasedFields: [] }
    : null;
  return { finding: view, mitigations: [], acceptedRisk, events: [] };
}

export type StageSpec = { decisions?: SealedDecision[]; findings?: SealedFinding[]; derived?: Record<string, string> };
function stageOf(st: Stage, s: StageSpec = {}): SnapshotStage {
  const decisions = new Map((s.decisions ?? []).map((d) => [d.row.questionId, d]));
  return {
    stage: st,
    seal: { kind: 'draft', key: `draft:${st}`, takenAt: TAKEN, enteredByPeople: decisions.size === 0 ? 0 : 1, openReview: null, lastSealedReview: null },
    preparedFor: null,
    manifest: { format: 'makrai.seal/1', content: { semver: '0.0.1-fixture', contentHash: 'h' }, decisions: [] } as unknown as SealManifestV1,
    decisions, derived: new Map(Object.entries(s.derived ?? {})), findings: s.findings ?? [],
  };
}

export function recordOf(content: LoadedContent, specs: Partial<Record<Stage, StageSpec>>, over: Partial<DraftRecord> = {}): DraftRecord {
  const stages = Object.fromEntries(STAGES.map((st) => [st, stageOf(st, specs[st])])) as Record<Stage, SnapshotStage>;
  return {
    takenAt: TAKEN, stages, stagesWithAnswers: STAGES.filter((st) => stages[st].decisions.size > 0), contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: '2026-11-19',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: new Map(), accepted_risks: new Map(), stage_reviews: new Map() },
    developmentStage: null, omittedAnswers: 0, omittedByStage: { 'pre-processing': 0, 'in-processing': 0, 'post-processing': 0 }, recordedQuestionWords: new Map(), ...over,
  };
}

/**
 * Every question of the content answered, in all three stages: a mix of done, partly and not applicable, a shortfall finding on each partly
 * answer (one accepted as a risk), and two team findings. `reason` is the long text each answer carries, so a card runs to several pages.
 */
export function fullRecord(content: LoadedContent, reason = 'A long answer the team wrote about this question. '.repeat(6)): DraftRecord {
  const specs: Partial<Record<Stage, StageSpec>> = {};
  for (const st of STAGES) {
    const qs = [...content.questions.values()].filter((q) => q.stage === st).sort((a, b) => a.order - b.order);
    const decisions: SealedDecision[] = [];
    const findings: SealedFinding[] = [];
    qs.forEach((q, i) => {
      if (q.type === 'gate') { decisions.push(decisionOf(content, q.id, null, { scopeAnswer: 'yes' })); return; }
      const status: DecisionStatus = i % 7 === 3 ? 'partly' : i % 11 === 5 ? 'not_applicable' : 'done';
      decisions.push(decisionOf(content, q.id, status, { reason }));
      if (status === 'partly') {
        findings.push(findingOf({ id: `f-${q.id}`, stage: st, source: 'shortfall', questionId: q.id, state: findings.length === 1 ? 'closed_accepted_risk' : 'open', reason: 'Costs more than the study can bear.' }));
      }
    });
    findings.push(findingOf({ id: `f-team-${st}`, stage: st, title: `Labels drift in ${st}`, riskArea: null }));
    specs[st] = { decisions, findings };
  }
  return recordOf(content, specs);
}
