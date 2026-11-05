import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionVersionRow, OutsideRole, ScopeAnswer, Stage, StoredDecisionStatus } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, EvidenceItemView, UserRef } from '@/types/api';
import type { FieldMap, FieldMapEntry } from '@/types/documents';
import type { LoadedContent } from '@/types/content';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import {
  NOT_RECORDED, NOT_RECORDED_AT_ISSUE, NO_EVIDENCE, PROJECT_MARK, SOURCE_RESOLVERS, TYPED_MARK, resolveFields,
  type DocumentSnapshot, type SealedDecision, type SealedStage,
} from '@/lib/documents/resolve';
import { formatFingerprint } from '@/lib/seal/format';
import { claimMatches } from '@/lib/claims/pattern';

const content: LoadedContent = loadContent('0.0.1-fixture');
const dataCardMap: FieldMap = loadFieldMap('data_card');
const modelCardMap: FieldMap = loadFieldMap('model_card');
const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const FINGERPRINT = 'c0ffee00'.repeat(8);
const entry: FieldMapEntry = { fieldId: 'X-01', label: 'X', section: 'S', sources: [], typedAddition: false };

const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });
const file = (id: string): EvidenceItemView => ({
  id, kind: 'file', fileName: `${id}-protocol.pdf`, mimeType: 'application/pdf', byteSize: 100, sha256: 'ab'.repeat(32), url: null, label: null,
  uploadedBy: null, uploadedAt: '2026-10-30T09:00:00.000Z', erased: null,
});

interface Spec {
  v?: number; status?: StoredDecisionStatus | null; reason?: string | null; reasonCode?: string | null; scopeAnswer?: ScopeAnswer | null;
  decidedBy?: { kind: 'outside_role'; role: OutsideRole } | { kind: 'member'; name: string }; enteredBy?: string;
  evidence?: EvidenceItemView[]; ticked?: string[]; reasonErased?: { erasedOn: string } | null; declared?: string;
}
const decision = (s: Spec): Spec => s;
const stemOf = (id: string) => (content.questions.get(id) as { text: string }).text;
const optionsOf = (id: string) => [...((content.questions.get(id) as { options?: readonly string[] }).options ?? [])];

function sealedDecision(qid: string, s: Spec): SealedDecision {
  const v = s.v ?? 1;
  const declared = s.declared ?? '2026-10-12';
  const row: DecisionVersionRow = {
    id: `dv-${qid}-${v}`, orgId: 'o', projectId: 'p', stage: (content.questions.get(qid) as { stage: Stage }).stage, questionId: qid, contentVersionId: 'cv1',
    versionNumber: v, baseVersionNumber: null, status: s.status === undefined ? 'done' : s.status, scopeAnswer: s.scopeAnswer ?? null,
    optionsInPlace: s.ticked ?? [], reasonCode: s.reasonCode ?? null, reason: s.reason === undefined ? 'A reason.' : s.reason, reasonSalt: null,
    decidedByUserId: s.decidedBy?.kind === 'member' ? `u-${s.decidedBy.name}` : null, decidedByRole: s.decidedBy?.kind === 'outside_role' ? s.decidedBy.role : null,
    declaredOn: new Date(`${declared.length === 4 ? `${declared}-01-01` : declared.length === 7 ? `${declared}-01` : declared}T00:00:00Z`),
    declaredPrecision: declared.length === 4 ? 'year' : declared.length === 7 ? 'month' : 'day', withdrawalCode: null,
    enteredById: 'u-enterer', enteredByRole: 'assessor', receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r', requestDigest: 'd', evidenceIds: (s.evidence ?? []).map((e) => e.id),
  };
  return {
    row, content: CV, enteredBy: user(s.enteredBy ?? 'Amina N.'),
    decidedBy: s.decidedBy === undefined ? { kind: 'member', user: user('Amina N.') } : s.decidedBy.kind === 'member' ? { kind: 'member', user: user(s.decidedBy.name) } : s.decidedBy,
    evidence: s.evidence ?? [], reasonErased: s.reasonErased ?? null,
  };
}

