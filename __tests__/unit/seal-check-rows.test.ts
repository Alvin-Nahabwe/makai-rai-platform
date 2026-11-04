import { describe, it, expect } from 'vitest';
import { saltedDigestHex, fingerprintHex, canonicalManifestBytes } from '@/lib/integrity/canonical.mjs';
import {
  SEAL_SOURCE_TABLES, SEAL_SOURCE_SQL, manifestFromRows, planFromManifest, manifestIds, checkSealRows,
  type ManifestPlan, type SealSourceRows, type SealSourceTable, type TombstoneRow,
} from '@/lib/integrity/sealCheck.mjs';
import { deriveFindingState } from '@/lib/findings/state';
import { markerText, MARKER_PATTERN } from '@/__tests__/helpers/markers';
import type { FindingEventKind, MitigationStatus } from '@/types/record';

/**
 * Rows in `row_to_json` form, as PostgreSQL writes them with `TimeZone` UTC (contract row
 * "lib/integrity/sealCheck.mjs and .d.mts"): every column of K0a's migration
 * `20261030000300_v060_03_tenant`, timestamptz as `...+00:00` text with trailing zeros of the
 * fraction dropped, bytea as `\x` hex, date as `YYYY-MM-DD`. Question ids are H0's fixture ids
 * (G-17); no content is loaded, the content rows are the fixture's `framework_versions` rows.
 */
type Row = Record<string, unknown>;
type Rows = Record<SealSourceTable, Row[]>;

const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const SALT_HEX = '\\x000102030405060708090a0b0c0d0e0f';
const H1 = '5915cd9a6043feaa4a4d4855e95ba4bdf4f5b22a37d29eeb9fd0e4007dd41e59';
const H2 = '77dea45aa744f7d9a1631fc3d862d7fa3d1eb299e30c9338cf72a21c2b2d6c52';
const ORG = 'org-a';
const P1 = 'p-1';
const R1 = 'r-1';
const S1 = 's-1';
const FV1 = 'fv_fixture_0_0_1';
const FV2 = 'fv_fixture_0_0_2';
const V1 = 'dv-q01-v2';
const V1_OLD = 'dv-q01-v1';
const V2 = 'dv-q02-v1';
const GATE_V = 'dv-gate-v1';
const E1 = 'ev-file-1';
const E2 = 'ev-link-1';
const F1 = 'fd-1';
const EV1 = 'fe-1';
const MV1 = 'mv-1';
const REQ = '3f2b8c1e-5a47-4d0b-9e61-7c2d4a9b0f13';

const frameworkRow = (id: string, semver: string, contentHash: string): Row => ({
  id, semver, contentHash, publishedAt: '2026-10-30T00:00:00+00:00', status: 'published', createdAt: '2026-10-30T00:00:00+00:00',
});
const decisionRow = (o: Row): Row => ({
  id: 'dv', orgId: ORG, projectId: P1, stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: FV1,
  versionNumber: 1, baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null,
  reason: 'Fixture reason', reasonSalt: SALT_HEX, decidedByUserId: 'u-1', decidedByRole: null, declaredOn: '2026-10-01',
  declaredPrecision: 'month', withdrawalCode: null, enteredById: 'u-1', enteredByRole: 'assessor',
  receivedAt: '2026-11-02T09:00:00+00:00', requestId: REQ, requestDigest: 'a'.repeat(64), ...o,
});
const evidenceRow = (o: Row): Row => ({
  id: 'ev', orgId: ORG, assessmentId: null, frameworkVersionId: null, questionId: null, remediationItemId: null,
  filename: null, mimeType: null, byteSize: null, sha256: null, uploadedById: 'u-1', uploadedAt: '2026-11-01T08:00:00.5+00:00',
  projectId: P1, kind: 'file', filenameSalt: SALT_HEX, url: null, urlSalt: SALT_HEX, label: null, labelSalt: SALT_HEX,
  requestId: REQ, requestDigest: 'b'.repeat(64), ...o,
});

