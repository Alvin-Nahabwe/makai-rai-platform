import { describe, expect, it } from 'vitest';
import type { MitigationStatus, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { AcceptedRiskView, ContentRef, FindingView, MitigationVersionView, UserRef } from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { SealManifestV1 } from '@/types/seal';
import { loadContent } from '@/lib/content/loader';
import { controlsForArea } from '@/lib/content/suggestions';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import {
  GATE_DERIVED_NA, textErasedLine, NOT_RECORDED_AT_ISSUE, SEALED_NOTE, STATEMENT,
  decisionSource, fromQuestion, personalDataAnswerLine,
} from '@/lib/documents/copy';
import { SOURCE_RESOLVERS, resolveFields, type DocumentSnapshot, type SealedDecision, type SealedFinding, type SealedStage } from '@/lib/documents/resolve';

/**
 * Field resolution of the mitigation plan (FR-DOC-01, FR-DOC-02, FR-DOC-07; SRS 10.3.4). Snapshots are built by hand
 * with fixture ids only; the content is the H0 fixture bundle, which holds every id used here.
 */

const content = loadContent('0.0.1-fixture');
const mpMap: FieldMap = loadFieldMap('mitigation_plan');
const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });

let seq = 0;
interface FindingSpec {
  id?: string; state?: FindingView['state']; riskArea?: string | null; title?: string | null; description?: string | null; source?: FindingView['source'];
  questionId?: string | null; raisedAt?: UtcInstant; mitigations?: MitigationSpec[]; risk?: Partial<AcceptedRiskView> | null;
}
interface MitigationSpec {
  id?: string; what?: string | null; owner?: string; due?: string; status?: MitigationStatus; control?: string | null; closureNote?: string | null; evidence?: MitigationVersionView['evidence'];
}
function mitigation(findingId: string, m: MitigationSpec): MitigationVersionView {
  seq += 1;
  return {
    id: m.id ?? `mv-${seq}`, findingId, mitigationId: `m-${seq}`, versionNumber: 1, baseVersionNumber: null, what: m.what === undefined ? 'Second coder' : m.what,
    changeNote: null, owner: user(m.owner ?? 'Amina N.'), dueDate: m.due ?? '2026-11-10', status: m.status ?? 'planned', kind: 'action',
    followsControl: m.control ?? null, closureNote: m.closureNote ?? null, closureDecisionVersionId: null, cancelReason: null,
    enteredBy: user('Amina N.'), enteredByRole: 'assessor', findingSeq: 1, receivedAt: '2026-10-30T09:00:00.000Z', evidence: m.evidence ?? [], erasedFields: [],
  };
}
function sealedFinding(f: FindingSpec): SealedFinding {
  seq += 1;
  const id = f.id ?? `f-${seq}`;
  const mitigations = (f.mitigations ?? []).map((m) => mitigation(id, m));
  const state = f.state ?? 'open';
  const view: FindingView = {
    id, projectId: 'p', stage: 'pre-processing', source: f.source ?? 'team', questionId: f.questionId ?? null, decisionVersionId: null,
    riskArea: f.riskArea === undefined ? 'PP-02' : f.riskArea, title: f.title === undefined ? 'Labels drift' : f.title,
    description: f.description === undefined ? 'Coders disagree.' : f.description, raisedBy: user('Amina N.'), raisedAt: f.raisedAt ?? '2026-10-29T08:00:00.000Z', state,
    openMitigations: 0, hasNoMitigation: mitigations.length === 0, overdueMitigations: 0,
  };
  const risk: AcceptedRiskView | null = f.risk === undefined || f.risk === null ? null : {
    id: `ar-${seq}`, findingId: id, acceptedBy: { kind: 'member', user: user('Owen O.') }, accepterRole: 'owner', reason: 'Low impact.', lookAgainNote: null, lookAgainOn: null,
    enteredBy: user('Owen O.'), enteredByRole: 'owner', findingSeq: 2, receivedAt: '2026-10-31T09:00:00.000Z', erasedFields: [], ...f.risk,
  };
  return { finding: view, mitigations, acceptedRisk: risk, events: [] };
}

