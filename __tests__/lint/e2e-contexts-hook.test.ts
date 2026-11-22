import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * D-419 (PR 100, run 44891338626): a browser context left open stays alive in the worker for the rest of the run, and
 * with trace 'retain-on-first-failure' every later test traces it, which filled the CI runner's disk. So every e2e file
 * that opens a browser context registers `test.afterEach(closeOpenedContexts)` (e2e/helpers/contexts.ts), or says on
 * one line, with its reason, why it does not. API request contexts (`request.newContext`) are not browser contexts:
 * they carry no pages and no trace, so they do not count.
 */

const OPENS = /\bbrowser\.(?:newContext|newPage)\(/;
const HOOK = /^test\.afterEach\(closeOpenedContexts\);$/m;
const OPT_OUT = /^\/\/ closeOpenedContexts not registered: \S.{20,}$/m;
/** A second cleanup that the hook makes redundant: a file-level array of contexts closed together after the tests. */
const ARRAY_CLEANUP = /contexts\.map\(\(c\) => c\.close\(\)\)/;

function specsUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return specsUnder(full);
    return entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

const specs = specsUnder('e2e').map((f) => ({ f, src: readFileSync(f, 'utf8') }));
const opening = specs.filter(({ src }) => OPENS.test(src));

it('NFR-MNT-01 (harness): every e2e file that opens a browser context registers closeOpenedContexts or says why not', () => {
  // The patterns must recognise what they look for, or the scan below could pass for nothing.
  expect('const c = await browser.newContext({ storageState });').toMatch(OPENS);
  expect('const p = await browser.newPage();').toMatch(OPENS);
  expect('const api = await pwRequest.newContext({ baseURL });').not.toMatch(OPENS);
  expect('test.afterEach(closeOpenedContexts);').toMatch(HOOK);
  expect('// closeOpenedContexts not registered: the cleanup below lets held requests go before closing').toMatch(OPT_OUT);
  expect(opening.length, 'the scan found no file that opens a browser context, so it would pass for nothing').toBeGreaterThan(10);

  const missing = opening.filter(({ src }) => !HOOK.test(src) && !OPT_OUT.test(src)).map(({ f }) => f);
  expect(missing, 'add `test.afterEach(closeOpenedContexts);` at top level (helpers/contexts.ts says why)').toEqual([]);
});

it('NFR-MNT-01 (harness): a file with the hook keeps no second array of contexts to close', () => {
  expect('await Promise.all(contexts.map((c) => c.close()));').toMatch(ARRAY_CLEANUP);
  const doubled = specs.filter(({ src }) => HOOK.test(src) && ARRAY_CLEANUP.test(src)).map(({ f }) => f);
  expect(doubled, 'the hook already closes these contexts; drop the array, its pushes and its afterAll').toEqual([]);
});