const ROWS: Rows = {
  seals: [{ id: S1, orgId: ORG, stageReviewId: R1, sealNumber: 1, contentVersionId: FV1, sealedById: 'u-rev', sealedByRole: 'reviewer', sealedAt: '2026-11-02T10:42:00.5+00:00' }],
  stage_reviews: [{
    id: R1, orgId: ORG, projectId: P1, stage: 'pre-processing', numberInStage: 1, preparedFor: 'Journal submission',
    preparedForSalt: SALT_HEX, openedById: 'u-1', openedAt: '2026-11-02T08:00:00+00:00', requestId: REQ, requestDigest: 'c'.repeat(64),
  }],
  framework_versions: [frameworkRow(FV1, '0.0.1-fixture', H1), frameworkRow(FV2, '0.0.2-fixture', H2)],
  decision_versions: [
    decisionRow({ id: V1, questionId: 'Q-PP-01', versionNumber: 2, baseVersionNumber: 1, reason: 'Fixture reason 1', optionsInPlace: ['opt-b', 'opt-a'] }),
    decisionRow({ id: V2, questionId: 'Q-PP-02', status: 'partly', reason: 'Fixture reason 2', contentVersionId: FV2, receivedAt: '2026-11-02T09:05:00.25+00:00' }),
    decisionRow({ id: GATE_V, questionId: 'Q-PP-GATE-SENSITIVE', status: null, scopeAnswer: 'no', reason: 'Fixture reason gate', declaredOn: '2026-10-15', declaredPrecision: 'day' }),
  ],
  decision_evidence: [{ orgId: ORG, versionId: V1, evidenceId: E1 }],
  evidence: [
    evidenceRow({ id: E1, kind: 'file', filename: 'consent-form.pdf', mimeType: 'application/pdf', byteSize: 1024, sha256: 'e'.repeat(64) }),
    evidenceRow({ id: E2, kind: 'link', url: 'https://example.org/protocol', label: 'Protocol page', filenameSalt: null }),
  ],
  findings: [{
    id: F1, orgId: ORG, projectId: P1, stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-02', decisionVersionId: V2,
    riskArea: 'privacy', title: 'Fixture title 1', titleSalt: SALT_HEX, description: 'Fixture description 1', descriptionSalt: SALT_HEX,
    raisedById: 'u-1', raisedAt: '2026-11-02T09:05:00.25+00:00', requestId: REQ, requestDigest: 'a'.repeat(64),
  }],
  finding_events: [{
    id: EV1, orgId: ORG, findingId: F1, kind: 'reopened', eventCode: null, reason: 'Fixture reopen reason', reasonSalt: SALT_HEX,
    byId: 'u-1', at: '2026-11-02T09:10:00+00:00', findingSeq: 1, requestId: REQ, requestDigest: 'd'.repeat(64),
  }],
  mitigation_versions: [{
    id: MV1, orgId: ORG, findingId: F1, mitigationId: 'mt-1', versionNumber: 1, baseVersionNumber: null, what: 'Fixture what 1',
    whatSalt: SALT_HEX, changeNote: null, changeNoteSalt: SALT_HEX, ownerUserId: 'u-2', dueDate: '2026-12-01', status: 'planned',
    kind: 'action', followsControl: 'CTRL-01', closureNote: null, closureNoteSalt: SALT_HEX, closureDecisionVersionId: null,
    cancelReason: null, cancelReasonSalt: SALT_HEX, enteredById: 'u-1', enteredByRole: 'assessor', findingSeq: 2,
    receivedAt: '2026-11-02T09:15:00+00:00', requestId: REQ, requestDigest: 'f'.repeat(64),
  }],
  mitigation_evidence: [{ orgId: ORG, versionId: MV1, evidenceId: E2 }],
  accepted_risks: [],
};

/** ROWS plus what else the organisation holds: an older version of Q-PP-01, and a second project's rows. */
const ORG_ROWS: Rows = {
  ...ROWS,
  seals: [...ROWS.seals, { id: 's-2', orgId: ORG, stageReviewId: 'r-2', sealNumber: 1, contentVersionId: FV2, sealedById: 'u-1', sealedByRole: 'owner', sealedAt: '2026-11-01T10:00:00+00:00' }],
  stage_reviews: [...ROWS.stage_reviews, { ...ROWS.stage_reviews[0], id: 'r-2', projectId: 'p-2' }],
  decision_versions: [
    decisionRow({ id: V1_OLD, questionId: 'Q-PP-01', versionNumber: 1, reason: 'Fixture reason 0', receivedAt: '2026-11-01T09:00:00+00:00' }),
    ...ROWS.decision_versions,
    decisionRow({ id: 'dv-p2', projectId: 'p-2', questionId: 'Q-PP-02' }),
  ],
  decision_evidence: [...ROWS.decision_evidence, { orgId: ORG, versionId: V1_OLD, evidenceId: 'ev-old' }, { orgId: ORG, versionId: 'dv-p2', evidenceId: 'ev-p2' }],
  evidence: [...ROWS.evidence, evidenceRow({ id: 'ev-old', sha256: '1'.repeat(64) }), evidenceRow({ id: 'ev-p2', projectId: 'p-2', sha256: '2'.repeat(64) })],
  findings: [...ROWS.findings, { ...ROWS.findings[0], id: 'fd-p2', projectId: 'p-2', decisionVersionId: 'dv-p2' }],
};

const PLAN: ManifestPlan = {
  sealId: S1,
  questions: [
    { question: 'Q-PP-01', derivedFrom: null },
    { question: 'Q-PP-02', derivedFrom: null },
    { question: 'Q-PP-13', derivedFrom: GATE_V },
    { question: 'Q-PP-GATE-SENSITIVE', derivedFrom: null },
  ],
  ids: {
    decisionVersions: [GATE_V, V1, V2], evidence: [E2, E1], findings: [F1], findingEvents: [EV1],
    mitigationVersions: [MV1], acceptedRisks: [],
  },
};
// SealedIdSet arrays are sorted (contract): 'ev-link-1' < 'ev-file-1' is false, so sort once here.
PLAN.ids.evidence.sort();

const TIMESTAMP_COLUMNS = new Set(['receivedAt', 'at', 'raisedAt', 'openedAt', 'sealedAt', 'publishedAt', 'createdAt', 'uploadedAt']);

function mapRows(rows: Rows, f: (table: SealSourceTable, row: Row) => Row | null): Rows {
  return Object.fromEntries(SEAL_SOURCE_TABLES.map((t) => [t, rows[t].flatMap((r) => { const x = f(t, r); return x ? [x] : []; })])) as Rows;
}
const sourceRows = (rows: Rows) => rows as unknown as SealSourceRows;