function sealedStage(stage: Stage, n: number, decisions: Map<string, SealedDecision>): SealedStage {
  return {
    stage,
    seal: {
      sealId: `seal-${stage}`, sealNumber: n, reviewId: `review-${stage}`, reviewName: `${stage[0].toUpperCase()}${stage.slice(1)} review 1`,
      fingerprint: FINGERPRINT, sealedAt: '2026-11-01T09:30:15.000Z', sealedBy: user('Sealer S.'), sealedByRole: 'owner', enteredByPeople: 2,
    },
    preparedFor: null, manifest: {} as never, decisions, findings: [],
  };
}

function snapshot(decisions: Record<string, Spec>, over: { project?: Partial<DocumentSnapshot['project']> & { metadata?: Record<string, string | null> }; reviewStage?: Stage; sealed?: Stage[] } = {}): DocumentSnapshot {
  const sealed = over.sealed ?? [...STAGES];
  const byStage = new Map<Stage, Map<string, SealedDecision>>(STAGES.map((s) => [s, new Map()]));
  for (const [qid, s] of Object.entries(decisions)) {
    const d = sealedDecision(qid, s);
    byStage.get(d.row.stage)?.set(qid, d);
  }
  const stages = Object.fromEntries(STAGES.map((s, i) => [s, sealed.includes(s) ? sealedStage(s, i + 1, byStage.get(s) as Map<string, SealedDecision>) : null])) as DocumentSnapshot['stages'];
  const reviewStage = over.reviewStage ?? 'pre-processing';
  return {
    documentType: 'data_card', reviewStage, chosen: stages[reviewStage] as SealedStage, stages, contents: new Map([['cv1', content]]),
    project: { name: 'Project', description: null, ...over.project, metadata: over.project?.metadata ?? {} }, organisationName: 'Org', today: '2026-11-05',
  };
}
const snapWith = (decisions: Record<string, Spec>, project?: { metadata?: Record<string, string | null> }) => snapshot(decisions, { project });
const snapIpOnly = () => snapshot({}, { reviewStage: 'in-processing', sealed: ['in-processing'] });

type Resolved = ReturnType<typeof resolveFields>;
const text = (r: Resolved, id: string): string | null => (r.fields.find((f) => f.fieldId === id) as { text: string | null }).text;
const provenance = (r: Resolved, id: string): string => (r.fields.find((f) => f.fieldId === id) as { provenance: string }).provenance;
const part = <K extends keyof typeof SOURCE_RESOLVERS>(kind: K, source: Parameters<(typeof SOURCE_RESOLVERS)[K]>[0], snap: DocumentSnapshot, e: FieldMapEntry = entry, seen = new Map<string, string>()) =>
  (SOURCE_RESOLVERS[kind] as unknown as (s: unknown, snap: DocumentSnapshot, t: Record<string, string>, e: FieldMapEntry, seen: Map<string, string>) => { text: string | null; sources: Array<{ sourceTable: string; sourceId: string; field: string | null }> })(source, snap, {}, e, seen);

