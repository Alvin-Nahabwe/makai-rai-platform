import { describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { DecisionVersionRow, Stage, StoredDecisionStatus } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, UserRef } from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { LoadedContent } from '@/types/content';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import {
  NOT_RECORDED, NOT_RECORDED_AT_ISSUE, NO_EVIDENCE, PROJECT_MARK, TYPED_MARK, resolveFields, type DocumentSnapshot, type SealedDecision, type SealedStage,
} from '@/lib/documents/resolve';
import { noDecisionLine, personalDataAnswerLine } from '@/lib/documents/copy';
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
const stemOf = (id: string) => (content.questions.get(id) as { text: string }).text;

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

describe('item 2: a gap beside a value (the owner\'s decision of 14 November 2026)', () => {
  const lines = (r: Resolved, id: string): string[] => (text(r, id) ?? '').split('\n');
  const typedMark = (t: string) => `${t}\n${TYPED_MARK}`;
  const projectMark = (t: string) => `${t}\n${PROJECT_MARK}`;

  it('DC-05 [typed, project]: an empty typed box beside the project value prints nothing and the field does not count', () => {
    const r = resolveFields(dataCardMap, snapshot({}, { metadata: { datasetSize: 'medium_1k_100k' } }), {});
    expect(text(r, 'DC-05')).toBe(projectMark('1,000 to 100,000 records'));
    expect(r.notRecordedFields).not.toContain('DC-05');
    // An empty project part beside a typed value prints nothing either.
    const typedOnly = resolveFields(dataCardMap, snapshot({}), { 'DC-05': '12,400 visits' });
    expect(text(typedOnly, 'DC-05')).toBe(typedMark('12,400 visits'));
    expect(typedOnly.notRecordedFields).not.toContain('DC-05');
    // Nothing at all: "Not recorded" once, and the field counts.
    const nothing = resolveFields(dataCardMap, snapshot({}), {});
    expect(text(nothing, 'DC-05')).toBe(NOT_RECORDED);
    expect(nothing.notRecordedFields).toContain('DC-05');
  });

  it('DC-13 [typed, record]: a question with no decision beside a typed value prints the sentence naming it, and the field counts', () => {
    const r = resolveFields(dataCardMap, snapshot({}), { 'DC-13': 'January 2024 to June 2026' });
    expect(text(r, 'DC-13')).toBe(`${typedMark('January 2024 to June 2026')}\n${noDecisionLine('Q-PP-20')}`);
    expect(noDecisionLine('Q-PP-20')).toBe('No decision is recorded for question Q-PP-20.');
    expect(r.notRecordedFields).toContain('DC-13');
    // A withdrawn decision is no decision (D1).
    const withdrawn = resolveFields(dataCardMap, snapshot({ 'Q-PP-20': { status: 'withdrawn' } }), { 'DC-13': 'January 2024 to June 2026' });
    expect(lines(withdrawn, 'DC-13')).toContain(noDecisionLine('Q-PP-20'));
    expect(lines(withdrawn, 'DC-13')).not.toContain(NOT_RECORDED);
    expect(withdrawn.notRecordedFields).toContain('DC-13');
    // Typed box empty and no decision: nothing at all, "Not recorded" once.
    const nothing = resolveFields(dataCardMap, snapshot({}), {});
    expect(text(nothing, 'DC-13')).toBe(NOT_RECORDED);
    expect(nothing.notRecordedFields).toContain('DC-13');
  });

  it('MC-12 [typed, record evidence]: an empty typed box beside the question\'s lines prints nothing and the field does not count', () => {
    const r = resolveFields(modelCardMap, snapshot({ 'Q-PP-08': {} }), {});
    expect(text(r, 'MC-12')).toBe(`${stemOf('Q-PP-08')}\n${NO_EVIDENCE}`);
    expect(r.notRecordedFields).not.toContain('MC-12');
  });

  it('DC-23 [record x4, findings]: no decision on any of the four prints "Not recorded" once, then the findings part, and counts', () => {
    const r = resolveFields(dataCardMap, snapshot({}), {});
    expect(text(r, 'DC-23')).toBe(`${NOT_RECORDED}\nNone`);
    expect(r.notRecordedFields).toContain('DC-23');
  });

  it('DC-23: one of several questions decided prints its extract and one sentence for each question with no decision, in its place', () => {
    const r = resolveFields(dataCardMap, snapshot({ 'Q-PP-09': { reason: 'Compared with the census.' } }), {});
    const l = lines(r, 'DC-23');
    expect(l).toContain('Reason: Compared with the census.');
    const at = (s: string) => l.indexOf(s);
    expect(at(noDecisionLine('Q-PP-19'))).toBeGreaterThan(at('Reason: Compared with the census.'));
    expect(at(noDecisionLine('Q-PP-22'))).toBeGreaterThan(at(noDecisionLine('Q-PP-19')));
    expect(at(noDecisionLine('Q-PP-17'))).toBeGreaterThan(at(noDecisionLine('Q-PP-22')));
    expect(l[l.length - 1]).toBe('None');
    expect(l).not.toContain(NOT_RECORDED);
    expect(r.notRecordedFields).toContain('DC-23');
  });

  it('DC-23 with a typed addition and no decision: the typed value is a value, so each question prints its sentence', () => {
    const r = resolveFields(dataCardMap, snapshot({}), { 'DC-23': 'Checked by the district team.' });
    const l = lines(r, 'DC-23');
    for (const q of ['Q-PP-09', 'Q-PP-19', 'Q-PP-22', 'Q-PP-17']) expect(l).toContain(noDecisionLine(q));
    expect(l).not.toContain(NOT_RECORDED);
    expect(text(r, 'DC-23')?.endsWith(typedMark('Checked by the district team.'))).toBe(true);
    expect(r.notRecordedFields).toContain('DC-23');
  });

  it('MC-04 [typed, record of a stage never sealed]: only the never-sealed line, once, and the field counts', () => {
    const snap = snapshot({}, { sealed: ['pre-processing'] });
    const r = resolveFields(modelCardMap, snap, {});
    expect(text(r, 'MC-04')).toBe(NOT_RECORDED_AT_ISSUE);
    expect(r.notRecordedFields).toContain('MC-04');
    const typed = resolveFields(modelCardMap, snap, { 'MC-04': 'Gradient-boosted trees' });
    expect(text(typed, 'MC-04')).toBe(`${typedMark('Gradient-boosted trees')}\n${NOT_RECORDED_AT_ISSUE}`);
    expect(typed.notRecordedFields).toContain('MC-04');
  });

  it('DC-02 [typed, project, project]: an institution with no department and an empty typed box prints the institution alone, and does not count', () => {
    const r = resolveFields(dataCardMap, snapshot({}, { metadata: { institution: 'Makerere', department: null } }), {});
    expect(text(r, 'DC-02')).toBe(projectMark('Makerere'));
    expect(r.notRecordedFields).not.toContain('DC-02');
  });

  it('DC-03 [project] with a typed addition: either one alone is a value and the empty one prints nothing; both empty print "Not recorded" once', () => {
    const project = resolveFields(dataCardMap, snapshot({}, { metadata: { fundingSource: 'GIZ' } }), {});
    expect(text(project, 'DC-03')).toBe(projectMark('GIZ'));
    expect(project.notRecordedFields).not.toContain('DC-03');
    const typed = resolveFields(dataCardMap, snapshot({}), { 'DC-03': 'A university grant' });
    expect(text(typed, 'DC-03')).toBe(typedMark('A university grant'));
    expect(typed.notRecordedFields).not.toContain('DC-03');
    const nothing = resolveFields(dataCardMap, snapshot({}), {});
    expect(text(nothing, 'DC-03')).toBe(NOT_RECORDED);
    expect(nothing.notRecordedFields).toContain('DC-03');
  });

  it('DC-16 [gate scope, record]: the gate answer is a value, so the undecided question prints its sentence after it, and the field counts', () => {
    const r = resolveFields(dataCardMap, snapshot({ 'Q-PP-GATE-SENSITIVE': { status: null, scopeAnswer: 'yes' } }), {});
    const l = lines(r, 'DC-16');
    expect(l.indexOf(noDecisionLine('Q-PP-13'))).toBeGreaterThan(l.indexOf(personalDataAnswerLine('Yes')));
    expect(l).not.toContain(NOT_RECORDED);
    expect(r.notRecordedFields).toContain('DC-16');
  });

  it('a single-source field is unchanged: no decision or an empty box is a null text, and counts', () => {
    const r = resolveFields(dataCardMap, snapshot({}), {});
    expect(text(r, 'DC-01')).toBe(null);
    expect(text(r, 'DC-25')).toBe(null);
    expect(r.notRecordedFields).toEqual(expect.arrayContaining(['DC-01', 'DC-25']));
  });
});