/** The same instants written with a +03:00 offset, as row_to_json writes them under Africa/Nairobi. */
function inZone(rows: Rows, offset: '+03:00'): Rows {
  const hours = Number(offset.slice(0, 3));
  return mapRows(rows, (_t, r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (!TIMESTAMP_COLUMNS.has(k) || typeof v !== 'string') return [k, v];
    const shifted = new Date(new Date(v).getTime() + hours * 3_600_000).toISOString();   // local wall time
    const [whole, frac] = shifted.slice(0, -1).split('.');
    const f = frac.replace(/0+$/, '');
    return [k, `${whole}${f ? `.${f}` : ''}${offset}`];
  })));
}
const withReason = (rows: Rows, id: string, text: string | null): Rows =>
  mapRows(rows, (t, r) => (t === 'decision_versions' && r.id === id ? { ...r, reason: text, reasonSalt: text === null ? null : r.reasonSalt } : r));
const withoutRow = (rows: Rows, table: SealSourceTable, id: string): Rows => mapRows(rows, (t, r) => (t === table && r.id === id ? null : r));
function withPreviousReceivedAt(rows: Rows, id: string, at: string): Rows {
  const v = rows.decision_versions.find((r) => r.id === id)!;
  return mapRows(rows, (t, r) => (t === 'decision_versions' && r.projectId === v.projectId && r.questionId === v.questionId
    && r.versionNumber === (v.versionNumber as number) - 1 ? { ...r, receivedAt: at } : r));
}
function withErasedFile(rows: Rows, plan: ManifestPlan) {
  const bytes = canonicalManifestBytes(manifestFromRows(sourceRows(rows), plan));
  const tomb: TombstoneRow = { id: 'tb-1', orgId: ORG, targetTable: 'evidence', targetId: E1, field: null, digest: null, erasureCode: 'subject_request', instructionReference: 'INS-1', at: '2026-11-04T07:30:00+00:00' };
  return { manifestBytes: bytes, fingerprint: fingerprintHex(bytes), rows: sourceRows(rows), tombstones: [tomb] };
}
function STATE_INPUT_OF(rows: Rows) {
  const f = rows.findings[0];
  return {
    source: f.source as 'shortfall',
    events: rows.finding_events.filter((e) => e.findingId === f.id).map((e) => ({ kind: e.kind as FindingEventKind, findingSeq: e.findingSeq as number })),
    currentMitigations: rows.mitigation_versions.filter((m) => m.findingId === f.id).map((m) => ({ status: m.status as MitigationStatus, findingSeq: m.findingSeq as number })),
    acceptedRisks: rows.accepted_risks.filter((a) => a.findingId === f.id).map((a) => ({ findingSeq: a.findingSeq as number })),
  };
}
const sealed = (rows: Rows = ROWS) => canonicalManifestBytes(manifestFromRows(sourceRows(rows), PLAN));
const check = (bytes: Uint8Array, rows: Rows, tombstones: TombstoneRow[] = [], fingerprint = fingerprintHex(bytes)) =>
  checkSealRows({ manifestBytes: bytes, fingerprint, rows: sourceRows(rows), tombstones });