interface SnapSpec {
  contentSemver?: string;
  preparedFor?: string | null; findings?: FindingSpec[]; none?: string[]; notApplicable?: Record<string, [code: string, reason: string | null]>;
  gate?: { derived: string[]; answer: 'no' | 'yes'; gateQuestion?: string }; reasonErased?: Record<string, string>;
  erasures?: Partial<DocumentSnapshot['erasures']>; today?: string;
}
function decisionOf(qid: string, status: SealedDecision['row']['status'], code: string | null, reason: string | null, erasedOn?: string): SealedDecision {
  return {
    row: {
      id: `dv-${qid}-1`, orgId: 'o', projectId: 'p', stage: 'pre-processing', questionId: qid, contentVersionId: 'cv1', versionNumber: 1, baseVersionNumber: null,
      status, scopeAnswer: null, optionsInPlace: [], reasonCode: code, reason, reasonSalt: null, decidedByUserId: 'u-Amina N.', decidedByRole: null,
      declaredOn: new Date('2026-10-12T00:00:00Z'), declaredPrecision: 'day', withdrawalCode: null, enteredById: 'u-enterer', enteredByRole: 'assessor',
      receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r', requestDigest: 'd', evidenceIds: [],
    },
    content: CV, enteredBy: user('Amina N.'), decidedBy: { kind: 'member', user: user('Amina N.') }, evidence: [],
    reasonErased: erasedOn === undefined ? null : { erasedOn },
  };
}
function snapshot(s: SnapSpec = {}): DocumentSnapshot {
  const decisions = new Map<string, SealedDecision>();
  for (const [q, [code, reason]] of Object.entries(s.notApplicable ?? {})) decisions.set(q, decisionOf(q, 'not_applicable', code, reason, s.reasonErased?.[q]));
  let derived = new Map<string, string>();
  if (s.gate !== undefined) {
    const gq = s.gate.gateQuestion ?? 'Q-PP-GATE-SENSITIVE';
    decisions.set(gq, decisionOf(gq, 'done', null, 'Scope answered.'));
    derived = new Map(s.gate.derived.map((q) => [q, `dv-${gq}-1`]));
  }
  const manifest = {
    format: 'makrai.seal/1', content: { semver: s.contentSemver ?? '0.0.1-fixture', contentHash: 'h' },
    decisions: [
      ...(s.none ?? []).map((question) => ({ question, none: true as const, withdrawal: null })),
      ...[...decisions.keys()].map((question) => ({ question })),
      ...[...derived.keys()].map((question) => ({ question, derived: 'not_applicable_gate' as const })),
    ],
  } as unknown as SealManifestV1;
  const chosen: SealedStage = {
    stage: 'pre-processing',
    seal: {
      sealId: 'seal-pp', sealNumber: 1, reviewId: 'review-pp', reviewName: 'Pre-processing review 1', fingerprint: 'c0ffee00'.repeat(8),
      sealedAt: '2026-11-01T09:30:15.000Z', sealedBy: user('Sealer S.'), sealedByRole: 'owner', enteredByPeople: 2,
    },
    preparedFor: s.preparedFor === undefined ? null : s.preparedFor, manifest, decisions, derived, findings: (s.findings ?? []).map(sealedFinding),
  };
  const stages = Object.fromEntries(STAGES.map((st) => [st, st === 'pre-processing' ? chosen : null])) as DocumentSnapshot['stages'];
  return {
    documentType: 'mitigation_plan', reviewStage: 'pre-processing' as Stage, chosen, stages, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: s.today ?? '2026-11-03',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: new Map(), accepted_risks: new Map(), stage_reviews: new Map(), ...s.erasures },
  };
}
type Resolved = ReturnType<typeof resolveFields>;
const resolve = (s: SnapSpec = {}): Resolved => resolveFields(mpMap, snapshot(s), {});
const text = (r: Resolved, id: string): string | null => (r.fields.find((f) => f.fieldId === id) as { text: string | null }).text;
const provenance = (r: Resolved, id: string): string => (r.fields.find((f) => f.fieldId === id) as { provenance: string }).provenance;