describe('record fields', () => {
  it('FR-DOC-02: a decided record field prints its reason with "Q-PP-12 v1", and an empty licence prints Not recorded', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-12': decision({ v: 1, status: 'done', reason: 'Two coders labelled every visit.' }) }), {});
    expect(text(r, 'DC-19')).toContain('Two coders labelled every visit.');
    expect(provenance(r, 'DC-19')).toContain('Q-PP-12 v1');
    expect(provenance(r, 'DC-19')).toContain('content 0.0.1-fixture');
    expect(text(r, 'DC-25')).toBe(null);
    expect(r.notRecordedFields).toContain('DC-25');
  });

  it('FR-DOC-02 (D7, D9): an outside-role decision names the member and the role, and no evidence prints the line', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-13': decision({ v: 1, status: 'done', decidedBy: { kind: 'outside_role', role: 'ethics_committee' }, enteredBy: 'Amina N.', evidence: [] }) }), {});
    expect(text(r, 'DC-16')).toContain('Recorded by Amina N. as decided by Ethics committee. The Ethics committee did not record this in the platform.');
    expect(text(r, 'DC-16')).toContain(NO_EVIDENCE);
  });

  it('D2: not applicable prints the code label and the reason', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-18': decision({ v: 1, status: 'not_applicable', reasonCode: 'na_no_personal_data', reason: 'Whole register used.' }) }), {});
    expect(text(r, 'DC-07')).toMatch(/Not applicable \(.+\)\. Reason: 'Whole register used\.'/);
    expect(text(r, 'DC-07')).toContain('No personal data is involved');
    expect(text(r, 'DC-07')).toContain(stemOf('Q-PP-18'));
    expect(text(r, 'DC-07')).toContain(NO_EVIDENCE);
  });

  it('D4: a question feeding a second field of one document prints See <first field id>, and the first field prints the whole decision', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-08': decision({ v: 1, status: 'done', reason: 'From the clinic register.', evidence: [file('ev-3')] }) }), {});
    expect(text(r, 'DC-01')).toContain('From the clinic register.');
    expect(text(r, 'DC-01')).toContain(file('ev-3').fileName!);
    expect(text(r, 'DC-11')).toContain('See DC-01');
    expect(text(r, 'DC-11')).not.toContain(file('ev-3').fileName!);
  });

  it('D4 (round 10): Q-PP-12 feeds DC-19 and DC-20, so DC-19 holds its stem, status, reason and evidence and DC-20 reads See DC-19', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-12': decision({ v: 1, status: 'partly', reason: 'Two coders labelled every visit.', evidence: [file('ev-9')] }) }), {});
    expect(text(r, 'DC-19')).toContain(stemOf('Q-PP-12'));
    expect(text(r, 'DC-19')).toMatch(/Status: Partly/);
    expect(text(r, 'DC-19')).toContain('Two coders labelled every visit.');
    expect(text(r, 'DC-19')).toContain(file('ev-9').fileName!);
    expect(text(r, 'DC-20')?.startsWith('See DC-19')).toBe(true);
    expect(text(r, 'DC-20')).not.toMatch(/Status:|Evidence:/);
    expect(r.sources).toEqual(expect.arrayContaining([{ sourceTable: 'decision_versions', sourceId: 'dv-Q-PP-12-1', field: 'reason' }, { sourceTable: 'evidence', sourceId: 'ev-9', field: null }]));
    expect(r.sources.filter((s) => s.sourceId === 'dv-Q-PP-12-1')).toHaveLength(1);
    expect(r.sources.filter((s) => s.sourceId === 'ev-9')).toHaveLength(1);
  });

  it('D4 (round 10): Q-PP-16 feeds DC-09, DC-17 and DC-29, so DC-09 lists every option as Ticked or Not ticked and the other two read See DC-09', () => {
    const ticked = ['Missing data analysis', 'Data lineage/provenance tracking'];
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-16': decision({ v: 1, status: 'done', reason: 'Two checks run.', ticked }) }), {});
    expect(optionsOf('Q-PP-16').length).toBeGreaterThan(ticked.length);
    for (const o of optionsOf('Q-PP-16')) expect(text(r, 'DC-09')).toContain(`${o}: ${ticked.includes(o) ? 'Ticked' : 'Not ticked'}`);
    expect(text(r, 'DC-17')).toContain('See DC-09');
    expect(text(r, 'DC-29')).toContain('See DC-09');
  });

  it('D4 and D9 (R11-19): a question that feeds one field prints the parts its map names and always an evidence line: the list, or "Evidence: none attached"', () => {
    const r = resolveFields(dataCardMap, snapWith({
      'Q-PP-18': decision({ v: 1, status: 'done', reason: 'Whole register used.', evidence: [] }), 'Q-PP-13': decision({ v: 1, status: 'done', reason: 'Consent forms kept.', evidence: [] }),
    }), {});
    expect(text(r, 'DC-07')).toContain('Whole register used.');
    expect(text(r, 'DC-07')).toContain(NO_EVIDENCE);
    expect(text(r, 'DC-16')).toContain(NO_EVIDENCE);
    const withFile = resolveFields(dataCardMap, snapWith({ 'Q-PP-18': decision({ v: 1, status: 'done', reason: 'Whole register used.', evidence: [file('ev-4')] }) }), {});
    expect(text(withFile, 'DC-07')).toContain(file('ev-4').fileName!);
    expect(text(withFile, 'DC-07')).not.toContain(NO_EVIDENCE);
    expect(withFile.sources).toEqual(expect.arrayContaining([{ sourceTable: 'evidence', sourceId: 'ev-4', field: null }]));
  });

  it('D4 and D9 (R12-11): a record_option extract and an options-only record extract of a question that feeds one field always end with an evidence line: the list, or "Evidence: none attached"', () => {
    const feeds = (q: string) => modelCardMap.fields.filter((f) => f.sources.some((s) => 'questionId' in s && s.questionId === q)).map((f) => f.fieldId);
    expect(feeds('Q-IP-13')).toEqual(['MC-18']);
    expect(feeds('Q-IP-06')).toEqual(['MC-20']);
    const opt = 'AUC-ROC curve analysis';
    const optionPart = (snap: DocumentSnapshot) => part('record_option', { kind: 'record_option', questionId: 'Q-IP-13', option: opt }, snap, { ...entry, fieldId: 'MC-18' });
    const bare = optionPart(snapWith({ 'Q-IP-13': decision({ v: 1, status: 'done', reason: 'Curve plotted.', ticked: [opt], evidence: [] }) }));
    expect(bare.text).toContain(`${opt}: Ticked`);
    expect(bare.text).toContain('Curve plotted.');
    expect(bare.text).toContain(NO_EVIDENCE);
    const withFile = optionPart(snapWith({ 'Q-IP-13': decision({ v: 1, status: 'done', reason: 'Curve plotted.', ticked: [], evidence: [file('ev-5')] }) }));
    expect(withFile.text).toContain(`${opt}: Not ticked`);
    expect(withFile.text).toContain(file('ev-5').fileName!);
    expect(withFile.text).not.toContain(NO_EVIDENCE);
    expect(withFile.sources).toEqual(expect.arrayContaining([{ sourceTable: 'evidence', sourceId: 'ev-5', field: null }]));
    expect(optionPart(snapWith({})).text).toBeNull();
    const optionsOnly = (snap: DocumentSnapshot) => part('record', { kind: 'record', questionId: 'Q-IP-06', parts: ['options'] }, snap, { ...entry, fieldId: 'MC-20' });
    expect(optionsOnly(snapWith({ 'Q-IP-06': decision({ v: 1, status: 'done', reason: 'x', ticked: ['Predictive Parity'], evidence: [] }) })).text).toContain(NO_EVIDENCE);
    expect(optionsOnly(snapWith({ 'Q-IP-06': decision({ v: 1, status: 'done', reason: 'x', ticked: [], evidence: [file('ev-6')] }) })).text).toContain(file('ev-6').fileName!);
    const whole = resolveFields(modelCardMap, snapWith({ 'Q-IP-13': decision({ v: 1, status: 'done', reason: 'Curve plotted.', ticked: [opt], evidence: [] }) }), {});
    expect(text(whole, 'MC-18')).toContain(NO_EVIDENCE);
  });

  it('FR-DOC-02 (D1 and D3 before D4, R11-20): a later field of a question with no decision reads Not recorded, and one whose stage was never sealed reads Not recorded at the time of issue, never See', () => {
    const later = (qid: string, firstId: string, fieldId: string, snap: DocumentSnapshot) =>
      part('record', { kind: 'record', questionId: qid, parts: ['reason'] }, snap, { ...entry, fieldId }, new Map([[qid, firstId]]));
    expect(later('Q-PP-12', 'DC-19', 'DC-20', snapWith({})).text).toBeNull();
    expect(later('Q-PO-01', 'MC-28', 'MC-29', snapIpOnly()).text).toBe(NOT_RECORDED_AT_ISSUE);
    const r = resolveFields(dataCardMap, snapWith({}), {});
    expect(text(r, 'DC-20') ?? '').not.toMatch(/^See /);
    expect(r.notRecordedFields).toEqual(expect.arrayContaining(['DC-19', 'DC-20']));
  });

  it('FR-DOC-02 (B38): a gate question prints "Scope answer: <Yes, No or Not sure>" in its first field, and its second field reads See', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-GATE-SENSITIVE': decision({ v: 1, status: null, scopeAnswer: 'not_sure', reason: 'Not yet checked.' }) }), {});
    expect(text(r, 'DC-16')).toContain('Scope answer: Not sure');
    expect(text(r, 'DC-16')).toContain('Not yet checked.');
    expect(text(r, 'DC-35')).toContain('See DC-16');
    for (const [answer, word] of [['yes', 'Yes'], ['no', 'No']] as const) {
      const one = resolveFields(dataCardMap, snapWith({ 'Q-PP-GATE-SENSITIVE': decision({ v: 1, status: null, scopeAnswer: answer, reason: 'x' }) }), {});
      expect(text(one, 'DC-16')).toContain(`Scope answer: ${word}`);
    }
  });

  it('FR-DOC-02 FR-REV-08: an erased reason prints Erased on <date>, never the old text', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-08': decision({ v: 1, status: 'done', reason: null, reasonErased: { erasedOn: '2026-11-04' } }) }), {});
    expect(text(r, 'DC-01')).toContain('Erased on 4 Nov 2026');
  });

  it('FR-DOC-02 FR-REV-08: every printed record field and evidence file is a source row', () => {
    const r = resolveFields(dataCardMap, snapWith({ 'Q-PP-13': decision({ v: 1, status: 'done', reason: 'x', evidence: [file('ev-1')] }) }), {});
    expect(r.sources).toEqual(expect.arrayContaining([
      { sourceTable: 'decision_versions', sourceId: 'dv-Q-PP-13-1', field: 'reason' },
      { sourceTable: 'evidence', sourceId: 'ev-1', field: null },
    ]));
  });

  it('FR-DOC-05 (D3): a field from a stage never sealed reads Not recorded at the time of issue', () => {
    const r = resolveFields(modelCardMap, snapIpOnly(), {});
    expect(text(r, 'MC-28')).toBe(NOT_RECORDED_AT_ISSUE);
    expect(r.sealIds).toEqual(['seal-in-processing']);
  });

  it('FR-DOC-05: the seals a document used are the chosen seal first, then the other sealed stages it read in STAGES order', () => {
    const r = resolveFields(modelCardMap, snapshot({}, { reviewStage: 'in-processing' }), {});
    expect(r.sealIds).toEqual(['seal-in-processing', 'seal-pre-processing', 'seal-post-processing']);
  });
});

