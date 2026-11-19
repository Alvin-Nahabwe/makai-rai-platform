import { describe, expect, it, vi } from 'vitest';
import type { DecisionStatus, DocumentType, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, FindingView, UserRef } from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { SealManifestV1 } from '@/types/seal';
import { loadContent } from '@/lib/content/loader';
import { controlsForArea } from '@/lib/content/suggestions';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import {
  CONTROLS_AFTER_APPROVAL, DRAFT_PROJECT_MARK, NOT_RECORDED_AT_ISSUE, NOT_RECORDED_YET, NOT_SEALED, PROJECT_MARK, TYPED_AT_ISSUE, draftReviewLine,
} from '@/lib/documents/copy';
import {
  resolveFields, type DocumentSnapshot, type SealedDecision, type SealedFinding, type SnapshotStage,
} from '@/lib/documents/resolve';

/**
 * Field resolution of a draft (path to outputs, Task 5; design §4 anti-goals 1, 2, 3, 5 and §7): the same resolver reads a
 * snapshot whose provenance is a draft, taken from current answers, in place of a seal. Snapshots are built by hand with
 * fixture ids only, over the H0 fixture bundle (the running content of the unit tests).
 */

// The switch for suggested controls is read from the running content (Task 3); a case turns it on for itself.
const flags = vi.hoisted(() => ({ controlsOn: false }));
vi.mock('@/lib/content/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content/loader')>();
  return {
    ...actual,
    runningContent: () => {
      const c = actual.runningContent();
      return flags.controlsOn ? { ...c, controlSuggestionsApproved: true } : c;
    },
  };
});

const content = loadContent('0.0.1-fixture');
const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });
const TAKEN: UtcInstant = '2026-11-19T14:05:09.000Z';
const MAPS: Record<DocumentType, FieldMap> = {
  data_card: loadFieldMap('data_card'), model_card: loadFieldMap('model_card'), mitigation_plan: loadFieldMap('mitigation_plan'),
};

function decision(qid: string, status: DecisionStatus = 'done', reason: string | null = 'A reason.'): SealedDecision {
  const stage = (content.questions.get(qid) as { stage: Stage }).stage;
  return {
    row: {
      id: `dv-${qid}-1`, orgId: 'o', projectId: 'p', stage, questionId: qid, contentVersionId: 'cv1', versionNumber: 1, baseVersionNumber: null,
      status, scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason, reasonSalt: null, decidedByUserId: 'u-Amina N.', decidedByRole: null,
      declaredOn: new Date('2026-10-12T00:00:00Z'), declaredPrecision: 'day', withdrawalCode: null, enteredById: 'u-enterer', enteredByRole: 'assessor',
      receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r', requestDigest: 'd', evidenceIds: [],
    },
    content: CV, enteredBy: user('Amina N.'), decidedBy: { kind: 'member', user: user('Amina N.') }, evidence: [], reasonErased: null,
  };
}

function finding(stage: Stage, riskArea: string): SealedFinding {
  const view: FindingView = {
    id: `f-${stage}-${riskArea}`, projectId: 'p', stage, source: 'team', questionId: null, decisionVersionId: null, riskArea, title: 'Labels drift',
    description: 'Coders disagree.', raisedBy: user('Amina N.'), raisedAt: '2026-10-29T08:00:00.000Z', state: 'open',
    openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0,
  };
  return { finding: view, mitigations: [], acceptedRisk: null, events: [] };
}

interface StageSpec { decisions?: SealedDecision[]; findings?: SealedFinding[]; open?: string; lastSealed?: string }

function draftStage(stage: Stage, s: StageSpec = {}): SnapshotStage {
  const decisions = new Map((s.decisions ?? []).map((d) => [d.row.questionId, d]));
  return {
    stage,
    seal: {
      kind: 'draft', key: `draft:${stage}`, takenAt: TAKEN, enteredByPeople: decisions.size === 0 ? 0 : 1,
      openReview: s.open === undefined ? null : { reviewId: `review-${stage}-open`, reviewName: s.open },
      lastSealedReview: s.lastSealed === undefined ? null : { reviewId: `review-${stage}-sealed`, reviewName: s.lastSealed },
    },
    preparedFor: null,
    manifest: {
      format: 'makrai.seal/1', content: { semver: '0.0.1-fixture', contentHash: 'h' }, decisions: [...decisions.keys()].map((question) => ({ question })),
    } as unknown as SealManifestV1,
    decisions, derived: new Map(), findings: s.findings ?? [],
  };
}

