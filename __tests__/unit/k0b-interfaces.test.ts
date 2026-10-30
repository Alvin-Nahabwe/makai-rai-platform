import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { CONTENT_BUNDLE_FILES, hashBundleFiles, computeVersionBundleHash } from '@/lib/content/bundleHash';
import { STUB_LEGAL_TEXTS, fixtureLegalTexts, stubAcceptanceRows } from '@/__tests__/helpers/legalStub';

const sha256 = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('K0b interfaces', () => {
  it('NFR-OBS-01: SecurityEvent holds every v0.6.0 event name', () => {
    const src = readFileSync('lib/security-logger.ts', 'utf8');
    for (const e of ['DECISION_SAVED','DECISION_WITHDRAWN','FINDING_RAISED','FINDING_CLOSED','RISK_ACCEPTED','SEAL_CREATED',
      'SEAL_CHECK_FAILED','DOCUMENT_ISSUED','DOCUMENT_WITHDRAWN','DOCUMENT_INTEGRITY_FAILURE','EXPORT_MADE','ACCOUNT_DELETED',
      'REMINDER_RUN','PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED','SIGN_IN_ALERT']) expect(src).toContain(`'${e}'`);
  });

  it('NFR-OBS-01: every event name that existed before v0.6.0 is still in SecurityEvent', () => {
    const src = readFileSync('lib/security-logger.ts', 'utf8');
    for (const e of ['AUTH_LOGIN_SUCCESS','AUTH_LOGIN_FAILURE','AUTH_ACCOUNT_LOCKED','AUTH_REGISTER','AUTH_LOGOUT',
      'AUTH_LOGOUT_EVERYWHERE','AUTH_PASSWORD_CHANGED','RATE_LIMIT_EXCEEDED','AUTH_TOKEN_DECODE_FAILURE',
      'INPUT_VALIDATION_FAILURE','ADMIN_ACTION','ASSESSMENT_CREATED','ASSESSMENT_COMPLETED','EVIDENCE_UPLOADED',
      'EVIDENCE_DELETED','EVIDENCE_INTEGRITY_FAILURE','ACCOUNT_DEACTIVATED','ORG_MEMBER_ACTION']) expect(src).toContain(`'${e}'`);
  });

  describe('lib/content/bundleHash', () => {
    let dir: string;
    const bytesOf = (f: string) => Buffer.from(`file ${f}\n{"n":1}\n`);
    const FIVE_LINES = () => CONTENT_BUNDLE_FILES.map((f) => `${f}:${sha256(bytesOf(f))}`);
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'bundle-hash-'));
      for (const f of CONTENT_BUNDLE_FILES) writeFileSync(join(dir, f), bytesOf(f));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('NFR-MNT-07 FR-CNT-01 (helper): hashBundleFiles follows the 4.0.0 formula over the five files and reads nothing itself', () => {
      expect(CONTENT_BUNDLE_FILES).toEqual(['assessmentAreas.json','projectConfig.json','questionBank.json','reasonCodes.json','documentHelp.json']);
      const asked: string[] = [];
      const read = (f: string) => { asked.push(f); return Buffer.from(`bytes of ${f}`); };            // in-memory reader, no file system
      expect(hashBundleFiles(read)).toBe(sha256(CONTENT_BUNDLE_FILES.map((f) => `${f}:${sha256(`bytes of ${f}`)}`).join('\n')));
      expect(asked).toEqual([...CONTENT_BUNDLE_FILES]);
    });

    it('NFR-MNT-07 FR-CNT-01 (helper): computeVersionBundleHash reads the five files of a directory through hashBundleFiles', () => {
      expect(computeVersionBundleHash(dir)).toBe(sha256(FIVE_LINES().join('\n')));
      expect(computeVersionBundleHash(dir)).toBe(hashBundleFiles((f) => readFileSync(join(dir, f))));
    });

    it('NFR-MNT-07 FR-CNT-01 (helper): a changed byte in any one file changes the hash, and a missing file is an ENOENT', () => {
      const base = computeVersionBundleHash(dir);
      for (const changed of CONTENT_BUNDLE_FILES) {
        const other = hashBundleFiles((f) => (f === changed ? Buffer.from('x') : bytesOf(f)));
        expect(other, changed).not.toBe(base);
      }
      const empty = mkdtempSync(join(tmpdir(), 'bundle-hash-empty-'));
      try {
        expect(() => computeVersionBundleHash(empty)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      } finally { rmSync(empty, { recursive: true, force: true }); }
    });

    it('NFR-MNT-07 FR-CNT-01 (helper): the module imports only node:crypto, node:fs and node:path, so a script can load it without the @/ alias', () => {
      const src = readFileSync('lib/content/bundleHash.ts', 'utf8');
      const specifiers = [...src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specifiers.sort()).toEqual(['node:crypto', 'node:fs', 'node:path']);
    });

    // Until CNT's loader merged, no route imported this module (K0b-1). The loader is now the one importer, for
    // `hashBundleFiles` and `CONTENT_BUNDLE_FILES`; any second file that a route can reach could pull the computed path of
    // `computeVersionBundleHash` into a route's module graph, so it still fails (contract "Static read paths").
    // The check follows what an import resolves to, not the text: an alias, a relative path (`./bundleHash` inside
    // lib/content), a dynamic import and a re-export all count. Scripts and tests are not scanned; they may import it.
    const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
    const resolvesTo = (file: string, spec: string): string | null => {
      const target = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : null;
      return target === null ? null : target.replace(/\.(m?[jt]sx?|cjs)$/, '');
    };
    const importsBundleHash = (file: string, source: string): boolean =>
      [...source.matchAll(SPECIFIER)].some((m) => resolvesTo(file, m[1]) === 'lib/content/bundleHash');

    it('NFR-MNT-07 (finding SEC-01): only lib/content/loader.ts under app, components, lib or the root files imports lib/content/bundleHash', () => {
      const rootFiles = readdirSync('.').filter((f) => statSync(f).isFile());
      const importers = [...['app', 'components', 'lib'].flatMap(filesUnder), ...rootFiles]
        .filter((f) => /\.(ts|tsx|mjs|js|cjs)$/.test(f))
        .filter((f) => importsBundleHash(f, readFileSync(f, 'utf8')));
      expect(importers).toEqual(['lib/content/loader.ts']);
    });

    it('NFR-MNT-07 (finding SEC-01): the guard resolves an alias, a relative path, a dynamic import and a re-export, and not the 4.0.0 module', () => {
      const yes: Array<[string, string]> = [
        ['components/Foo.tsx', "import { hashBundleFiles } from '@/lib/content/bundleHash';"],
        ['lib/content/other.ts', "import { hashBundleFiles } from './bundleHash';"],
        ['lib/data/x.ts', "import { CONTENT_BUNDLE_FILES } from '../content/bundleHash.ts';"],
        ['app/(authenticated)/p/page.tsx', "const m = await import('@/lib/content/bundleHash');"],
        ['lib/re.ts', "export * from '@/lib/content/bundleHash';"],
        ['proxy.ts', "import './lib/content/bundleHash';"],
        ['lib/cjs.js', "const m = require('./content/bundleHash');"],
      ];
      for (const [file, source] of yes) expect(importsBundleHash(file, source), `${file}: ${source}`).toBe(true);
      const no: Array<[string, string]> = [
        ['lib/data/framework.ts', "import { computeBundleHash } from '@/lib/framework/bundleHash';"],
        ['lib/framework/x.ts', "import { BUNDLE_FILES } from './bundleHash';"],
        ['lib/content/y.ts', "import { x } from 'bundleHash';"],
        ['lib/content/z.ts', "import { x } from './bundleHashes';"],
        ['lib/content/w.ts', "// the loader imports lib/content/bundleHash"],
      ];
      for (const [file, source] of no) expect(importsBundleHash(file, source), `${file}: ${source}`).toBe(false);
    });
  });

  it('FR-ACC-04 (helper): the stub registry holds version 1 of the three accepted kinds with their own hashes', () => {
    expect(STUB_LEGAL_TEXTS.map((t) => [t.kind, t.version, t.acceptance])).toEqual([
      ['terms', '1', 'required'], ['privacy', '1', 'required'], ['cross-border-consent', '1', 'required']]);
    for (const t of STUB_LEGAL_TEXTS) expect(t.sha256).toBe(sha256(t.text));
    expect(fixtureLegalTexts()).toEqual(STUB_LEGAL_TEXTS);
    expect(stubAcceptanceRows('u1').map((r) => r.consentType)).toEqual(['terms_of_service', 'privacy_policy', 'cross_border_storage']);
  });

  it('FR-ACC-04 (helper): the stub texts carry the fixed date and wording, and each row names the user, version, hash and grant', () => {
    expect(STUB_LEGAL_TEXTS.map((t) => [t.publishedOn, t.text])).toEqual([
      ['2026-10-30', 'Stub terms v1 for tests only.'],
      ['2026-10-30', 'Stub privacy v1 for tests only.'],
      ['2026-10-30', 'Stub cross-border-consent v1 for tests only.'],
    ]);
    expect(new Set(STUB_LEGAL_TEXTS.map((t) => t.sha256)).size).toBe(3);
    expect(stubAcceptanceRows('u7')).toEqual(STUB_LEGAL_TEXTS.map((t, i) => ({
      userId: 'u7', consentType: ['terms_of_service', 'privacy_policy', 'cross_border_storage'][i],
      version: '1', textHash: t.sha256, granted: true,
    })));
  });
});