describe('project, typed and meta fields', () => {
  it('FR-DOC-02: a project field carries its mark; FR-DOC-03: a typed value carries its mark and an empty one is Not recorded', () => {
    const r = resolveFields(dataCardMap, snapWith({}, { metadata: { fundingSource: 'GIZ' } }), { 'DC-25': 'CC BY 4.0' });
    expect(text(r, 'DC-03')).toContain('GIZ');
    expect(text(r, 'DC-03')).toContain(PROJECT_MARK);
    expect(text(r, 'DC-25')).toContain('CC BY 4.0');
    expect(text(r, 'DC-25')).toContain(TYPED_MARK);
    expect(r.typedFieldIds).toEqual(expect.arrayContaining(['DC-25', 'DC-27']));
    expect(text(r, 'DC-27')).toBeNull();
  });

  it('FR-DOC-03: a typed addition prints after the record or project text, each with its own mark', () => {
    const r = resolveFields(dataCardMap, snapWith({}, { metadata: { fundingSource: 'GIZ' } }), { 'DC-03': 'plus a small grant' });
    const t = text(r, 'DC-03') as string;
    expect(t.indexOf('GIZ')).toBeLessThan(t.indexOf('plus a small grant'));
    expect(t.split(PROJECT_MARK)).toHaveLength(2);
    expect(t.split(TYPED_MARK)).toHaveLength(2);
    expect(r.typedFieldIds).toContain('DC-03');
  });

  it('FR-DOC-02 (round 10): a project value of other prints its companion text, and Other when the companion is empty', () => {
    const meta = { aiSystemType: 'other', aiSystemTypeOther: 'Triage chatbot', deploymentSector: 'other', deploymentSectorOther: 'Fisheries', datasetType: 'other', datasetTypeOther: 'Drone footage' };
    const m = resolveFields(modelCardMap, snapWith({}, { metadata: meta }), {});
    const d = resolveFields(dataCardMap, snapWith({}, { metadata: meta }), {});
    expect(text(m, 'MC-03')).toContain('Triage chatbot');
    expect(text(m, 'MC-10')).toContain('Fisheries');
    expect(text(d, 'DC-06')).toContain('Drone footage');
    for (const t of [text(m, 'MC-03'), text(m, 'MC-10'), text(d, 'DC-06')]) expect(t).not.toContain('other');
    const bare = resolveFields(modelCardMap, snapWith({}, { metadata: { aiSystemType: 'other', aiSystemTypeOther: null } }), {});
    expect(text(bare, 'MC-03')).toMatch(/^Other/);
    expect(text(resolveFields(modelCardMap, snapWith({}, { metadata: { aiSystemType: 'classification' } }), {}), 'MC-03')).toContain('classification');
  });

  it('FR-DOC-02 (round 10): a dataset size band prints its words, never the enum value', () => {
    const words: Array<[string, string]> = [['small_lt1k', 'Under 1,000'], ['medium_1k_100k', '1,000 to 100,000'], ['large_100k_1m', '100,000 to 1 million'], ['very_large_gt1m', 'Over 1 million'], ['unknown', 'Unknown']];
    for (const [band, word] of words) {
      const p = part('project', { kind: 'project', field: 'datasetSize' }, snapWith({}, { metadata: { datasetSize: band } }));
      expect(p.text).toContain(word);
      expect(p.text).toContain(PROJECT_MARK);
      expect(p.text).not.toContain(band);
    }
    expect(part('project', { kind: 'project', field: 'datasetSize' }, snapWith({}, { metadata: { datasetSize: null } })).text).toBeNull();
  });

  it('FR-DOC-02 (round 10): processesPersonalData prints Yes or No, never true or false', () => {
    const p = (v: string | null) => part('project', { kind: 'project', field: 'processesPersonalData' }, snapWith({}, { metadata: { processesPersonalData: v } }));
    expect(p('true').text).toMatch(/^Yes\b/);
    expect(p('false').text).toMatch(/^No\b/);
    expect(`${p('true').text}${p('false').text}`).not.toMatch(/true|false/);
    expect(p(null).text).toBeNull();
  });

  it('FR-DOC-02: the project name and description are fields a map may name', () => {
    const snap = snapshot({}, { project: { name: 'Malaria triage', description: 'A study.' } });
    expect(part('project', { kind: 'project', field: 'name' }, snap).text).toContain('Malaria triage');
    expect(part('project', { kind: 'project', field: 'description' }, snap).text).toContain('A study.');
  });

  it('FR-DOC-03 (D5, MC-18): a typed metric prints as typed, with its mark', () => {
    const r = resolveFields(modelCardMap, snapWith({}), { 'MC-18': 'accuracy 0.81' });
    expect(text(r, 'MC-18')).toContain('accuracy 0.81');
    expect(text(r, 'MC-18')).toContain(TYPED_MARK);
  });

  it('FR-DOC-03 (CG-10): the ethics review reads its sub-fields and prints each state', () => {
    const at = (typed: Record<string, string>) => text(resolveFields(dataCardMap, snapWith({}), typed), 'DC-15');
    expect(at({ 'DC-15:state': 'approved', 'DC-15:committee': 'MakREC', 'DC-15:reference': 'REC-1', 'DC-15:date': '2026-03-02' })).toContain('Approved (committee: MakREC; reference: REC-1; date: 2026-03-02)');
    expect(at({ 'DC-15:state': 'submitted' })).toContain('Submitted, awaiting decision');
    expect(at({ 'DC-15:state': 'not_required', 'DC-15:why': 'No people', 'DC-15:decidedBy': 'Supervisor' })).toContain('Not required (why: No people; decided by: Supervisor)');
    expect(at({ 'DC-15:state': 'approved', 'DC-15:committee': 'MakREC' })).toContain(`reference: ${NOT_RECORDED}`);
    expect(at({})).toBeNull();
    expect(at({ 'DC-15:state': 'approved' })).toContain(TYPED_MARK);
  });

  it('FR-DOC-02 (meta): the seals field names who sealed and how many people entered the decisions; the fingerprint is in groups of four', () => {
    const r = resolveFields(dataCardMap, snapWith({}), {});
    expect(text(r, 'DC-33')).toContain('sealed');
    expect(text(r, 'DC-33')).toMatch(/entered by \d+ (person|people)/);
    expect(text(r, 'DC-33')).toContain(formatFingerprint(FINGERPRINT, 'full'));
  });

  it('FR-DOC-05 (meta): the seals field lists only the seals the document used, the chosen one first', () => {
    const r = resolveFields(modelCardMap, snapIpOnly(), {});
    const t = text(r, 'MC-31') as string;
    expect(t.match(/Fingerprint/g)).toHaveLength(1);
    expect(t).toContain('In-processing review 1');
    expect(r.sealIds).toEqual(['seal-in-processing']);
  });

  it('FR-DOC-02 (meta): the deciders field lists the distinct deciders of the extracts the document prints', () => {
    const r = resolveFields(dataCardMap, snapWith({
      'Q-PP-08': decision({ v: 1, decidedBy: { kind: 'member', name: 'Amina N.' } }), 'Q-IP-01': decision({ v: 1, decidedBy: { kind: 'outside_role', role: 'supervisor' } }),
      'Q-PP-13': decision({ v: 1, decidedBy: { kind: 'member', name: 'Amina N.' } }),
    }), {});
    const t = text(r, 'DC-32') as string;
    expect(t.match(/Amina N\./g)).toHaveLength(1);
    expect(t).not.toContain('Supervisor');   // Q-IP-01 feeds no data card field, so its decider is not printed
    expect(text(resolveFields(dataCardMap, snapWith({}), {}), 'DC-32')).toBeNull();
  });
});