describe('the mitigation plan resolvers', () => {
  it('FR-DOC-01 (MP-01): stage, review name and the Prepared-for note; no note line when the note is empty', () => {
    expect(text(resolve({ preparedFor: 'ethics submission' }), 'MP-01')).toBe('Stage: pre-processing. Pre-processing review 1. Prepared for: ethics submission');
    expect(text(resolve({ preparedFor: null }), 'MP-01')).toBe('Stage: pre-processing. Pre-processing review 1.');
  });

  it('FR-DOC-01 FR-RM-04 (MP-02): whole-number counts of findings and mitigations, overdue by East Africa Time', () => {
    // 3 open findings, 1 closed by mitigation, 1 closed by accepted risk, 1 withdrawn (not counted); mitigations 2 planned (1 overdue on 2026-11-03), 1 in progress, 1 done, 0 cancelled
    const r = resolve({
      findings: [
        { mitigations: [{ status: 'planned', due: '2026-11-02' }, { status: 'planned', due: '2026-11-20' }] },
        { mitigations: [{ status: 'in_progress', due: '2026-11-20' }] },
        {},
        { state: 'closed_mitigation', mitigations: [{ status: 'done' }] },
        { state: 'closed_accepted_risk', risk: {} },
        { state: 'withdrawn', mitigations: [{ status: 'planned', due: '2026-10-01' }] },
      ],
    });
    expect(text(r, 'MP-02')).toBe([
      'Open findings: 3. Closed by a mitigation: 1. Closed by an accepted risk: 1.',
      'Mitigations planned: 2, in progress: 1, done: 1, cancelled: 0, overdue: 1.',
    ].join('\n'));
  });

  it('FR-DOC-01 (MP-02): a mitigation due today is not overdue; the day after it is', () => {
    const due = (today: string) => text(resolve({ today, findings: [{ mitigations: [{ status: 'planned', due: '2026-11-03' }] }] }), 'MP-02');
    expect(due('2026-11-03')).toContain('overdue: 0.');
    expect(due('2026-11-04')).toContain('overdue: 1.');
  });

  it('FR-DOC-01 (MP-03, MP-04): each open finding with source, risk area, title, description, date raised, its mitigations, and the controls for its area', () => {
    const r = resolve({ findings: [{
      riskArea: 'PP-02', title: 'Labels drift', source: 'shortfall', questionId: 'Q-PP-12', raisedAt: '2026-10-29T08:00:00.000Z',
      mitigations: [{ what: 'Second coder', owner: 'Amina N.', due: '2026-11-10', status: 'planned', control: 'C-03' }],
    }] });
    const mp3 = text(r, 'MP-03') as string;
    for (const s of ['Source: From question Q-PP-12', 'Assigned to: Amina N.', 'PP-02', 'Labels drift', 'Coders disagree.', '29 Oct 2026', 'Second coder', 'Amina N.', '10 Nov 2026', 'Planned', 'C-03']) expect(mp3).toContain(s);
    const mp4 = text(r, 'MP-04') as string;
    for (const g of controlsForArea(content, 'PP-02')) for (const c of g.controls) expect(mp4).toContain(`${c.control.id} ${c.control.name}`);
  });

  it('FR-DOC-01 FR-FUP-02 (MP-03): an overdue mitigation of an open finding says so', () => {
    const t = text(resolve({ findings: [{ mitigations: [{ status: 'planned', due: '2026-11-01' }] }] }), 'MP-03') as string;
    expect(t).toContain('Status: Planned (overdue)');
    expect(text(resolve({ findings: [{ mitigations: [{ status: 'planned', due: '2026-11-20' }] }] }), 'MP-03')).not.toContain('(overdue)');
  });

  it('FR-DOC-01 (MP-03): an open finding with no mitigation is still listed', () => {
    const t = text(resolve({ findings: [{ title: 'Alone' }] }), 'MP-03') as string;
    expect(t).toContain('Alone');
    expect(t).toContain('Mitigations: None');
  });

  it('FR-DOC-01 (MP-04): an open finding with no risk area has no controls to suggest, and the field says so', () => {
    expect(text(resolve({ findings: [{ riskArea: null }] }), 'MP-04')).toBe('None');
  });

  it('FR-DOC-01 (MP-05): findings closed by a mitigation with the closure note or evidence', () => {
    const r = resolve({ findings: [
      { state: 'closed_mitigation', title: 'Closed one', mitigations: [{ status: 'done', closureNote: 'Audit done.' }] },
      { title: 'Still open', mitigations: [{ status: 'done', closureNote: 'Partial step.' }, { status: 'planned' }] },
    ] });
    const t = text(r, 'MP-05') as string;
    expect(t).toContain('Closed one');
    expect(t).toContain('Audit done.');
    expect(t).not.toContain('Partial step.');   // a done step of a finding that is still open is not "closed by a mitigation"
    expect(t).not.toContain('Still open');
  });

  it('FR-DOC-01 (MP-07, MP-08): questions with no decision, and not applicable ones with code label and reason, including the gate', () => {
    const r = resolve({
      none: ['Q-PP-03', 'Q-PP-05'], notApplicable: { 'Q-PP-18': ['na_no_personal_data', 'Whole register used.'] },
      gate: { derived: ['Q-PP-13'], answer: 'no' },
    });
    expect(text(r, 'MP-07')).toContain('Q-PP-03');
    expect(text(r, 'MP-07')).toContain('Q-PP-05');
    expect(text(r, 'MP-08')).toMatch(/Q-PP-18[\s\S]*Not applicable \(No personal data is involved\)\. Reason: 'Whole register used\.'/);
    expect(text(r, 'MP-08')).toContain(`Q-PP-13: ${GATE_DERIVED_NA}`);
    expect(provenance(r, 'MP-08')).toContain('Q-PP-GATE-SENSITIVE');
  });

  it('FR-DOC-01 (MP-07, MP-04): the stem of an undecided question is read from the content the seal was made on, so a seal on content that is not installed fails loudly', () => {
    expect(text(resolve({ none: ['Q-PP-03'] }), 'MP-07')).toBe(`Q-PP-03: ${(content.questions.get('Q-PP-03') as { text: string }).text}`);
    // The MP-07 resolver alone (MP-04 also loads the seal's content, so the field-level call would throw for it).
    const meta = (snap: DocumentSnapshot) => SOURCE_RESOLVERS.meta({ kind: 'meta', item: 'no_decision' }, snap, {}, mpMap.fields[0], new Map());
    expect(meta(snapshot({ none: ['Q-PP-03'] })).text).toContain('Q-PP-03');
    expect(() => meta(snapshot({ none: ['Q-PP-03'], contentSemver: '9.9.9-not-installed' }))).toThrow();
  });

  it('FR-DOC-01: an empty list prints None', () => {
    const r = resolve({});
    for (const id of ['MP-03', 'MP-04', 'MP-05', 'MP-06', 'MP-07', 'MP-08']) expect(text(r, id)).toBe('None');
  });

  it('FR-DOC-02 D9 (R11-19, R12-17): the mitigation plan has no record or record_option source, so DOC-a\'s evidence-line rule has no extract to apply to; MP-07 and MP-08 print no Evidence line', () => {
    const kinds = mpMap.fields.flatMap((f) => f.sources.map((s) => s.kind));
    expect(kinds).not.toContain('record');
    expect(kinds).not.toContain('record_option');   // the day C-MAP adds one, this fails and the field gets DOC-a's evidence line
    const r = resolve({ none: ['Q-PP-03'], notApplicable: { 'Q-PP-18': ['na_no_personal_data', 'Whole register used.'] } });
    expect(text(r, 'MP-07')).not.toMatch(/Evidence:/);
    expect(text(r, 'MP-08')).not.toMatch(/Evidence:/);
  });
});