function base(documentType: DocumentType, reviewStage: Stage, metadata: Record<string, string | null>) {
  return {
    documentType, reviewStage, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata }, organisationName: 'Org', today: '2026-11-19',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: new Map(), accepted_risks: new Map(), stage_reviews: new Map() },
  } as const;
}

/** A draft: every stage present (a stage with no answers is an empty stage, never null). */
function draft(documentType: DocumentType, reviewStage: Stage, stages: Partial<Record<Stage, StageSpec>> = {}, metadata: Record<string, string | null> = {}): DocumentSnapshot {
  const all = Object.fromEntries(STAGES.map((st) => [st, draftStage(st, stages[st])])) as Record<Stage, SnapshotStage>;
  return { ...base(documentType, reviewStage, metadata), provenance: { kind: 'draft', takenAt: TAKEN, omittedAnswers: 0 }, chosen: all[reviewStage], stages: all };
}

/** The same rows as a sealed snapshot: each listed stage sealed, the others never sealed (null). */
function sealed(documentType: DocumentType, reviewStage: Stage, stages: Partial<Record<Stage, StageSpec>>, metadata: Record<string, string | null> = {}): DocumentSnapshot {
  const all = Object.fromEntries(STAGES.map((st, i) => {
    const s = stages[st];
    if (s === undefined) return [st, null];
    const d = draftStage(st, s);
    return [st, {
      ...d,
      seal: {
        kind: 'sealed', sealId: `seal-${st}`, sealNumber: i + 1, reviewId: `review-${st}`, reviewName: `Review of ${st}`, fingerprint: 'c0ffee00'.repeat(8),
        sealedAt: '2026-11-01T09:30:15.000Z', sealedBy: user('Sealer S.'), sealedByRole: 'owner', enteredByPeople: 1,
      },
    }];
  })) as Record<Stage, SnapshotStage | null>;
  return { ...base(documentType, reviewStage, metadata), provenance: { kind: 'sealed' }, chosen: all[reviewStage] as SnapshotStage, stages: all };
}

type Resolved = ReturnType<typeof resolveFields>;
const text = (r: Resolved, id: string): string | null => {
  const f = r.fields.find((x) => x.fieldId === id);
  if (f === undefined) throw new Error(`no field ${id}`);
  return f.text;
};
/** An issued field's text as a draft prints it: the same, with the draft's project mark in place of the issued one (anti-goal 1). */
const asDraft = (t: string | null): string | null => (t === null ? null : t.split(PROJECT_MARK).join(DRAFT_PROJECT_MARK));