describe('findings, mitigations and accepted risks', () => {
  function withFindings(): DocumentSnapshot {
    const snap = snapshot({}, { reviewStage: 'in-processing' });
    const stage = snap.stages['in-processing'] as SealedStage;
    const base = { projectId: 'p', stage: 'in-processing' as const, raisedBy: user('Amina N.'), raisedAt: '2026-10-01T00:00:00.000Z', openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0, decisionVersionId: null, questionId: null };
    const mitigation = (status: 'done' | 'planned') => ({
      id: `mv-${status}`, findingId: 'f1', mitigationId: 'm1', versionNumber: 1, baseVersionNumber: null, what: 'Reweight the sample.', changeNote: null, owner: user('Joan K.'),
      dueDate: '2026-12-01', status, kind: 'action' as const, followsControl: null, closureNote: status === 'done' ? 'Checked on the held-out set.' : null,
      closureDecisionVersionId: null, cancelReason: null, enteredBy: user('Joan K.'), enteredByRole: 'assessor' as const, findingSeq: 2, receivedAt: '2026-10-02T00:00:00.000Z', evidence: [], erasedFields: [],
    });
    (stage as { findings: unknown }).findings = [
      { finding: { ...base, id: 'f1', source: 'team', riskArea: 'IP-01', title: 'Subgroup gap', description: 'Recall is lower for children.', state: 'closed_mitigation' }, mitigations: [mitigation('done')], acceptedRisk: null, events: [] },
      { finding: { ...base, id: 'f2', source: 'team', riskArea: 'IP-09', title: 'Elsewhere', description: 'Other area.', state: 'open' }, mitigations: [mitigation('planned')], acceptedRisk: null, events: [] },
      { finding: { ...base, id: 'f3', source: 'team', riskArea: 'IP-02', title: 'Residual', description: 'Accepted for now.', state: 'closed_accepted_risk' }, mitigations: [], events: [],
        acceptedRisk: { id: 'ar1', findingId: 'f3', acceptedBy: { kind: 'outside_role', role: 'supervisor' }, accepterRole: null, reason: 'Low impact.', lookAgainNote: null, lookAgainOn: '2027-01-15', enteredBy: user('Joan K.'), enteredByRole: 'owner', findingSeq: 3, receivedAt: '2026-10-03T00:00:00.000Z', erasedFields: [] } },
    ];
    return snap;
  }

  it('FR-DOC-02 (10.3.1): findings print their source, risk area, title, description and state, only for the map\'s risk areas', () => {
    const r = resolveFields(modelCardMap, withFindings(), {});
    const t = text(r, 'MC-23') as string;
    expect(t).toContain('Subgroup gap');
    expect(t).toContain('Recall is lower for children.');
    expect(t).toContain('Raised by the team');
    expect(t).toContain('IP-01');
    expect(t).toMatch(/Closed by a mitigation/);
    expect(t).toContain('Residual');
    expect(t).not.toContain('Elsewhere');
    expect(r.sources).toEqual(expect.arrayContaining([{ sourceTable: 'findings', sourceId: 'f1', field: 'title' }, { sourceTable: 'findings', sourceId: 'f1', field: 'description' }]));
  });

  it('FR-DOC-02: mitigations marked done print what, owner, due date and the closure note; accepted risks print who, why and the date to look again', () => {
    const r = resolveFields(modelCardMap, withFindings(), {});
    const m = text(r, 'MC-24') as string;
    expect(m).toContain('Reweight the sample.');
    expect(m).toContain('Joan K.');
    expect(m).toContain('1 Dec 2026');
    expect(m).toContain('Checked on the held-out set.');
    expect(r.sources).toEqual(expect.arrayContaining([{ sourceTable: 'mitigation_versions', sourceId: 'mv-done', field: 'what' }, { sourceTable: 'mitigation_versions', sourceId: 'mv-done', field: 'closureNote' }]));
    const a = text(r, 'MC-25') as string;
    expect(a).toContain('Low impact.');
    expect(a).toContain('15 Jan 2027');
    expect(a).toContain('Recorded by Joan K. as decided by Supervisor. The Supervisor did not record this in the platform.');
    expect(r.sources).toEqual(expect.arrayContaining([{ sourceTable: 'accepted_risks', sourceId: 'ar1', field: 'reason' }]));
  });

  it('FR-DOC-02 (7.5.8): an empty list prints None', () => {
    const r = resolveFields(modelCardMap, snapshot({}, { reviewStage: 'in-processing' }), {});
    expect(text(r, 'MC-23')).toBe('None');
    expect(text(r, 'MC-25')).toBe('None');
  });
});

