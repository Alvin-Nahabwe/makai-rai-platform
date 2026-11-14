import { describe, expect, it } from 'vitest';
import type { CalendarDate, MitigationKind, MitigationStatus, ScopeAnswer, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { FindingView, MitigationVersionView, UserRef } from '@/types/api';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { CLOSED_NO_LONGER_APPLIES, closedByLine, textErasedLine } from '@/lib/documents/copy';
import { resolveFields, type DocumentSnapshot, type SealedDecision, type SealedStage } from '@/lib/documents/resolve';
import { FINDINGS_COPY } from '@/lib/findings/copy';

/**
 * How a closed finding and its closing record print (the coordinator's rulings of 14 November 2026, 21:45 EAT, and the lane
 * lead's readings of the same day). A closing record is the row `closeByDecision` writes: kind decision_changed or
 * decision_withdrawn, version 1, done, no text and no tombstone on it. It is not a mitigation: it prints as one line under its
 * finding, "Closed by <who entered it> on <the UTC day it was received>.", then the cause the record supports, or none.
 * Snapshots by hand, fixture ids only.
 */

const content = loadContent('0.0.1-fixture');
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });
const CHANGED = FINDINGS_COPY.mitigation.closedBecauseDecisionChanged;
const WITHDRAWN = FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn;
const GATE = 'Q-PP-GATE-SENSITIVE';

interface M {
  id: string; seq: number; kind?: MitigationKind; v?: number; status?: MitigationStatus; what?: string | null; owner?: string; by?: string;
  at?: UtcInstant; due?: CalendarDate; closes?: string | null;
}
interface F {
  id: string; questionId: string; state: FindingView['state']; mitigations?: M[]; reopenedAt?: number[]; riskArea?: string | null;
}
interface D { questionId: string; id: string; scope?: ScopeAnswer | null; status?: SealedDecision['row']['status'] }

function mitigation(findingId: string, m: M): MitigationVersionView {
  const kind = m.kind ?? 'action';
  return {
    id: m.id, findingId, mitigationId: `m-${m.id}`, versionNumber: m.v ?? 1, baseVersionNumber: (m.v ?? 1) > 1 ? (m.v ?? 1) - 1 : null,
    what: m.what === undefined ? (kind === 'action' ? 'Second coder' : null) : m.what, changeNote: null,
    owner: user(m.owner ?? m.by ?? 'Asha Assessor'), dueDate: m.due ?? '2026-11-14', status: m.status ?? 'done', kind, followsControl: null,
    closureNote: null, closureDecisionVersionId: m.closes === undefined ? null : m.closes, cancelReason: null,
    enteredBy: user(m.by ?? 'Asha Assessor'), enteredByRole: 'assessor', findingSeq: m.seq, receivedAt: m.at ?? '2026-11-14T10:00:00.000Z',
    evidence: [], erasedFields: [],
  };
}

function decision(d: D, stage: Stage): SealedDecision {
  return {
    row: {
      id: d.id, orgId: 'o', projectId: 'p', stage, questionId: d.questionId, contentVersionId: 'cv1', versionNumber: 2, baseVersionNumber: 1,
      status: d.status ?? 'done', scopeAnswer: d.scope ?? null, optionsInPlace: [], reasonCode: null, reason: 'Done now.', reasonSalt: null,
      decidedByUserId: null, decidedByRole: null, declaredOn: null, declaredPrecision: null, withdrawalCode: null, enteredById: 'u-enterer',
      enteredByRole: 'assessor', receivedAt: new Date('2026-11-14T09:00:00Z'), requestId: 'r', requestDigest: 'd', evidenceIds: [],
    },
    content: { contentVersionId: 'cv1', semver: '0.0.1-fixture' } as never, enteredBy: user('Asha Assessor'), decidedBy: null, evidence: [], reasonErased: null,
  };
}

