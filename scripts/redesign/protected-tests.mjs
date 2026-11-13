#!/usr/bin/env node
/**
 * Writes __tests__/lint/protected-tests.json: the test files spec 12 protects while the interface is reworded.
 *
 *   node scripts/redesign/protected-tests.mjs [out.json]
 *
 * The set is the union of two lenses over the tracked test files in __tests__/ and e2e/:
 *   (a) the file path matches NAME_LENS (the path, as F14's find | grep did: 57 files);
 *   (b) the file imports one of the modules in IMPORT_LENS.
 * The lenses disagree on many files (finding F14), so the union is the set. `humanRead` and `mainMerges`
 * are kept from an existing output file, so a reviewer's list survives a regeneration.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAME_LENS = /save|draft|conflict|authz|isolation|tenan|seal|export|download|replay|idempot|role-matrix|data-boundary|role-grants|mem-roles|personal-export|deletion/i;
export const IMPORT_LENS = /from\s+['"](@\/lib\/data\/(decisions|seals|reviews|findings|export|tenant|idempotency|evidence)|@\/lib\/seal\/|@\/lib\/client\/drafts|@\/lib\/question\/saveOutcome|@\/lib\/authz\/)/;
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
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
  const { byName, byImport, union, symmetric } = protectedSets(files, (f) => readFileSync(f, 'utf8'));
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  const ledger = { base: 'stage-1-base', files: union, humanRead: previous.humanRead ?? [], mainMerges: previous.mainMerges ?? [] };
  writeFileSync(out, JSON.stringify(ledger, null, 2) + '\n');
  console.error(`name lens: ${byName.length} files; import lens: ${byImport.length} files; union: ${union.length} files; lenses disagree on ${symmetric.length}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
