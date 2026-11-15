import { describe, expect, it } from 'vitest';
import type { CalendarDate, MitigationKind, MitigationStatus, Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import type { FindingView, MitigationVersionView, UserRef } from '@/types/api';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { docTextErasedLine } from '@/lib/documents/copy';
import { resolveFields, type DocumentSnapshot, type SealedStage } from '@/lib/documents/resolve';
import { FINDINGS_COPY } from '@/lib/findings/copy';

/**
 * Register row D-408: a done mitigation that closed its finding because the decision changed or was withdrawn has no text and
 * no tombstone. By the coordinator's ruling of 14 November 2026 (21:45 EAT) such a version 1 row is a closing record, not a
 * mitigation: the mitigation plan prints it under its finding (MP-05) as who closed it, on which day, and the owner's sentence,
 * and neither the plan nor the model card (MC-24) lists it as a mitigation. Every other null text with no tombstone still fails
 * loudly, with the message the resolver has always thrown. Snapshots by hand, fixture ids only.
 */

const content = loadContent('0.0.1-fixture');
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });
const CHANGED = FINDINGS_COPY.mitigation.closedBecauseDecisionChanged;
const WITHDRAWN = FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn;
const THROWN = 'documents: mitigation_versions mv-1 has no what and no tombstone for it';

interface Spec { what: string | null; kind: MitigationKind; status?: MitigationStatus; state?: FindingView['state']; erasedOn?: CalendarDate }

function snap(docType: DocumentSnapshot['documentType'], stage: Stage, s: Spec): DocumentSnapshot {
  const m: MitigationVersionView = {
    id: 'mv-1', findingId: 'f-1', mitigationId: 'm-1', versionNumber: 1, baseVersionNumber: null, what: s.what, changeNote: null,
    owner: user('Amina N.'), dueDate: '2026-11-10', status: s.status ?? 'done', kind: s.kind, followsControl: null, closureNote: null,
    closureDecisionVersionId: s.kind === 'action' ? null : 'dv-2', cancelReason: null, enteredBy: user('Amina N.'), enteredByRole: 'assessor',
    findingSeq: 1, receivedAt: '2026-10-30T09:00:00.000Z', evidence: [], erasedFields: [],
  };
  const f: FindingView = {
    id: 'f-1', projectId: 'p', stage, source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: 'dv-1', riskArea: null, title: 'Labels drift',
    description: 'Coders disagree.', raisedBy: user('Amina N.'), raisedAt: '2026-10-29T08:00:00.000Z', state: s.state ?? 'closed_mitigation',
    openMitigations: 0, hasNoMitigation: false, overdueMitigations: 0,
  };
  const chosen: SealedStage = {
    stage,
    seal: {
      sealId: 'seal-1', sealNumber: 1, reviewId: 'review-1', reviewName: 'Review 1', fingerprint: 'c0ffee00'.repeat(8),
      sealedAt: '2026-11-01T09:30:15.000Z', sealedBy: user('Sealer S.'), sealedByRole: 'owner', enteredByPeople: 2,
    },
    preparedFor: null, manifest: { format: 'makrai.seal/1', content: { semver: '0.0.1-fixture', contentHash: 'h' }, decisions: [] } as never,
    // dv-2, the version that closed the finding, is a version of the finding's own question Q-PP-01.
    decisions: new Map([['Q-PP-01', { row: { id: 'dv-2', questionId: 'Q-PP-01', scopeAnswer: null, status: 'done' }, decidedBy: null, evidence: [] } as never]]), derived: new Map(), findings: [{ finding: f, mitigations: [m], acceptedRisk: null, events: [] }],
  };
  const stages = Object.fromEntries(STAGES.map((x) => [x, x === stage ? chosen : null])) as DocumentSnapshot['stages'];
  const tombstones = new Map(s.erasedOn === undefined ? [] : [['mv-1', new Map([['what', s.erasedOn]])]]);
  return {
    documentType: docType, reviewStage: stage, chosen, stages, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: '2026-11-03',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: tombstones, accepted_risks: new Map(), stage_reviews: new Map() },
  } as DocumentSnapshot;
}

const mp = loadFieldMap('mitigation_plan');
const mc = loadFieldMap('model_card');
const fieldText = (r: ReturnType<typeof resolveFields>, id: string) => r.fields.find((x) => x.fieldId === id)?.text ?? null;
const plan = (s: Spec) => resolveFields(mp, snap('mitigation_plan', 'pre-processing', s), {});
const card = (s: Spec) => resolveFields(mc, snap('model_card', 'in-processing', s), {});

describe('a mitigation closed by a decision, as a document prints it (D-408)', () => {
  it('FR-FND-06 FR-DOC-01: MP-05 prints "Closed because the decision changed." under the finding for a done decision_changed with no text and no tombstone', () => {
    const text = fieldText(plan({ what: null, kind: 'decision_changed' }), 'MP-05');
    expect(text).toBe(`1. Labels drift\nSource: question Q-PP-01\nRisk area: none\nDescription: Coders disagree.\nStatus: Closed\nClosed by Amina N. on 30 Oct 2026.\n${CHANGED}`);
  });

  it('FR-FND-06 FR-DOC-01: MP-05 prints "Closed because the decision was withdrawn." under the finding for a done decision_withdrawn', () => {
    expect(fieldText(plan({ what: null, kind: 'decision_withdrawn' }), 'MP-05'))
      .toBe(`1. Labels drift\nSource: question Q-PP-01\nRisk area: none\nDescription: Coders disagree.\nStatus: Closed\nClosed by Amina N. on 30 Oct 2026.\n${WITHDRAWN}`);
  });

  it('FR-FND-06 FR-DOC-01: MC-24 of the model card lists neither decision kind as a done mitigation', () => {
    // MC-24 is the done mitigations, then question Q-IP-15 (undecided here): no mitigation is left to list.
    expect(fieldText(card({ what: null, kind: 'decision_changed' }), 'MC-24')).toBe('None\nNot recorded');
    expect(fieldText(card({ what: null, kind: 'decision_withdrawn' }), 'MC-24')).toBe('None\nNot recorded');
  });

  it('FR-REV-08 (SRS 7.5.6): a decision-kind row with a tombstone prints the erased line, not the sentence', () => {
    const text = fieldText(plan({ what: null, kind: 'decision_changed', erasedOn: '2026-11-02' }), 'MP-05');
    expect(text).toContain(`1. ${docTextErasedLine('2026-11-02')}`);
    expect(text).not.toContain(CHANGED);
  });

  it('FR-DOC-01: a decision-kind row that has text prints its text', () => {
    const text = fieldText(plan({ what: 'Recheck the labels', kind: 'decision_withdrawn' }), 'MP-05');
    expect(text).toContain('1. Recheck the labels\nFinding: Labels drift');
    expect(text).not.toContain(WITHDRAWN);
  });

  it('silent-failure review H1: a done action with no text and no tombstone still throws the message it always threw', () => {
    expect(() => plan({ what: null, kind: 'action' })).toThrow(THROWN);
    expect(() => card({ what: null, kind: 'action' })).toThrow(THROWN);
  });

  it('silent-failure review H1: a decision-kind row that is not done, with no text and no tombstone, still throws (MP-03 lists it)', () => {
    expect(() => plan({ what: null, kind: 'decision_changed', status: 'in_progress', state: 'open' })).toThrow(THROWN);
  });

  it('silent-failure review H1: an unknown kind with no text and no tombstone still throws', () => {
    expect(() => plan({ what: null, kind: 'decision_reversed' as MitigationKind })).toThrow(THROWN);
  });
});