function sealed(stage: Stage, findings: F[], decisions: D[]): SealedStage {
  return {
    stage,
    seal: {
      sealId: `seal-${stage}`, sealNumber: 1, reviewId: `review-${stage}`, reviewName: 'Review 1', fingerprint: 'c0ffee00'.repeat(8),
      sealedAt: '2026-11-14T19:00:00.000Z', sealedBy: user('Olive Owner'), sealedByRole: 'owner', enteredByPeople: 2,
    },
    preparedFor: null,
    manifest: { format: 'makrai.seal/1', content: { semver: '0.0.1-fixture', contentHash: 'h' }, decisions: [] } as never,
    decisions: new Map(decisions.map((d) => [d.questionId, decision(d, stage)])), derived: new Map(),
    findings: findings.map((f) => ({
      finding: {
        id: f.id, projectId: 'p', stage, source: 'shortfall', questionId: f.questionId, decisionVersionId: null, riskArea: f.riskArea ?? null,
        title: null, description: null, raisedBy: user('Asha Assessor'), raisedAt: '2026-11-14T08:00:00.000Z', state: f.state,
        openMitigations: 0, hasNoMitigation: false, overdueMitigations: 0,
      },
      mitigations: (f.mitigations ?? []).map((m) => mitigation(f.id, m)),
      acceptedRisk: null,
      events: (f.reopenedAt ?? []).map((seq) => ({
        id: `ev-${f.id}-${seq}`, findingId: f.id, kind: 'reopened' as const, eventCode: null, reason: 'Again.', by: user('Olive Owner'),
        at: '2026-11-14T11:00:00.000Z', findingSeq: seq,
      })),
    })),
  };
}

interface Opts { decisions?: D[]; other?: { stage: Stage; decisions: D[] }; erased?: string[] }
function snap(documentType: DocumentSnapshot['documentType'], stage: Stage, findings: F[], o: Opts = {}): DocumentSnapshot {
  const chosen = sealed(stage, findings, o.decisions ?? []);
  const stages = Object.fromEntries(STAGES.map((x) => [x, x === stage ? chosen : o.other?.stage === x ? sealed(x, [], o.other.decisions) : null])) as DocumentSnapshot['stages'];
  return {
    documentType, reviewStage: stage, chosen, stages, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: '2026-11-14',
    erasures: {
      evidence: new Map(), findings: new Map(), accepted_risks: new Map(), stage_reviews: new Map(),
      mitigation_versions: new Map((o.erased ?? []).map((id) => [id, new Map([['what', '2026-11-14']])])),
    },
  };
}

const mp = loadFieldMap('mitigation_plan');
const mc = loadFieldMap('model_card');
const dc = loadFieldMap('data_card');
const fieldText = (r: ReturnType<typeof resolveFields>, id: string) => r.fields.find((x) => x.fieldId === id)?.text ?? null;
const plan = (findings: F[], o?: Opts) => resolveFields(mp, snap('mitigation_plan', 'pre-processing', findings, o), {});
const card = (findings: F[], o?: Opts) => resolveFields(mc, snap('model_card', 'in-processing', findings, o), {});

// The walk's mitigation plan (issued 14 Nov 2026 22:17 EAT), as a snapshot.
const WALK: F[] = [
  { id: 'f-08', questionId: 'Q-PP-08', state: 'open', mitigations: [
    { id: 'mv-08a', seq: 1, what: 'Write the data source register and file it with the ethics application.', owner: 'Olive Owner', due: '2027-01-15', status: 'planned' },
    { id: 'mv-08b', seq: 2, kind: 'decision_changed', closes: 'dv-08' },
  ] },
  { id: 'f-03', questionId: 'Q-PP-03', state: 'closed_mitigation', mitigations: [
    { id: 'mv-03', seq: 1, what: 'Hold two listening sessions.', due: '2026-11-30' },
  ] },
  { id: 'f-04', questionId: 'Q-PP-04', state: 'closed_mitigation', mitigations: [{ id: 'mv-04', seq: 1, kind: 'decision_withdrawn', closes: 'dv-04' }] },
  { id: 'f-13', questionId: 'Q-PP-13', state: 'closed_mitigation', mitigations: [{ id: 'mv-13', seq: 1, kind: 'decision_changed', closes: 'dv-13' }] },
];
const WALK_DECISIONS: D[] = [{ questionId: 'Q-PP-08', id: 'dv-08' }, { questionId: 'Q-PP-04', id: 'dv-04', status: 'withdrawn' }, { questionId: 'Q-PP-13', id: 'dv-13' }];
const walk = () => plan(WALK, { decisions: WALK_DECISIONS });