describe('lib/integrity/sealCheck.mjs: rows to manifest', () => {
  it('FR-REV-03 (5.4): manifestFromRows writes every key, digests for free text, the derived gate entry and the finding state', () => {
    const m = manifestFromRows(sourceRows(ROWS), PLAN);
    expect(m.format).toBe('makrai.seal/1');
    expect(m.decisions.find((d) => d.question === 'Q-PP-13')).toEqual({ question: 'Q-PP-13', derived: 'not_applicable_gate', from: GATE_V, content: { semver: '0.0.1-fixture', contentHash: H1 } });
    expect(m.decisions.find((d) => d.question === 'Q-PP-01')).toEqual({
      question: 'Q-PP-01', id: V1, number: 2, content: { semver: '0.0.1-fixture', contentHash: H1 }, status: 'done', scopeAnswer: null,
      optionsInPlace: ['opt-a', 'opt-b'], decidedBy: { userId: 'u-1', outsideRole: null }, declaredDate: '2026-10', declaredPrecision: 'month',
      reasonCode: null, enteredBy: 'u-1', enteredByRole: 'assessor', receivedAt: '2026-11-02T09:00:00.000Z',
      reason: { d: saltedDigestHex(SALT, 'reason', 'Fixture reason 1') },
      evidence: [{ id: E1, kind: 'file', sha256: 'e'.repeat(64), fileName: { d: saltedDigestHex(SALT, 'fileName', 'consent-form.pdf') }, url: null, label: null }],
    });
    expect(m.decisions.find((d) => d.question === 'Q-PP-02')).toMatchObject({ content: { semver: '0.0.2-fixture', contentHash: H2 }, status: 'partly' });
    expect(m.findings).toEqual([{
      id: F1, source: 'shortfall', question: 'Q-PP-02', decisionVersion: V2, riskArea: 'privacy',
      title: { d: saltedDigestHex(SALT, 'title', 'Fixture title 1') }, description: { d: saltedDigestHex(SALT, 'description', 'Fixture description 1') },
      state: 'open',
      events: [{ id: EV1, kind: 'reopened', findingSeq: 1, by: 'u-1', reason: { d: saltedDigestHex(SALT, 'reason', 'Fixture reopen reason') } }],
      mitigations: [{
        versionId: MV1, mitigationId: 'mt-1', number: 1, findingSeq: 2, kind: 'action', status: 'planned', owner: 'u-2', dueDate: '2026-12-01',
        followsControl: 'CTRL-01', what: { d: saltedDigestHex(SALT, 'what', 'Fixture what 1') }, changeNote: null, closureNote: null, cancelReason: null,
        enteredBy: 'u-1', enteredByRole: 'assessor',
        evidence: [{ id: E2, kind: 'link', sha256: null, fileName: null, url: { d: saltedDigestHex(SALT, 'url', 'https://example.org/protocol') }, label: { d: saltedDigestHex(SALT, 'label', 'Protocol page') } }],
      }],
      acceptedRisk: null,
    }]);
    expect(m.findings[0].state).toBe(deriveFindingState(STATE_INPUT_OF(ROWS)));
    expect(m.seal).toEqual({
      id: S1, number: 1, stageReviewId: R1, stage: 'pre-processing', preparedFor: { d: saltedDigestHex(SALT, 'preparedFor', 'Journal submission') },
      sealedBy: 'u-rev', sealedByRole: 'reviewer', sealedAt: '2026-11-02T10:42:00.500Z',
    });
    expect([m.project, m.organisation, m.content]).toEqual([P1, ORG, { semver: '0.0.1-fixture', contentHash: H1 }]);
    expect(manifestIds(m)).toEqual(PLAN.ids);
    expect(planFromManifest(m)).toEqual(PLAN);
  });

  it('FR-REV-06 (R2-21): every row of the organisation gives the same manifest as the named rows only', () => {
    expect(canonicalManifestBytes(manifestFromRows(sourceRows(ORG_ROWS), PLAN))).toEqual(sealed());
  });

  it('NFR-INT-05: rows written under +03:00 give the same bytes as rows written under UTC', () => {
    const shifted = inZone(ROWS, '+03:00');
    expect(shifted.decision_versions[0].receivedAt).toBe('2026-11-02T12:00:00+03:00');
    expect(canonicalManifestBytes(manifestFromRows(sourceRows(shifted), PLAN))).toEqual(sealed());
  });

  it('FR-REV-03 NFR-PRIV-03: manifest bytes hold no marker string, only digests of the text', () => {
    let seq = 0;
    const TEXT = new Set(['reason', 'filename', 'url', 'label', 'title', 'description', 'what', 'changeNote', 'closureNote', 'cancelReason', 'lookAgainNote', 'preparedFor']);
    const marked = mapRows(ROWS, (_t, r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, TEXT.has(k) && v !== null ? markerText(k, ++seq) : v])));
    const text = Buffer.from(canonicalManifestBytes(manifestFromRows(sourceRows(marked), PLAN))).toString('utf8');
    expect(seq).toBeGreaterThan(10);
    expect(text.match(MARKER_PATTERN)).toBeNull();
    expect(text).not.toContain('Fixture');
  });

  it('FR-REV-05 (R2-21, DOCA-MANIFESTIDS): lib/seal/ids.ts re-exports the pure manifestIds, so importers use the contract path', async () => {
    const viaIds = await import('@/lib/seal/ids');
    expect(viaIds.manifestIds).toBe(manifestIds);   // the same function as sealCheck.mjs's, not a copy
    expect(viaIds.manifestIds(manifestFromRows(sourceRows(ROWS), PLAN))).toEqual(PLAN.ids);
  });

  it('NFR-MNT-05 (R2-21): SEAL_SOURCE_SQL has one row_to_json query per source table and tombstones, each taking $1', () => {
    expect([...SEAL_SOURCE_TABLES]).toEqual(['seals', 'stage_reviews', 'framework_versions', 'decision_versions', 'decision_evidence', 'evidence', 'findings', 'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks']);
    expect(Object.keys(SEAL_SOURCE_SQL).sort()).toEqual([...SEAL_SOURCE_TABLES, 'tombstones'].sort());
    for (const [table, sql] of Object.entries(SEAL_SOURCE_SQL)) {
      expect(sql).toMatch(/^SELECT row_to_json\(t\) AS r FROM \w+ t WHERE /);
      expect(sql).toContain(`FROM ${table} t WHERE`);
      expect(sql).toContain('$1');
    }
    expect(SEAL_SOURCE_SQL.framework_versions).toBe('SELECT row_to_json(t) AS r FROM framework_versions t WHERE $1::text IS NOT NULL');
    expect(SEAL_SOURCE_SQL.decision_versions).toBe('SELECT row_to_json(t) AS r FROM decision_versions t WHERE t."orgId" = $1');
    expect(Object.isFrozen(SEAL_SOURCE_SQL) && Object.isFrozen(SEAL_SOURCE_TABLES)).toBe(true);
  });

  it('FR-REV-03 NFR-INT-05: a row lacking a column the manifest reads is refused, never written as a default', () => {
    const lacking = mapRows(ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'enteredByRole')) : r));
    expect(() => manifestFromRows(sourceRows(lacking), PLAN)).toThrow(/decision_versions has no column "enteredByRole"/);
  });
  it('FR-REV-03 NFR-INT-10: the builder refuses a plan naming a row the rows lack, never sealing the absence', () => {
    expect(() => manifestFromRows(sourceRows(withoutRow(ROWS, 'decision_versions', V2)), PLAN)).toThrow(/plan names decision_versions dv-q02-v1/);
    expect(() => manifestFromRows(sourceRows(withoutRow(ROWS, 'mitigation_versions', MV1)), PLAN)).toThrow(/plan names mitigation_versions mv-1/);
    expect(() => manifestFromRows(sourceRows({ ...ROWS, framework_versions: [ROWS.framework_versions[1]] }), PLAN)).toThrow(/framework_versions fv_fixture_0_0_1/);
    expect(() => manifestFromRows(sourceRows({ ...ROWS, stage_reviews: [] }), PLAN)).toThrow(/stage review/);
    expect(() => manifestFromRows(sourceRows({ ...ROWS, seals: [] }), PLAN)).toThrow(/seal s-1/);
  });

  it('FR-REV-03 FR-REV-05: the builder refuses a plan whose ids the manifest would not name exactly', () => {
    expect(() => manifestFromRows(sourceRows(ORG_ROWS), { ...PLAN, ids: { ...PLAN.ids, evidence: [...PLAN.ids.evidence, 'ev-old'].sort() } })).toThrow(/does not name exactly the plan's ids/);
    const twoOfOne = { ...PLAN, ids: { ...PLAN.ids, decisionVersions: [GATE_V, V1, V1_OLD, V2].sort() } };
    expect(() => manifestFromRows(sourceRows(ORG_ROWS), twoOfOne)).toThrow(/2 versions of Q-PP-01/);
  });

  it('NFR-INT-05: a timestamp that names no real instant is refused, not rolled over', () => {
    const at = (receivedAt: string) => mapRows(ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, receivedAt } : r));
    for (const bad of ['2026-02-30T09:00:00+00:00', '2026-11-02T25:00:00+00:00', '2026-11-02T09:60:00+00:00', '2026-11-02T09:00:00+99:99']) {
      expect(() => manifestFromRows(sourceRows(at(bad)), PLAN), bad).toThrow(/receivedAt is not a timestamp/);
    }
    // Year 50 is read as year 50, not as 1950 (Date.UTC's reading of years 0 to 99).
    expect(manifestFromRows(sourceRows(at('0050-11-02T09:00:00+00:00')), PLAN).decisions.find((d) => d.question === 'Q-PP-01'))
      .toMatchObject({ receivedAt: '0050-11-02T09:00:00.000Z' });
  });
});

