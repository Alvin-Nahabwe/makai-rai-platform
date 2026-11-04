import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintHex, canonicalManifestBytes } from '@/lib/integrity/canonical.mjs';
import { manifestFromRows, checkSealRows, type ManifestPlan, type SealSourceRows } from '@/lib/integrity/sealCheck.mjs';
import { stripAnsi } from '@/__tests__/helpers/spawnText';

/**
 * The frozen `makrai.seal/1` test vectors (SRS 5.4, line 1276). Each file holds rows in `row_to_json` form, the plan
 * that names them, and the bytes and fingerprint they must give. The bytes never change once a real seal exists
 * (R-45): a failure here is a defect in the module, never a reason to edit a vector.
 */
interface Vector { name: string; covers: string; rows: SealSourceRows; plan: ManifestPlan; manifestBase64: string; fingerprint: string }

const DIR = 'docs/formats/seal-1-vectors';
const vectorNames = () => readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const vector = (name: string): Vector => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
const readVectors = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => vector(f.replace(/\.json$/, '')));

describe('docs/formats/seal-1-vectors', () => {
  it('NFR-INT-05 FR-REV-03 (5.4): every committed vector gives its frozen bytes and fingerprint', () => {
    for (const v of readVectors(DIR)) {
      const bytes = canonicalManifestBytes(manifestFromRows(v.rows, v.plan));
      expect(Buffer.from(bytes).toString('base64'), v.name).toBe(v.manifestBase64);
      expect(fingerprintHex(bytes), v.name).toBe(v.fingerprint);
      expect(checkSealRows({ manifestBytes: bytes, fingerprint: v.fingerprint, rows: v.rows, tombstones: [] }).kind, v.name).toBe('valid');
      expect(vector(v.name).name).toBe(v.name);
    }
    expect(vectorNames()).toEqual(['01-two-content-versions', '02-withdrawn-and-gate', '03-cancelled-mitigation', '04-reopened-finding', '05-reverse-order', '06-nulls-and-link']);
    expect(vector('05-reverse-order').manifestBase64).toBe(vector('01-two-content-versions').manifestBase64);
  });

  it('NFR-INT-05 (5.4): the vectors cover two content versions, a withdrawal, a gate, a cancelled mitigation, a reopen and every null', () => {
    const m = (name: string) => JSON.parse(Buffer.from(vector(name).manifestBase64, 'base64').toString('utf8'));
    const semvers = new Set(m('01-two-content-versions').decisions.filter((d: { id?: string }) => d.id).map((d: { content: { semver: string } }) => d.content.semver));
    expect([...semvers].sort()).toEqual(['0.0.1-fixture', '0.0.2-fixture']);
    const v02 = m('02-withdrawn-and-gate').decisions;
    expect(v02.some((d: { none?: boolean; withdrawal?: string | null }) => d.none && d.withdrawal !== null)).toBe(true);
    expect(v02.filter((d: { derived?: string }) => d.derived === 'not_applicable_gate').map((d: { question: string }) => d.question)).toEqual(['Q-PP-13', 'Q-PP-14']);
    expect(m('03-cancelled-mitigation').findings.flatMap((f: { mitigations: { status: string; cancelReason: unknown }[] }) => f.mitigations)
      .some((x: { status: string; cancelReason: unknown }) => x.status === 'cancelled' && x.cancelReason !== null)).toBe(true);
    const v04 = m('04-reopened-finding').findings[0];
    expect(v04.events.map((e: { kind: string }) => e.kind)).toContain('reopened');
    expect(v04.state).toBe('open');
    expect(v04.mitigations.some((x: { status: string }) => x.status === 'done')).toBe(true);
    // Vector 06: every key the format allows to be null is null somewhere, and a link is present.
    const nulls = new Set<string>();
    const walk = (node: unknown, path: string) => {
      if (node === null) { nulls.add(path); return; }
      if (Array.isArray(node)) { node.forEach((n) => walk(n, `${path}[]`)); return; }
      if (typeof node === 'object') for (const [k, v] of Object.entries(node as object)) walk(v, `${path}.${k}`);
    };
    walk(m('06-nulls-and-link'), '$');
    expect([...nulls].sort()).toEqual([
      '$.decisions[].decidedBy.outsideRole', '$.decisions[].decidedBy.userId', '$.decisions[].evidence[].fileName', '$.decisions[].evidence[].sha256',
      '$.decisions[].reason', '$.decisions[].reasonCode', '$.decisions[].scopeAnswer', '$.decisions[].status', '$.decisions[].withdrawal',
      '$.findings[].acceptedRisk', '$.findings[].acceptedRisk.accepterRole', '$.findings[].acceptedRisk.acceptedBy.userId', '$.findings[].acceptedRisk.lookAgainDate',
      '$.findings[].acceptedRisk.lookAgainNote', '$.findings[].acceptedRisk.reason', '$.findings[].decisionVersion', '$.findings[].description',
      '$.findings[].events[].reason', '$.findings[].mitigations[].cancelReason', '$.findings[].mitigations[].changeNote',
      '$.findings[].mitigations[].closureNote', '$.findings[].mitigations[].evidence[].label', '$.findings[].mitigations[].evidence[].url',
      '$.findings[].mitigations[].followsControl', '$.findings[].mitigations[].what', '$.findings[].question', '$.findings[].riskArea',
      '$.findings[].title', '$.seal.preparedFor',
    ].sort());
    expect(m('06-nulls-and-link').decisions.flatMap((d: { evidence?: { kind: string }[] }) => d.evidence ?? []).map((e: { kind: string }) => e.kind)).toContain('link');
  });

  it('NFR-INT-05: the vectors give the same bytes under Africa/Nairobi and America/Los_Angeles in plain node', () => {
    for (const TZ of ['Africa/Nairobi', 'America/Los_Angeles']) {
      const env: NodeJS.ProcessEnv = { ...process.env, TZ, NO_COLOR: '1' };
      delete env.FORCE_COLOR;
      const out = stripAnsi(execFileSync('node', ['docs/formats/seal-1-vectors/verify.mjs'], { env }).toString()).trim().split('\n');
      expect(out, TZ).toEqual(vectorNames().map((n) => `ok ${n}`));
    }
  });
});