describe('the mitigation plan records what it prints, so an erasure reaches it (FR-REV-08 FR-DOC-07; SRS 7.5.6)', () => {
  it('FR-REV-08: every printed finding text, mitigation text, closure text and not-applicable reason is a source row', () => {
    const r = resolve({
      preparedFor: 'ethics submission',
      findings: [
        { id: 'f-open', mitigations: [{ what: 'Second coder' }] },
        { id: 'f-closed', state: 'closed_mitigation', mitigations: [{ status: 'done', closureNote: 'Audit done.' }] },
      ],
      notApplicable: { 'Q-PP-18': ['na_no_personal_data', 'Whole register used.'] },
    });
    const has = (sourceTable: string, field: string | null, sourceId?: string) => r.sources.some((s) => s.sourceTable === sourceTable && s.field === field && (sourceId === undefined || s.sourceId === sourceId));
    expect(has('findings', 'title', 'f-open')).toBe(true);
    expect(has('findings', 'description', 'f-open')).toBe(true);
    expect(has('findings', 'title', 'f-closed')).toBe(true);
    expect(has('mitigation_versions', 'what')).toBe(true);
    expect(has('mitigation_versions', 'closureNote')).toBe(true);
    expect(has('decision_versions', 'reason', 'dv-Q-PP-18-1')).toBe(true);
    expect(has('stage_reviews', 'preparedFor', 'review-pp')).toBe(true);
  });

  it('FR-REV-08 (SRS 7.5.6): erased texts print their erasure lines, never the empty string', () => {
    const r = resolve({
      findings: [{ id: 'f-open', title: null, description: null, mitigations: [{ id: 'mv-gone', what: null }] }],
      erasures: {
        findings: new Map([['f-open', new Map([['title', '2026-11-04'], ['description', '2026-11-04']])]]),
        mitigation_versions: new Map([['mv-gone', new Map([['what', '2026-11-04']])]]),
      },
      notApplicable: { 'Q-PP-18': ['na_no_personal_data', null] }, reasonErased: { 'Q-PP-18': '2026-11-04' },
    });
    expect(text(r, 'MP-03')).toContain(textErasedLine('2026-11-04'));
    expect(text(r, 'MP-08')).toContain(`Reason: ${textErasedLine('2026-11-04')}`);
  });

  it('FR-REV-08 (SRS 7.5.6): a Prepared-for note erased before issue prints the erasure line, still as a source row, and an empty note still prints no line', () => {
    const erased = resolve({ preparedFor: null, erasures: { stage_reviews: new Map([['review-pp', new Map([['preparedFor', '2026-11-04']])]]) } });
    expect(text(erased, 'MP-01')).toBe(`Stage: pre-processing. Pre-processing review 1. Prepared for: ${textErasedLine('2026-11-04')}`);
    expect(erased.sources).toContainEqual({ sourceTable: 'stage_reviews', sourceId: 'review-pp', field: 'preparedFor' });
    expect(text(resolve({ preparedFor: null }), 'MP-01')).toBe('Stage: pre-processing. Pre-processing review 1.');
  });

  it('FR-REV-08: a finding text that is null with no tombstone is a broken row and throws', () => {
    expect(() => resolve({ findings: [{ id: 'f-bad', title: null }] })).toThrow(/no title and no tombstone/);
  });
});