describe('a closing record is not a mitigation (ruling 1)', () => {
  it('MP-02 does not count a closing record among the mitigations', () => {
    expect(fieldText(walk(), 'MP-02')).toBe([
      'Open findings: 1. Closed by a mitigation: 1. Closed by an accepted risk: 0. Closed: 2.',
      'Mitigations planned: 1, in progress: 0, done: 1, cancelled: 0, overdue: 0.',
    ].join('\n'));
  });

  it('MP-05 lists only the real done mitigations after the findings', () => {
    const t = fieldText(walk(), 'MP-05') as string;
    expect(t.endsWith(`${CHANGED}\n1. Hold two listening sessions.\nFinding: Finding on Q-PP-03\nAssigned to: Asha Assessor\nDue: 30 Nov 2026`)).toBe(true);
    expect(t).not.toMatch(/^\d+\. Closed because/m);
    expect(t).not.toContain('Due: 14 Nov 2026');
  });

  it('MC-24 leaves a closing record out of the done mitigations, and prints None when nothing else is done', () => {
    const t = fieldText(card([{ id: 'f-1', questionId: 'Q-IP-05', state: 'closed_mitigation', riskArea: 'IP-01', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-1' }] }],
      { decisions: [{ questionId: 'Q-IP-05', id: 'dv-1' }] }), 'MC-24') as string;
    expect(t).not.toContain(CHANGED);
    expect(t).not.toContain('Assigned to');
    // MC-24 is the done mitigations, then question Q-IP-15 (undecided here, so "Not recorded").
    expect(t).toBe('None\nNot recorded');
  });
});

describe('the closing line under its finding (rulings 2 and 3)', () => {
  it('"Closed by <who entered it> on <day>." then "Closed because the decision was withdrawn." for a withdrawal', () => {
    const t = fieldText(walk(), 'MP-05') as string;
    expect(t).toContain('2. Finding on Q-PP-04\nSource: From question Q-PP-04\nRisk area: none\nStatus: Closed\nClosed by Asha Assessor on 14 Nov 2026.\nClosed because the decision was withdrawn.');
  });

  it('a change of the finding\'s own question prints "Closed because the decision changed."', () => {
    expect(fieldText(walk(), 'MP-05')).toContain(`3. Finding on Q-PP-13\nSource: From question Q-PP-13\nRisk area: none\nStatus: Closed\n${closedByLine('Asha Assessor', '14 Nov 2026')}\n${CHANGED}`);
  });

  it('a version of another question answering No prints the "no longer applies" sentence (the gate case)', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', by: 'Joan K.', closes: 'dv-gate' }] }],
      { decisions: [{ questionId: GATE, id: 'dv-gate', scope: 'no' }] }), 'MP-05');
    expect(t).toBe(`1. Finding on Q-PP-01\nSource: From question Q-PP-01\nRisk area: none\nStatus: Closed\nClosed by Joan K. on 14 Nov 2026.\n${CLOSED_NO_LONGER_APPLIES}`);
    expect(CLOSED_NO_LONGER_APPLIES).toBe('Closed because this question no longer applies: the team answered No to the personal data question.');
  });

  it('a version that the snapshot does not hold prints the closing line with no cause sentence', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-gone' }] }],
      { decisions: [{ questionId: 'Q-PP-01', id: 'dv-later' }] }), 'MP-05');
    expect(t).toBe('1. Finding on Q-PP-01\nSource: From question Q-PP-01\nRisk area: none\nStatus: Closed\nClosed by Asha Assessor on 14 Nov 2026.');
  });
});

describe('the finding\'s status (ruling 4) and an open finding (ruling 5)', () => {
  it('"Closed" for a finding closed with no real done mitigation; "Closed by a mitigation" for one closed by a real one', () => {
    const t = fieldText(walk(), 'MP-05') as string;
    expect(t).toContain('1. Finding on Q-PP-03\nSource: From question Q-PP-03\nRisk area: none\nStatus: Closed by a mitigation\n\n2. ');
    expect(t).toContain('Q-PP-04\nRisk area: none\nStatus: Closed\n');
  });

  it('the plan\'s section for these findings keeps the field map\'s name "Findings closed by a mitigation" (listed for the coordinator)', () => {
    expect(walk().fields.find((f) => f.fieldId === 'MP-05')?.section).toBe('Findings closed by a mitigation');
  });

  it('an open finding holding a closing record prints Status: Open, its real mitigations only, and nothing that says closed', () => {
    const r = walk();
    const t = fieldText(r, 'MP-03') as string;
    expect(t).toBe([
      '1. Finding on Q-PP-08\nSource: From question Q-PP-08\nRisk area: none\nRaised on: 14 Nov 2026\nStatus: Open',
      '1. Finding on Q-PP-08\nMitigation 1: Write the data source register and file it with the ethics application.\nAssigned to: Olive Owner\nDue: 15 Jan 2027\nStatus: Planned',
    ].join('\n'));
    expect(t).not.toMatch(/Closed/);
  });

  it('an open finding whose only mitigation is a closing record prints "Mitigations: None"', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'open', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-1' }] }],
      { decisions: [{ questionId: 'Q-PP-01', id: 'dv-1' }] }), 'MP-03') as string;
    expect(t.split('\n').slice(-2)).toEqual(['1. Finding on Q-PP-01', 'Mitigations: None']);
    expect(t).not.toMatch(/Closed/);
  });

  it('a finding closed by a real done mitigation prints exactly as it does today', () => {
    const r = plan([{ id: 'f-1', questionId: 'Q-PP-03', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, what: 'Hold two listening sessions.', due: '2026-11-30' }] }]);
    expect(fieldText(r, 'MP-05')).toBe([
      '1. Finding on Q-PP-03\nSource: From question Q-PP-03\nRisk area: none\nStatus: Closed by a mitigation',
      '1. Hold two listening sessions.\nFinding: Finding on Q-PP-03\nAssigned to: Asha Assessor\nDue: 30 Nov 2026',
    ].join('\n'));
    expect(fieldText(r, 'MP-02')).toBe('Open findings: 0. Closed by a mitigation: 1. Closed by an accepted risk: 0.\nMitigations planned: 0, in progress: 0, done: 1, cancelled: 0, overdue: 0.');
  });
});