describe('lib/integrity/sealCheck.mjs: checkSealRows', () => {
  it('FR-REV-06: rows equal to the seal check as valid with no erasure', () => {
    expect(check(sealed(), ORG_ROWS)).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] });
  });

  it('FR-REV-06: a changed reason names the first difference', () => {
    expect(check(sealed(), withReason(ORG_ROWS, V1, 'changed'))).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
  });

  it('FR-REV-06 NFR-INT-05: altered bytes read fingerprint_mismatch before anything else', () => {
    expect(check(sealed(), ORG_ROWS, [], '0'.repeat(64))).toEqual({ kind: 'fingerprint_mismatch' });
    const altered = sealed();
    altered[altered.length - 2] ^= 1;
    expect(check(altered, ORG_ROWS, [], fingerprintHex(sealed()))).toEqual({ kind: 'fingerprint_mismatch' });
  });

  it('FR-REV-06 FR-REV-08: an erased reason with a matching tombstone is valid with one field erased', () => {
    const tomb = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: saltedDigestHex(SALT, 'reason', 'Fixture reason 1'), at: '2026-11-03T09:00:00+00:00' };
    expect(check(sealed(), withReason(ORG_ROWS, V1, null), [tomb]))
      .toEqual({ kind: 'valid', erasedFields: 1, erasedFiles: 0, erasedOn: '2026-11-03', clockWarnings: [] });
  });

  it('FR-REV-06 FR-REV-08: a tombstone whose digest differs from the sealed digest reads mismatch, not erased', () => {
    const forged = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: 'f'.repeat(64), at: '2026-11-03T09:00:00+00:00' };
    expect(check(sealed(), withReason(ORG_ROWS, V1, null), [forged])).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
  });

  it('FR-REV-06 FR-REV-08: a tombstone with the sealed digest but naming another row or field reads mismatch, not erased', () => {
    const digest = saltedDigestHex(SALT, 'reason', 'Fixture reason 1');
    for (const misdirected of [
      { targetTable: 'decision_versions', targetId: V1_OLD, field: 'reason', digest, at: '2026-11-03T09:00:00+00:00' },
      { targetTable: 'finding_events', targetId: V1, field: 'reason', digest, at: '2026-11-03T09:00:00+00:00' },
      { targetTable: 'decision_versions', targetId: V1, field: 'title', digest, at: '2026-11-03T09:00:00+00:00' },
    ]) expect(check(sealed(), withReason(ORG_ROWS, V1, null), [misdirected])).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
  });

  it('FR-REV-06 FR-REV-08: a tombstone over a field still holding its text counts nothing', () => {
    const tomb = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: saltedDigestHex(SALT, 'reason', 'Fixture reason 1'), at: '2026-11-03T09:00:00+00:00' };
    expect(check(sealed(), ORG_ROWS, [tomb])).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] });
  });

  it('FR-EVD-05 FR-REV-06: erased evidence bytes count as an erased file and the seal still matches', () => {
    // evidence row keeps sha256; tombstone with field null
    expect(checkSealRows(withErasedFile(ROWS, PLAN))).toMatchObject({ kind: 'valid', erasedFields: 0, erasedFiles: 1, erasedOn: '2026-11-04' });
    const unnamed = withErasedFile(ROWS, PLAN);
    expect(checkSealRows({ ...unnamed, tombstones: [{ ...unnamed.tombstones[0], targetId: 'ev-old' }] })).toMatchObject({ kind: 'valid', erasedFiles: 0, erasedOn: null });
  });

  it('NFR-INT-04: a later version received before the previous one gives a clock warning, not a failure', () => {
    const rows = withPreviousReceivedAt(ORG_ROWS, V1, '2026-11-02T10:00:00+00:00');   // V1 received 2026-11-02T09:00:00+00:00
    expect(check(sealed(), rows)).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: ['decisions[Q-PP-01]'] });
  });

  it('FR-REV-06: a named row missing from the database reads mismatch at its entry', () => {
    expect(check(sealed(), withoutRow(ORG_ROWS, 'decision_versions', V2))).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-02]' });
    expect(check(sealed(), withoutRow(ORG_ROWS, 'mitigation_versions', MV1))).toEqual({ kind: 'mismatch', firstDifference: `findings[${F1}].mitigations[mt-1]` });
    expect(check(sealed(), withoutRow(ORG_ROWS, 'evidence', E1))).toEqual({ kind: 'mismatch', firstDifference: `decisions[Q-PP-01].evidence[${E1}]` });
  });

  it('FR-REV-06: a link row added after sealing reads mismatch at the entry the stored manifest lacks', () => {
    const added = { ...ORG_ROWS, decision_evidence: [...ORG_ROWS.decision_evidence, { orgId: ORG, versionId: V1, evidenceId: E2 }] };
    expect(check(sealed(), added)).toEqual({ kind: 'mismatch', firstDifference: `decisions[Q-PP-01].evidence[${E2}]` });
  });

  it('FR-REV-06: nested keys and the header are named by their path', () => {
    const otherUser = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, decidedByUserId: 'u-9' } : r));
    expect(check(sealed(), otherUser)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].decidedBy.userId' });
    const otherNote = mapRows(ORG_ROWS, (t, r) => (t === 'stage_reviews' && r.id === R1 ? { ...r, preparedFor: 'Other' } : r));
    expect(check(sealed(), otherNote)).toEqual({ kind: 'mismatch', firstDifference: 'seal.preparedFor' });
    const otherWhat = mapRows(ORG_ROWS, (t, r) => (t === 'mitigation_versions' ? { ...r, what: 'Other' } : r));
    expect(check(sealed(), otherWhat)).toEqual({ kind: 'mismatch', firstDifference: `findings[${F1}].mitigations[mt-1].what` });
  });

  it('FR-REV-06: an unparseable manifest, another format, or bytes that are not canonical read mismatch at format', () => {
    const notJson = new TextEncoder().encode('{"format":');
    expect(check(notJson, ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    const m = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    const other = new TextEncoder().encode(JSON.stringify({ ...m, format: 'makrai.seal/2' }));
    expect(check(other, ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    const spaced = new TextEncoder().encode(JSON.stringify(m, null, 2));
    expect(check(spaced, ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    for (const shape of [null, [], { ...m, decisions: 'x' }, { ...m, seal: null }, { ...m, findings: [{ id: F1 }] }]) {
      expect(check(new TextEncoder().encode(JSON.stringify(shape)), ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    }
  });
  it('FR-REV-06 FR-REV-08: a field erased before sealing is sealed as null and checks as valid, not as erased', () => {
    const bytes = sealed(withReason(ROWS, V1, null));
    const tomb = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: saltedDigestHex(SALT, 'reason', 'Fixture reason 1'), at: '2026-11-01T09:00:00+00:00' };
    expect(check(bytes, withReason(ORG_ROWS, V1, null), [tomb])).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] });
  });

  it('FR-REV-06 FR-REV-08: the result does not depend on the order of the tombstones', () => {
    const at = '2026-11-03T09:00:00+00:00';
    const genuine = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: saltedDigestHex(SALT, 'reason', 'Fixture reason 1'), at };
    const forged = { ...genuine, digest: 'f'.repeat(64) };
    const valid = { kind: 'valid', erasedFields: 1, erasedFiles: 0, erasedOn: '2026-11-03', clockWarnings: [] };
    expect(check(sealed(), withReason(ORG_ROWS, V1, null), [genuine, forged])).toEqual(valid);
    expect(check(sealed(), withReason(ORG_ROWS, V1, null), [forged, genuine])).toEqual(valid);
  });

  it('FR-EVD-05 FR-REV-06: an evidence-bytes tombstone on a link counts no erased file', () => {
    const input = withErasedFile(ROWS, PLAN);
    expect(checkSealRows({ ...input, tombstones: [{ ...input.tombstones[0], targetId: E2 }] })).toMatchObject({ kind: 'valid', erasedFiles: 0, erasedOn: null });
  });

  it('FR-REV-06: a readable manifest with a repeated entry reads mismatch at format, and rows naming two versions of one question read mismatch, never a crash', () => {
    const m = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    for (const repeated of [
      { ...m, decisions: [m.decisions[0], m.decisions[0], ...m.decisions.slice(1)] },
      { ...m, findings: [{ ...m.findings[0], mitigations: [m.findings[0].mitigations[0], m.findings[0].mitigations[0]] }] },
    ]) expect(check(new TextEncoder().encode(JSON.stringify(repeated)), ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    // V1_OLD relabelled as a version of Q-PP-02: the plan's two named versions now share one question.
    const relabelled = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, questionId: 'Q-PP-02' } : r));
    expect(check(sealed(), relabelled)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01]' });
  });

  it('FR-REV-06 (A7): in the check a text whose salt is gone reads mismatch at its path; the builder still refuses it', () => {
    const unsalted = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, reasonSalt: null } : r));
    expect(check(sealed(), unsalted)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
    expect(() => manifestFromRows(sourceRows(unsalted), PLAN)).toThrow(/has text but no salt/);
  });

  it('FR-REV-06 (A7): in the check a NULL element in a text array reads mismatch at its path; the builder still refuses it', () => {
    const holed = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, optionsInPlace: ['opt-a', null] } : r));
    expect(check(sealed(), holed)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].optionsInPlace' });
    expect(() => manifestFromRows(sourceRows(holed), PLAN)).toThrow(/optionsInPlace is not a text array/);
  });

  it('FR-REV-06 NFR-INT-05 (A7): in the check an instant or date PostgreSQL holds but the format cannot write reads mismatch at its path; the builder still refuses it', () => {
    // row_to_json's forms, read on the slot database: infinity, -infinity, a BC instant, a five-digit year.
    for (const v of ['infinity', '-infinity', '0044-03-15T10:00:00+00:00 BC', '10000-01-01T00:00:00+00:00']) {
      const rows = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, receivedAt: v } : r));
      expect(check(sealed(), rows), v).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].receivedAt' });
      expect(() => manifestFromRows(sourceRows(rows), PLAN), v).toThrow(/receivedAt is not a timestamp/);
      const sealedAt = mapRows(ORG_ROWS, (t, r) => (t === 'seals' && r.id === S1 ? { ...r, sealedAt: v } : r));
      expect(check(sealed(), sealedAt), v).toEqual({ kind: 'mismatch', firstDifference: 'seal.sealedAt' });
    }
    for (const v of ['infinity', '0044-03-15 BC', '10000-01-01']) {
      const rows = mapRows(ORG_ROWS, (t, r) => (t === 'mitigation_versions' ? { ...r, dueDate: v } : r));
      expect(check(sealed(), rows), v).toEqual({ kind: 'mismatch', firstDifference: `findings[${F1}].mitigations[mt-1].dueDate` });
      expect(() => manifestFromRows(sourceRows(rows), PLAN), v).toThrow(/dueDate is not a date/);
    }
  });

  it('NFR-INT-04 FR-REV-08: an unreadable time outside the named rows warns or stands for nothing, never throws', () => {
    const previous = withPreviousReceivedAt(ORG_ROWS, V1, 'infinity');
    expect(check(sealed(), previous)).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: ['decisions[Q-PP-01]'] });
    const tomb = { targetTable: 'decision_versions', targetId: V1, field: 'reason', digest: saltedDigestHex(SALT, 'reason', 'Fixture reason 1'), at: 'infinity' };
    expect(check(sealed(), withReason(ORG_ROWS, V1, null), [tomb])).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
  });

  it('FR-REV-06 (A7): a stored manifest carrying the check\'s own unreadable or ambiguous marker never reads valid', () => {
    const m = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    const q01 = m.decisions.findIndex((d: { question: string }) => d.question === 'Q-PP-01');
    const forgedTime = structuredClone(m);
    forgedTime.decisions[q01].receivedAt = { unreadable: true };
    const rows = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, receivedAt: 'infinity' } : r));
    expect(check(canonicalManifestBytes(forgedTime), rows)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    const forgedEntry = structuredClone(m);
    forgedEntry.decisions[q01] = { question: 'Q-PP-01', ambiguous: [V1_OLD, V1] };
    expect(check(canonicalManifestBytes(forgedEntry), ORG_ROWS)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
  });

  it('FR-REV-06 (A7): a value of the wrong type is a caller defect and throws in the check too; only text that does not parse reads as a mismatch', () => {
    const asDate = mapRows(ORG_ROWS, (t, r) => (t === 'seals' && r.id === S1 ? { ...r, sealedAt: new Date('2026-11-02T10:42:00.5Z') } : r));
    expect(() => check(sealed(), asDate)).toThrow(/seals.sealedAt is not a timestamp/);
    const tomb = { targetTable: 'evidence', targetId: E1, field: null, digest: null, at: new Date('2026-11-04T07:30:00Z') };
    expect(() => check(sealed(), ORG_ROWS, [tomb])).toThrow(/tombstones.at is not a timestamp/);
    const numbered = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, optionsInPlace: ['opt-a', 7] } : r));
    expect(() => check(sealed(), numbered)).toThrow(/optionsInPlace is not a text array/);
  });

  it('FR-REV-06 (A7): a stored manifest whose content or header was forged to null, with its rows deleted, reads mismatch', () => {
    const m = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    for (const d of m.decisions) if (d.content?.semver === '0.0.1-fixture') d.content = null;
    m.content = null;
    const noFv1 = { ...ORG_ROWS, framework_versions: ORG_ROWS.framework_versions.filter((r) => r.id !== FV1) };
    expect(check(canonicalManifestBytes(m), noFv1)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    const nullHeader = { ...JSON.parse(Buffer.from(sealed()).toString('utf8')), project: null, organisation: null };
    expect(check(canonicalManifestBytes(nullHeader), { ...ORG_ROWS, stage_reviews: [] })).toEqual({ kind: 'mismatch', firstDifference: 'format' });
    const fine = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    expect(check(sealed(), noFv1)).toEqual({ kind: 'mismatch', firstDifference: 'content' });
    expect(fine.content).not.toBeNull();
  });

  it('FR-REV-03: the builder refuses a plan whose ids are not in the form the manifest writes them (NFC)', () => {
    const decomposed = 'ev-z\u0301';
    const rows = mapRows(ROWS, (t, r) => (t === 'evidence' && r.id === E1 ? { ...r, id: decomposed }
      : t === 'decision_evidence' && r.evidenceId === E1 ? { ...r, evidenceId: decomposed } : r));
    const plan = { ...PLAN, ids: { ...PLAN.ids, evidence: [decomposed, E2].sort() } };
    expect(() => manifestFromRows(sourceRows(rows), plan)).toThrow(/does not name exactly the plan's ids/);
  });

  it('FR-REV-06 (A7): rows tampered past their constraints read mismatch in the check and throw in the builder', () => {
    const noDate = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, declaredOn: null } : r));
    expect(check(sealed(), noDate)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].declaredDate' });
    expect(() => manifestFromRows(sourceRows(noDate), PLAN)).toThrow(/declared date without its precision/);
    const week = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, declaredPrecision: 'week' } : r));
    expect(check(sealed(), week)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].declaredDate' });
    const noEnterer = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, enteredById: null } : r));
    expect(check(sealed(), noEnterer)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].enteredBy' });
    expect(() => manifestFromRows(sourceRows(noEnterer), PLAN)).toThrow(/enteredById is not text/);
    const noNumber = mapRows(ORG_ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, versionNumber: null } : r));
    expect(check(sealed(), noNumber)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].number' });
  });

  it('FR-REV-06 (A7): two named versions whose mitigation ids are equal after NFC read mismatch, not a throw', () => {
    const m = JSON.parse(Buffer.from(sealed()).toString('utf8'));
    const mv = m.findings[0].mitigations[0];
    m.findings[0].mitigations = [{ ...mv, mitigationId: 'mt-\u00e9' }, { ...mv, versionId: 'mv-2', mitigationId: 'mt-z' }];
    const rows = { ...ORG_ROWS, mitigation_versions: [
      { ...ORG_ROWS.mitigation_versions[0], mitigationId: 'mt-e\u0301' },
      { ...ORG_ROWS.mitigation_versions[0], id: 'mv-2', mitigationId: 'mt-\u00e9', findingSeq: 3 },
    ] };
    expect(check(canonicalManifestBytes(m), rows)).toEqual({ kind: 'mismatch', firstDifference: `findings[${F1}].mitigations` });
  });

  it('FR-REV-06 (A7): a second row with a named id (its primary key dropped) reads mismatch, whichever row comes first', () => {
    const v1 = ORG_ROWS.decision_versions.find((r) => r.id === V1)!;
    for (const order of ['before', 'after']) {
      const extra = { ...v1, reason: 'Tampered' };
      const list = ORG_ROWS.decision_versions;
      const rows = { ...ORG_ROWS, decision_versions: order === 'before' ? [extra, ...list] : [...list, extra] };
      expect(check(sealed(), rows), order).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01]' });
      expect(() => manifestFromRows(sourceRows(rows), PLAN), order).toThrow(/decision_versions holds two rows with id dv-q01-v2/);
    }
    const twoSeals = { ...ORG_ROWS, seals: [...ORG_ROWS.seals, { ...ORG_ROWS.seals[0], sealedById: 'u-other' }] };
    // The whole header is then unreadable, and content is first in canonical key order.
    expect(check(sealed(), twoSeals)).toEqual({ kind: 'mismatch', firstDifference: 'content' });
    const twoFv = { ...ORG_ROWS, framework_versions: [...ORG_ROWS.framework_versions, { ...ORG_ROWS.framework_versions[0], contentHash: '0'.repeat(64) }] };
    expect(check(sealed(), twoFv)).toEqual({ kind: 'mismatch', firstDifference: 'content' });
  });

  it('NFR-INT-05: an offset that moves an instant out of years 1 to 9999 is refused, not written in extended form', () => {
    for (const v of ['9999-12-31T23:00:00-15:00', '0001-01-01T00:30:00+15:00', '0000-06-01T00:00:00+00:00']) {
      const rows = mapRows(ROWS, (t, r) => (t === 'decision_versions' && r.id === V1 ? { ...r, receivedAt: v } : r));
      expect(() => manifestFromRows(sourceRows(rows), PLAN), v).toThrow(/receivedAt is not a timestamp/);
    }
  });
});