describe('the ruled words a new document prints (plan 1A Task 18c)', () => {
  it('FR-DOC-02 (AL-1, AL-2): the statement and the sealed note on every document, word for word', () => {
    expect(STATEMENT).toBe("Made from this team's own records in the MAK-AI RAI Platform. It is not an ethics approval, audit, certification or compliance statement.");
    expect(SEALED_NOTE).toBe('The platform keeps this seal. No outside body has time-stamped it.');
  });

  it('FR-DOC-02 (C2, C8 #4, G-c3, G-c5): the five ruled lines: Assigned to, Evidence that it is done, the personal data answer, Does not apply, and the source of a decision', () => {
    const r = resolve({
      findings: [
        { mitigations: [{ owner: 'Joan K.', status: 'planned', control: 'C-03' }] },
        { state: 'closed_mitigation', mitigations: [{ status: 'done', evidence: [{
          id: 'ev-1', kind: 'file', fileName: 'audit.pdf', mimeType: 'application/pdf', byteSize: 100, sha256: 'ab'.repeat(32), url: null, label: null,
          uploadedBy: null, uploadedAt: '2026-10-30T09:00:00.000Z', erased: null,
        }] }] },
      ],
      notApplicable: { 'Q-PP-18': ['na_no_personal_data', 'Whole register used.'] },
      gate: { derived: ['Q-PP-13'], answer: 'no' },
    });
    const mp3 = text(r, 'MP-03') as string;
    expect(mp3).toContain('Assigned to: Joan K.');
    expect(mp3).not.toContain('Owner:');
    expect(mp3).toContain('Control followed: C-03');   // kept as it was
    expect(text(r, 'MP-05')).toContain('Evidence that it is done: file audit.pdf');
    expect(text(r, 'MP-05')).not.toContain('Closure evidence');
    expect(GATE_DERIVED_NA).toBe('Does not apply: the team answered No to the personal data question');
    expect(text(r, 'MP-08')).toContain('Q-PP-13: Does not apply: the team answered No to the personal data question');
    expect(provenance(r, 'MP-08').split('\n')).toEqual([
      'Source: question Q-PP-18, version 1 of the decision. Decided by Amina N. on 12 Oct 2026.',
      'From question Q-PP-GATE-SENSITIVE (decision version 1).',
    ]);
    expect(personalDataAnswerLine('Not sure')).toBe('Answer to the personal data question: Not sure');
    expect(fromQuestion('Q-PP-12', 3)).toBe('From question Q-PP-12 (decision version 3)');
    expect(fromQuestion('Q-PP-12')).toBe('From question Q-PP-12');
    expect(decisionSource('Q-PP-12', 3)).toBe('Source: question Q-PP-12, version 3 of the decision.');
  });
});

describe('a stage that was never sealed', () => {
  it('FR-DOC-05: the chosen stage is always sealed, so a mitigation plan never prints the not-recorded-at-issue line', () => {
    const r = resolve({});
    expect(r.fields.map((f) => f.text)).not.toContain(NOT_RECORDED_AT_ISSUE);
  });
});
