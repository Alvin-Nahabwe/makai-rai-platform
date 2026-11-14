import { describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { DecisionVersionRow, Stage, StoredDecisionStatus } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, UserRef } from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { LoadedContent } from '@/types/content';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { PROJECT_MARK, resolveFields, type DocumentSnapshot, type SealedDecision, type SealedStage } from '@/lib/documents/resolve';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { REVIEW_COPY } from '@/lib/review/copy';

/**
 * What the issued documents print where the app has a word (walk finding S1, item 1), and how a field with several
 * sources prints a gap beside a value (S1, item 2; the owner's decision of 14 November 2026, 22:24 EAT).
 */

const content: LoadedContent = loadContent('0.0.1-fixture');
const dataCardMap: FieldMap = loadFieldMap('data_card');
const modelCardMap: FieldMap = loadFieldMap('model_card');
const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });

interface Spec { status?: StoredDecisionStatus | null; reason?: string; scopeAnswer?: 'yes' | 'no' | 'not_sure' | null }

function sealedDecision(qid: string, s: Spec): SealedDecision {
  const row: DecisionVersionRow = {
    id: `dv-${qid}-1`, orgId: 'o', projectId: 'p', stage: (content.questions.get(qid) as { stage: Stage }).stage, questionId: qid, contentVersionId: 'cv1',
    versionNumber: 1, baseVersionNumber: null, status: s.status === undefined ? 'done' : s.status, scopeAnswer: s.scopeAnswer ?? null,
    optionsInPlace: [], reasonCode: null, reason: s.reason ?? 'A reason.', reasonSalt: null,
    decidedByUserId: 'u-Amina N.', decidedByRole: null, declaredOn: new Date('2026-10-12T00:00:00Z'), declaredPrecision: 'day', withdrawalCode: null,
    enteredById: 'u-enterer', enteredByRole: 'assessor', receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r', requestDigest: 'd', evidenceIds: [],
  };
  return { row, content: CV, enteredBy: user('Amina N.'), decidedBy: { kind: 'member', user: user('Amina N.') }, evidence: [], reasonErased: null };
}

function sealedStage(stage: Stage, n: number, decisions: Map<string, SealedDecision>, role: OrgRole): SealedStage {
  return {
    stage,
    seal: {
      sealId: `seal-${stage}`, sealNumber: n, reviewId: `review-${stage}`, reviewName: `${stage} review 1`,
      fingerprint: 'c0ffee00'.repeat(8), sealedAt: '2026-11-01T09:30:15.000Z', sealedBy: user('Sealer S.'), sealedByRole: role, enteredByPeople: 2,
    },
    preparedFor: null, manifest: {} as never, decisions, derived: new Map(), findings: [],
  };
}

function snapshot(decisions: Record<string, Spec>, over: { metadata?: Record<string, string | null>; sealed?: Stage[]; reviewStage?: Stage; role?: OrgRole } = {}): DocumentSnapshot {
  const sealed = over.sealed ?? [...STAGES];
  const byStage = new Map<Stage, Map<string, SealedDecision>>(STAGES.map((s) => [s, new Map()]));
  for (const [qid, s] of Object.entries(decisions)) { const d = sealedDecision(qid, s); byStage.get(d.row.stage)?.set(qid, d); }
  const stages = Object.fromEntries(STAGES.map((s, i) => [s, sealed.includes(s) ? sealedStage(s, i + 1, byStage.get(s) as Map<string, SealedDecision>, over.role ?? 'owner') : null])) as DocumentSnapshot['stages'];
  const reviewStage = over.reviewStage ?? 'pre-processing';
  return {
    documentType: 'data_card', reviewStage, chosen: stages[reviewStage] as SealedStage, stages, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata: over.metadata ?? {} }, organisationName: 'Org', today: '2026-11-05',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: new Map(), accepted_risks: new Map(), stage_reviews: new Map() },
  };
}

type Resolved = ReturnType<typeof resolveFields>;
const text = (r: Resolved, id: string): string | null => (r.fields.find((f) => f.fieldId === id) as { text: string | null }).text;

describe('item 1: the words the app has, not the stored keys', () => {
  it('MC-03 prints each AI system type as the project form shows it, from the form\'s one table', () => {
    for (const { value, label } of PROJECT_FORM_COPY.aiSystemTypes) {
      if (value === 'other') continue;
      const r = resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: value } }), {});
      expect(text(r, 'MC-03')).toBe(`${label}\n${PROJECT_MARK}`);
    }
    // The walk's case, in so many words.
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'nlp' } }), {}), 'MC-03')).toBe(`Natural language processing\n${PROJECT_MARK}`);
  });

  it('MC-03: "other" prints its companion text, or "Other" with none; a stored value in no table prints as it is stored', () => {
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'other', aiSystemTypeOther: 'Rule-based triage' } }), {}), 'MC-03')).toBe(`Rule-based triage\n${PROJECT_MARK}`);
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'other', aiSystemTypeOther: null } }), {}), 'MC-03')).toBe(`Other\n${PROJECT_MARK}`);
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'other', aiSystemTypeOther: '  ' } }), {}), 'MC-03')).toBe(`Other\n${PROJECT_MARK}`);
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'reinforcement' } }), {}), 'MC-03')).toBe(`reinforcement\n${PROJECT_MARK}`);
    // A key of the table's other properties is not an option.
    expect(text(resolveFields(modelCardMap, snapshot({}, { metadata: { aiSystemType: 'toString' } }), {}), 'MC-03')).toBe(`toString\n${PROJECT_MARK}`);
  });

  it('the seal line prints the sealer\'s role as the app writes it, from the review screens\' one table', () => {
    for (const [role, roleWord] of Object.entries(REVIEW_COPY.roleWords)) {
      const r = resolveFields(dataCardMap, snapshot({ 'Q-PP-12': {} }, { role: role as OrgRole }), {});
      const seals = text(r, 'DC-33') as string;
      expect(seals).toContain(`by Sealer S. (${roleWord}); decisions entered by 2 people.`);
      expect(seals).not.toContain(`(${role})`);
    }
  });
});