describe('a closing-kind row that is not a closing record takes the ordinary path (ruling 6, reading 1)', () => {
  it('version 2 of a decision-kind row prints as an ordinary mitigation and is counted', () => {
    const r = plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 2, v: 2, kind: 'decision_changed', what: 'Rechecked the labels.', closes: 'dv-1' }] }],
      { decisions: [{ questionId: 'Q-PP-01', id: 'dv-1' }] });
    const t = fieldText(r, 'MP-05') as string;
    expect(t).toContain('\n1. Rechecked the labels.\nFinding: Finding on Q-PP-01\nAssigned to: Asha Assessor\nDue: 14 Nov 2026');
    expect(t).not.toContain('Closed by Asha');
    expect(fieldText(r, 'MP-02')).toContain('done: 1,');
  });

  it('a version 1 decision-kind row with text prints its text; with a tombstone prints the erasure line', () => {
    const withText = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_withdrawn', what: 'Recheck', closes: 'dv-1' }] }]), 'MP-05') as string;
    expect(withText).toContain('\n1. Recheck\nFinding: Finding on Q-PP-01');
    expect(withText).not.toContain('Closed by Asha');
    const erased = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-1' }] }], { erased: ['mv-1'] }), 'MP-05') as string;
    expect(erased).toContain(`\n1. ${textErasedLine('2026-11-14')}\nFinding: Finding on Q-PP-01`);
    expect(erased).not.toContain('Closed by Asha');
  });

  it('a version 1 decision-kind row that is not done, with no text and no tombstone, still throws', () => {
    expect(() => plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'open', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', status: 'in_progress', closes: 'dv-1' }] }]))
      .toThrow('documents: mitigation_versions mv-1 has no what and no tombstone for it');
  });
});

