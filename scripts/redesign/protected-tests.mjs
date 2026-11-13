#!/usr/bin/env node
/**
 * Writes __tests__/lint/protected-tests.json: the test files spec 12 protects while the interface is reworded.
 *
 *   node scripts/redesign/protected-tests.mjs [out.json]
 *
 * The set is the union of two lenses over the test files in __tests__/ and e2e/ as they are at the base tag, stage-1-base:
 *   (a) the file path matches NAME_LENS (the path, as F14's find | grep did: 57 files);
 *   (b) the file loads one of the modules in IMPORT_LENS (import, import(), require, vi.mock, vi.doMock; alias or relative).
 * The lenses disagree on many files (finding F14), so the union is the set. `humanRead` and `mainMerges`
 * are kept from an existing output file, so a reviewer's list survives a regeneration.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAME_LENS = /save|draft|conflict|authz|isolation|tenan|seal|export|download|replay|idempot|role-matrix|data-boundary|role-grants|mem-roles|personal-export|deletion/i;
const LENS_MODULE = String.raw`(?:@\/|(?:\.{1,2}\/)+)lib\/(?:data\/(?:decisions|seals|reviews|findings|export|tenant|idempotency|evidence)|seal\/|client\/drafts|question\/saveOutcome|authz\/)`;
const LOADERS = String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*)`;
export const IMPORT_LENS = new RegExp(`${LOADERS}['"\`]${LENS_MODULE}`);

/** True when a source loads a lens module: a static or dynamic import, require, vi.mock or vi.doMock, with an alias or relative path. */
export const loadsLensModule = (source) => IMPORT_LENS.test(source);
const TEST_FILE = /^(__tests__|e2e)\/.*\.(test|spec)\.[cm]?[jt]sx?$/;

export function protectedSets(files, read) {
  const tests = files.filter((f) => TEST_FILE.test(f));
  const byName = tests.filter((f) => NAME_LENS.test(f));
  const byImport = tests.filter((f) => IMPORT_LENS.test(read(f)));
  const union = [...new Set([...byName, ...byImport])].sort();
  const symmetric = union.filter((f) => byName.includes(f) !== byImport.includes(f));
  return { byName, byImport, union, symmetric };
}

function main() {
  const out = process.argv[2] ?? '__tests__/lint/protected-tests.json';
  // the set is fixed at the base tag: a test file added since (this ledger's own test among them) is never protected
  const BASE = 'stage-1-base';
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const files = git('ls-tree', '-r', '--name-only', BASE).split('\n').filter(Boolean);
  const { byName, byImport, union, symmetric } = protectedSets(files, (f) => git('show', `${BASE}:${f}`));
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  const ledger = { base: BASE, files: union, humanRead: previous.humanRead ?? [], mainMerges: previous.mainMerges ?? [] };
  writeFileSync(out, JSON.stringify(ledger, null, 2) + '\n');
  console.error(`name lens: ${byName.length} files; import lens: ${byImport.length} files; union: ${union.length} files; lenses disagree on ${symmetric.length}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
