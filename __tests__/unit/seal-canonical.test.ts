import { describe, it, expect } from 'vitest';
import { saltedDigestHex, fingerprintHex, canonicalManifestBytes, canonicalJson } from '@/lib/integrity/canonical.mjs';
import type { SealManifestV1, ManifestEvidence } from '@/types/seal';

const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const D = (n: number) => ({ d: n.toString(16).padStart(64, '0') });
const H1 = '5915cd9a6043feaa4a4d4855e95ba4bdf4f5b22a37d29eeb9fd0e4007dd41e59';

const EVIDENCE_B: ManifestEvidence = { id: 'e-b', kind: 'link', sha256: null, fileName: null, url: D(21), label: D(22) };
const EVIDENCE_A: ManifestEvidence = { id: 'e-a', kind: 'file', sha256: 'a'.repeat(64), fileName: D(23), url: null, label: null };

/** Three decisions, two options, two mitigations and two evidence lists, each written out of order. */
const MANIFEST_FIXTURE: SealManifestV1 = {
  format: 'makrai.seal/1',
  seal: {
    id: 's-1', number: 1, stageReviewId: 'r-1', stage: 'pre-processing', preparedFor: D(1),
    sealedBy: 'u-1', sealedByRole: 'reviewer', sealedAt: '2026-11-02T10:42:00.000Z',
  },
  project: 'p-1',
  organisation: 'o-1',
  content: { semver: '0.0.1-fixture', contentHash: H1 },
  decisions: [
    { question: 'Q-PP-13', derived: 'not_applicable_gate', from: 'v-gate', content: { semver: '0.0.1-fixture', contentHash: H1 } },
    {
      question: 'Q-PP-01', id: 'v-1', number: 2, content: { semver: '0.0.1-fixture', contentHash: H1 },
      status: 'done', scopeAnswer: null, optionsInPlace: ['B option', 'A option'],
      decidedBy: { userId: 'u-1', outsideRole: null }, declaredDate: '2026-10', declaredPrecision: 'month',
      reasonCode: null, enteredBy: 'u-1', enteredByRole: 'assessor', receivedAt: '2026-11-02T09:00:00.000Z',
      reason: D(2), evidence: [EVIDENCE_B, EVIDENCE_A],
    },
    { question: 'Q-PP-02', none: true, withdrawal: null },
  ],
  findings: [
    {
      id: 'f-1', source: 'shortfall', question: 'Q-PP-01', decisionVersion: 'v-1', riskArea: null,
      title: D(3), description: null, state: 'open',
      events: [],
      mitigations: [
        {
          versionId: 'mv-2', mitigationId: 'm-2', number: 1, findingSeq: 2, kind: 'action', status: 'planned',
          owner: 'u-2', dueDate: '2026-12-01', followsControl: null, what: D(4), changeNote: null,
          closureNote: null, cancelReason: null, enteredBy: 'u-1', enteredByRole: 'assessor', evidence: [],
        },
        {
          versionId: 'mv-1', mitigationId: 'm-1', number: 1, findingSeq: 1, kind: 'action', status: 'in_progress',
          owner: 'u-2', dueDate: '2026-12-01', followsControl: 'C-1', what: D(5), changeNote: null,
          closureNote: null, cancelReason: null, enteredBy: 'u-1', enteredByRole: 'assessor', evidence: [EVIDENCE_B, EVIDENCE_A],
        },
      ],
      acceptedRisk: null,
    },
  ],
};

/** A deep copy with every array reversed, at every depth. */
function reverseEveryArray<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseEveryArray).reverse() as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reverseEveryArray(v)])) as T;
  }
  return value;
}

describe('lib/integrity/canonical.mjs: digests, fingerprint and manifest bytes', () => {
  it('FR-REV-03 NFR-MNT-05 (5.4): the salted digest is SHA-256(salt, 0x00, field, 0x00, UTF-8(NFC(text)))', () => {
    expect(saltedDigestHex(SALT, 'reason', 'Café ZZ')).toBe('9e87cc554bffec891093a67095d8f2b7f67d09fc52b9e2350dc6a707ed81b9c5'); // contract E-14
    expect(saltedDigestHex(SALT, 'reason', 'Café ZZ')).toBe('9e87cc554bffec891093a67095d8f2b7f67d09fc52b9e2350dc6a707ed81b9c5'); // NFC first
    expect(saltedDigestHex(SALT, 'preparedFor', 'Journal submission')).toBe('a788b94d5dedd5acd8bdbc9dbc4f301db5fce47faf2aaf1e9468c3e872bdbe29');
    expect(saltedDigestHex(SALT, 'reason', 'x')).not.toBe(saltedDigestHex(SALT, 'title', 'x'));
  });

  it('FR-REV-03 (5.4): the fingerprint is lowercase hex SHA-256 of the bytes', () => {
    expect(fingerprintHex(Buffer.from('{}'))).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('FR-REV-03 NFR-INT-05 (5.4): every array is sorted by its key, options sorted, the input order never matters', () => {
    const a = canonicalManifestBytes(MANIFEST_FIXTURE);
    const b = canonicalManifestBytes(reverseEveryArray(MANIFEST_FIXTURE));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const m = JSON.parse(Buffer.from(a).toString('utf8'));
    expect(m.decisions.map((d: { question: string }) => d.question)).toEqual(['Q-PP-01', 'Q-PP-02', 'Q-PP-13']);
    expect(m.decisions[0].optionsInPlace).toEqual(['A option', 'B option']);
    expect(m.decisions[0].evidence.map((e: { id: string }) => e.id)).toEqual(['e-a', 'e-b']);
    expect(m.findings[0].mitigations.map((x: { mitigationId: string }) => x.mitigationId)).toEqual(['m-1', 'm-2']);
    expect(m.findings[0].mitigations[0].evidence.map((e: { id: string }) => e.id)).toEqual(['e-a', 'e-b']);
    expect(Buffer.from(a).toString('utf8')).toBe(canonicalJson(m));
  });

  it('FR-REV-03 NFR-INT-05 (5.4): two entries with the same sort key are refused, so the bytes never depend on input order', () => {
    const twice = { ...MANIFEST_FIXTURE, decisions: [...MANIFEST_FIXTURE.decisions, { question: 'Q-PP-02', none: true as const, withdrawal: 'v-9' }] };
    expect(() => canonicalManifestBytes(twice)).toThrow(/decisions holds "Q-PP-02" twice/);
  });

  it('FR-REV-03 (5.4): canonicalManifestBytes leaves its input unchanged', () => {
    const before = JSON.stringify(MANIFEST_FIXTURE);
    canonicalManifestBytes(MANIFEST_FIXTURE);
    expect(JSON.stringify(MANIFEST_FIXTURE)).toBe(before);
  });
});