describe('the lead\'s readings 2 to 7', () => {
  it('reading 2: the day is the UTC day of the instant the record was received', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-04', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_withdrawn', at: '2026-11-14T22:30:00.000Z', closes: 'dv-1' }] }]), 'MP-05');
    expect(t).toContain('Closed by Asha Assessor on 14 Nov 2026.\nClosed because the decision was withdrawn.');
  });

  it('reading 3: another question\'s version answering anything but No prints no cause sentence', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-gate' }] }],
      { decisions: [{ questionId: GATE, id: 'dv-gate', scope: 'yes' }] }), 'MP-05') as string;
    expect(t.endsWith('Status: Closed\nClosed by Asha Assessor on 14 Nov 2026.')).toBe(true);
  });

  it('reading 3: the gate\'s version is found in another sealed stage of the snapshot', () => {
    const t = fieldText(card([{ id: 'f-1', questionId: 'Q-IP-05', state: 'closed_mitigation', riskArea: 'IP-01', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-gate' }] }],
      { other: { stage: 'pre-processing', decisions: [{ questionId: GATE, id: 'dv-gate', scope: 'no' }] } }), 'MC-23');
    expect(t).toContain(`Status: Closed\nClosed by Asha Assessor on 14 Nov 2026.\n${CLOSED_NO_LONGER_APPLIES}`);
  });

  it('reading 4: closed, reopened, then closed by a decision: status Closed, and only the record after the latest reopen', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', reopenedAt: [3], mitigations: [
      { id: 'mv-a', seq: 1, what: 'Second coder' },
      { id: 'mv-b', seq: 2, kind: 'decision_withdrawn', by: 'Early E.', closes: 'dv-old' },
      { id: 'mv-c', seq: 4, kind: 'decision_changed', by: 'Late L.', at: '2026-11-15T07:00:00.000Z', closes: 'dv-1' },
    ] }], { decisions: [{ questionId: 'Q-PP-01', id: 'dv-1' }] }), 'MP-05') as string;
    expect(t).toContain(`Status: Closed\nClosed by Late L. on 15 Nov 2026.\n${CHANGED}\n1. Second coder`);
    expect(t).not.toContain('Early E.');
  });

  it('reading 4: a real done mitigation after the latest reopen makes it "Closed by a mitigation"', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', reopenedAt: [2], mitigations: [
      { id: 'mv-b', seq: 1, kind: 'decision_withdrawn', closes: 'dv-old' }, { id: 'mv-a', seq: 3, what: 'Second coder' },
    ] }]), 'MP-05') as string;
    expect(t).toContain('Status: Closed by a mitigation\n1. Second coder');
    expect(t).not.toContain('Closed because');
  });

  it('reading 4: several records after the latest reopen print oldest first', () => {
    const t = fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'closed_mitigation', mitigations: [
      { id: 'mv-2', seq: 5, kind: 'decision_changed', by: 'Second S.', closes: 'dv-gate' },
      { id: 'mv-1', seq: 2, kind: 'decision_withdrawn', by: 'First F.', closes: 'dv-1' },
    ] }], { decisions: [{ questionId: GATE, id: 'dv-gate', scope: 'no' }] }), 'MP-05') as string;
    expect(t).toContain(`Status: Closed\nClosed by First F. on 14 Nov 2026.\n${WITHDRAWN}\nClosed by Second S. on 14 Nov 2026.\n${CLOSED_NO_LONGER_APPLIES}`);
  });

  it('reading 5: MP-02 adds "Closed: N." only when a finding prints Closed', () => {
    expect(fieldText(walk(), 'MP-02')?.split('\n')[0]).toBe('Open findings: 1. Closed by a mitigation: 1. Closed by an accepted risk: 0. Closed: 2.');
    expect(fieldText(plan([{ id: 'f-1', questionId: 'Q-PP-01', state: 'open' }]), 'MP-02')?.split('\n')[0]).toBe('Open findings: 1. Closed by a mitigation: 0. Closed by an accepted risk: 0.');
  });

  it('reading 6: the line sits under the status line in the data card (DC-23) and the model card (MC-23)', () => {
    const one = (riskArea: string): F[] => [{ id: 'f-1', questionId: 'Q-PP-04', state: 'closed_mitigation', riskArea, mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_withdrawn', closes: 'dv-1' }] }];
    const dct = fieldText(resolveFields(dc, snap('data_card', 'pre-processing', one('PP-02')), {}), 'DC-23');
    expect(dct).toContain(`Status: Closed\nClosed by Asha Assessor on 14 Nov 2026.\n${WITHDRAWN}`);
    expect(fieldText(card(one('IP-01')), 'MC-23')).toContain(`Status: Closed\nClosed by Asha Assessor on 14 Nov 2026.\n${WITHDRAWN}`);
  });

  it('reading 6: MP-05 with no real done mitigation left prints the findings only', () => {
    const t = fieldText(plan([WALK[2]], { decisions: WALK_DECISIONS }), 'MP-05');
    expect(t).toBe(`1. Finding on Q-PP-04\nSource: From question Q-PP-04\nRisk area: none\nStatus: Closed\nClosed by Asha Assessor on 14 Nov 2026.\n${WITHDRAWN}`);
  });

  it('reading 7: a closing record\'s row stays a source of the document wherever it was one', () => {
    const row = (id: string) => ({ sourceTable: 'mitigation_versions', sourceId: id, field: 'what' });
    expect(walk().sources).toEqual(expect.arrayContaining([row('mv-08b'), row('mv-04'), row('mv-13')]));
    // Also when the plan's list of done mitigations is left empty.
    expect(plan([WALK[2]], { decisions: WALK_DECISIONS }).sources).toEqual(expect.arrayContaining([row('mv-04')]));
    const r = card([{ id: 'f-1', questionId: 'Q-IP-05', state: 'closed_mitigation', riskArea: 'IP-01', mitigations: [{ id: 'mv-1', seq: 1, kind: 'decision_changed', closes: 'dv-1' }] }]);
    expect(r.sources).toEqual(expect.arrayContaining([row('mv-1')]));
  });
});