describe('boundaries', () => {
  it('FR-DOC-02 (B37, R12-1): the project resolver takes its display words from lib/project/labels.ts and holds none of them', () => {
    const src = readFileSync('lib/documents/resolve.ts', 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bDATASET_SIZE_WORDS\b[^}]*\}\s*from\s*'[^']*project\/labels'/);
    expect(src).toMatch(/import\s*\{[^}]*\bPERSONAL_DATA_WORDS\b[^}]*\}\s*from\s*'[^']*project\/labels'/);
    expect(src).not.toMatch(/Under 1,000|Over 1 million|1,000 to 100,000/);
    expect(existsSync('lib/project/labels.ts')).toBe(true);
  });

  it('DOC-b boundary: the mitigation-plan-only sources throw NotImplementedError(DOC-b)', () => {
    const snap = snapWith({});
    expect(() => part('meta', { kind: 'meta', item: 'no_decision' }, snap)).toThrow(/Not implemented/);
    expect(() => part('meta', { kind: 'meta', item: 'review' }, snap)).toThrow();
    expect(() => part('mapping', { kind: 'mapping' }, snap)).toThrow();
    expect(() => part('findings', { kind: 'findings', stage: 'review', filter: 'open' }, snap)).toThrow();
    expect(() => part('mitigations', { kind: 'mitigations', stage: 'review', filter: 'counts' }, snap)).toThrow();
    try { part('meta', { kind: 'meta', item: 'no_decision' }, snap); } catch (e) { expect((e as { extra?: { unit?: string } }).extra?.unit).toBe('DOC-b'); }
  });

  it('FR-PUB-01 FR-DOC-02 (SRS 7.5.3): nothing the resolver prints for a decided data card holds a claim word, or a form of "fail"', () => {
    const decided = Object.fromEntries(['Q-PP-08', 'Q-PP-12', 'Q-PP-13', 'Q-PP-18', 'Q-PP-21'].map((q) => [q, decision({ v: 1, status: 'done', reason: 'A plain reason.', evidence: [file(`ev-${q}`)] })]));
    const r = resolveFields(dataCardMap, snapWith(decided, { metadata: { fundingSource: 'GIZ', datasetSize: 'unknown', processesPersonalData: 'true' } }), {});
    const all = r.fields.map((f) => `${f.text ?? ''}\n${f.provenance}`).join('\n');
    expect(claimMatches(all)).toEqual([]);
    expect(all).not.toMatch(/fail/i);
  });
});