describe('a draft document resolves through the sealed resolver (path to outputs, Task 5)', () => {
  it('D3 amended: in a draft, a record field of a stage with no answers reads Not recorded yet, once, and is listed in notRecordedFields', () => {
    const r = resolveFields(MAPS.data_card, draft('data_card', 'pre-processing'), {});
    expect(text(r, 'DC-01')).toBe(NOT_RECORDED_YET);
    // DC-19 reads two questions of the stage: the line prints once, not once a part.
    expect(text(r, 'DC-19')).toBe(NOT_RECORDED_YET);
    // DC-23 adds a findings part of the same stage beside four record parts: still once.
    expect(text(r, 'DC-23')).toBe(NOT_RECORDED_YET);
    expect(r.notRecordedFields).toEqual(expect.arrayContaining(['DC-01', 'DC-19', 'DC-23']));
    expect(r.fields.map((f) => f.text).join('\n')).not.toContain(NOT_RECORDED_AT_ISSUE);
  });

  it('D3: the sealed path still prints NOT_RECORDED_AT_ISSUE for a never-sealed stage', () => {
    const r = resolveFields(MAPS.model_card, sealed('model_card', 'in-processing', { 'in-processing': { decisions: [decision('Q-IP-01')] } }), {});
    expect(text(r, 'MC-28')).toBe(NOT_RECORDED_AT_ISSUE);
    expect(r.notRecordedFields).toContain('MC-28');
    expect(r.fields.map((f) => f.text).join('\n')).not.toContain(NOT_RECORDED_YET);
  });

  it('a pure typed field and an unanswered mixed typed field read Added when the document is issued; a mixed field with a value prints the value alone', () => {
    const answered = { 'pre-processing': { decisions: [decision('Q-PP-08')] } };
    // Typed values handed to a draft are never read: a draft shows what the document will ask for, not a draft of it.
    const typed = { 'DC-08': 'Typed labels', 'DC-02': 'Typed creators', 'DC-13': 'Typed period', 'DC-15:state': 'Approved' };
    const r = resolveFields(MAPS.data_card, draft('data_card', 'pre-processing', answered, { institution: 'Makerere' }), typed);
    expect(text(r, 'DC-08')).toBe(TYPED_AT_ISSUE);                    // pure typed
    expect(text(r, 'DC-15')).toBe(TYPED_AT_ISSUE);                    // the structured ethics field
    expect(text(r, 'DC-13')).toBe(TYPED_AT_ISSUE);                    // typed beside Q-PP-20, which has no answer
    expect(r.notRecordedFields).toEqual(expect.arrayContaining(['DC-08', 'DC-13', 'DC-15']));
    // DC-02: typed beside the project's institution, which holds a value: the value alone, as the sealed field with nothing typed.
    const issued = resolveFields(MAPS.data_card, sealed('data_card', 'pre-processing', answered, { institution: 'Makerere' }), {});
    expect(text(r, 'DC-02')).toBe(asDraft(text(issued, 'DC-02')));
    expect(text(r, 'DC-02')).toContain('Makerere');
    expect(text(r, 'DC-02')).not.toContain(TYPED_AT_ISSUE);
    // DC-13 answered: the decision alone.
    const withPeriod = { 'pre-processing': { decisions: [decision('Q-PP-08'), decision('Q-PP-20', 'done', 'Collected 2024 to 2025.')] } };
    const r2 = resolveFields(MAPS.data_card, draft('data_card', 'pre-processing', withPeriod), typed);
    expect(text(r2, 'DC-13')).toBe(text(resolveFields(MAPS.data_card, sealed('data_card', 'pre-processing', withPeriod), {}), 'DC-13'));
    expect(text(r2, 'DC-13')).toContain('Collected 2024 to 2025.');
    expect(text(r2, 'DC-13')).not.toContain(TYPED_AT_ISSUE);
    // MC-04: typed beside Q-IP-01, unanswered, then answered.
    const mc = resolveFields(MAPS.model_card, draft('model_card', 'in-processing', { 'in-processing': { decisions: [decision('Q-IP-02')] } }), { 'MC-04': 'Typed' });
    expect(text(mc, 'MC-04')).toBe(TYPED_AT_ISSUE);
    const mcAnswered = resolveFields(MAPS.model_card, draft('model_card', 'in-processing', { 'in-processing': { decisions: [decision('Q-IP-01', 'done', 'A transformer.')] } }), {});
    expect(text(mcAnswered, 'MC-04')).toContain('A transformer.');
    expect(text(mcAnswered, 'MC-04')).not.toContain(TYPED_AT_ISSUE);
  });

  it('anti-goal 1: a project value in a draft carries the draft mark, never the issued mark that calls it part of a sealed record', () => {
    const metadata = { institution: 'Makerere', fundingSource: 'A national fund', aiSystemType: 'other', aiSystemTypeOther: 'Rules engine' };
    const st = { 'pre-processing': { decisions: [decision('Q-PP-08')] }, 'in-processing': { decisions: [decision('Q-IP-01')] } };
    const composed = (['data_card', 'model_card'] as const).flatMap((type) => {
      const r = resolveFields(MAPS[type], draft(type, type === 'data_card' ? 'pre-processing' : 'in-processing', st, metadata), {});
      return r.fields.map((f) => f.text ?? '');
    }).join('\n');
    expect(composed).toContain('Makerere');
    expect(composed).toContain(DRAFT_PROJECT_MARK);
    expect(composed).not.toContain(PROJECT_MARK);
    expect(composed).not.toMatch(/on the day of issue|part of the sealed record/);
    // The issued path is unchanged: the same project value carries today's mark.
    const issued = resolveFields(MAPS.data_card, sealed('data_card', 'pre-processing', st, metadata), {});
    expect(text(issued, 'DC-03')).toBe(`A national fund\n${PROJECT_MARK}`);
    expect(issued.fields.map((f) => f.text ?? '').join('\n')).not.toContain(DRAFT_PROJECT_MARK);
  });

  it('a typed-addition field in a draft resolves exactly as the sealed field with no typed values, answered and unanswered', () => {
    const typed = { 'DC-03': 'Typed funder', 'DC-09': 'Typed note', 'MC-03': 'Typed type' };
    const answeredProject: Record<string, string | null> = { fundingSource: 'A national fund', aiSystemType: 'other', aiSystemTypeOther: 'Rules engine' };
    for (const metadata of [answeredProject, {}]) {
      for (const decisions of [[decision('Q-PP-16')], [decision('Q-PP-08')]]) {
        const st = { 'pre-processing': { decisions }, 'in-processing': { decisions: [decision('Q-IP-01')] } };
        const dc = resolveFields(MAPS.data_card, draft('data_card', 'pre-processing', st, metadata), typed);
        const dcIssued = resolveFields(MAPS.data_card, sealed('data_card', 'pre-processing', st, metadata), {});
        for (const id of ['DC-03', 'DC-09']) expect(text(dc, id)).toBe(asDraft(text(dcIssued, id)));
        const mc = resolveFields(MAPS.model_card, draft('model_card', 'in-processing', st, metadata), typed);
        const mcIssued = resolveFields(MAPS.model_card, sealed('model_card', 'in-processing', st, metadata), {});
        expect(text(mc, 'MC-03')).toBe(asDraft(text(mcIssued, 'MC-03')));
        expect([text(dc, 'DC-03'), text(dc, 'DC-09'), text(mc, 'MC-03')].join('\n')).not.toContain(TYPED_AT_ISSUE);
      }
    }
  });

  it('MP-10, DC-33 and MC-31 read Not sealed, and no draft text holds a fingerprint', () => {
    const st = { 'pre-processing': { decisions: [decision('Q-PP-08')], findings: [finding('pre-processing', 'PP-02')] }, 'in-processing': { decisions: [decision('Q-IP-01')] } };
    const all: string[] = [];
    for (const [type, stage, id] of [['data_card', 'pre-processing', 'DC-33'], ['model_card', 'in-processing', 'MC-31'], ['mitigation_plan', 'pre-processing', 'MP-10']] as const) {
      const r = resolveFields(MAPS[type], draft(type, stage, st), {});
      expect(text(r, id)).toBe(NOT_SEALED);
      all.push(...r.fields.map((f) => f.text ?? ''), ...r.fields.map((f) => f.provenance));
    }
    expect(all.join('\n')).not.toMatch(/Fingerprint|[0-9a-f]{4} [0-9a-f]{4}/);
  });

  it('MP-01 reads "Pre-processing · draft, no review yet", and with an open review "Pre-processing · draft, Pre-processing review 1 open, not sealed yet"', () => {
    const mp01 = (s: StageSpec) => text(resolveFields(MAPS.mitigation_plan, draft('mitigation_plan', 'pre-processing', { 'pre-processing': s }), {}), 'MP-01');
    expect(mp01({ decisions: [decision('Q-PP-08')] })).toBe('Pre-processing · draft, no review yet');
    expect(mp01({ decisions: [decision('Q-PP-08')], open: 'Pre-processing review 1' })).toBe('Pre-processing · draft, Pre-processing review 1 open, not sealed yet');
    // Every review of the stage sealed (controller's ruling O2): it names the last one, never "no review yet".
    expect(mp01({ decisions: [decision('Q-PP-08')], lastSealed: 'Pre-processing review 1' })).toBe('Pre-processing · draft; last sealed review: Pre-processing review 1');
    // A review open after an earlier sealed one: the open one is the news.
    expect(mp01({ open: 'Pre-processing review 2', lastSealed: 'Pre-processing review 1' })).toBe('Pre-processing · draft, Pre-processing review 2 open, not sealed yet');
    expect(draftReviewLine('In-processing', null, null)).toBe('In-processing · draft, no review yet');
  });

  it('MP-04 prints CONTROLS_AFTER_APPROVAL while controls are off, and the control list when on', () => {
    const names = controlsForArea(content, 'PP-02').flatMap((g) => g.controls.map((c) => `${c.control.id} ${c.control.name}`));
    expect(names.length).toBeGreaterThan(0);   // a floor: an empty list would make the "on" case vacuous
    const snap = () => draft('mitigation_plan', 'pre-processing', { 'pre-processing': { decisions: [decision('Q-PP-08')], findings: [finding('pre-processing', 'PP-02')] } });
    flags.controlsOn = false;
    expect(text(resolveFields(MAPS.mitigation_plan, snap(), {}), 'MP-04')).toBe(CONTROLS_AFTER_APPROVAL);
    // An issued plan keeps today's behaviour: its controls print whatever the switch says.
    const issued = text(resolveFields(MAPS.mitigation_plan, sealed('mitigation_plan', 'pre-processing', { 'pre-processing': { findings: [finding('pre-processing', 'PP-02')] } }), {}), 'MP-04') as string;
    for (const n of names) expect(issued).toContain(n);
    flags.controlsOn = true;
    try {
      const on = text(resolveFields(MAPS.mitigation_plan, snap(), {}), 'MP-04') as string;
      expect(on).not.toBe(CONTROLS_AFTER_APPROVAL);
      for (const n of names) expect(on).toContain(n);
    } finally {
      flags.controlsOn = false;
    }
  });

  it('resolveFields on a draft returns sealIds []', () => {
    const st = { 'pre-processing': { decisions: [decision('Q-PP-08')] }, 'in-processing': { decisions: [decision('Q-IP-01')] }, 'post-processing': { decisions: [decision('Q-PO-01')] } };
    for (const [type, stage] of [['data_card', 'pre-processing'], ['model_card', 'in-processing'], ['mitigation_plan', 'post-processing']] as const) {
      expect(resolveFields(MAPS[type], draft(type, stage, st), {}).sealIds).toEqual([]);
    }
  });

  it('an empty chosen stage resolves without throwing', () => {
    for (const [type, stage] of [['data_card', 'pre-processing'], ['model_card', 'in-processing'], ['mitigation_plan', 'post-processing']] as const) {
      const r = resolveFields(MAPS[type], draft(type, stage), {});
      expect(r.fields.length).toBe(MAPS[type].fields.length);
    }
    const mp = resolveFields(MAPS.mitigation_plan, draft('mitigation_plan', 'post-processing'), {});
    expect(text(mp, 'MP-01')).toBe('Post-processing · draft, no review yet');
    expect(text(mp, 'MP-10')).toBe(NOT_SEALED);
  });

  it('a snapshot whose stages disagree with its provenance is refused, never resolved', () => {
    const d = draft('data_card', 'pre-processing', { 'pre-processing': { decisions: [decision('Q-PP-08')] } });
    const s = sealed('data_card', 'pre-processing', { 'pre-processing': { decisions: [decision('Q-PP-08')] } });
    // A draft holding a sealed stage would read a seal (design §7: drafts never do); a sealed snapshot holding a draft stage would issue one (anti-goal 5).
    expect(() => resolveFields(MAPS.data_card, { ...d, stages: { ...d.stages, 'in-processing': s.stages['pre-processing'] } }, {})).toThrow(/provenance/);
    expect(() => resolveFields(MAPS.data_card, { ...s, chosen: d.chosen, stages: { ...s.stages, 'pre-processing': d.chosen } }, {})).toThrow(/provenance/);
  });
});
