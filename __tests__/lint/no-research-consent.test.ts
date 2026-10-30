import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * FR-RES-01: v1 collects no research consent and has no research extract.
 * The source half of that guard (the pages half is e2e/no-research-consent.spec.ts,
 * the database half is __tests__/integration/research-ready.test.ts).
 *
 * The file list is asked of git, not written here, so a file added by a later unit is scanned
 * the moment it is committed. Comment lines are skipped: a comment may explain why the field
 * is gone. A code line that names the field or the consent type, in any letter case, is what
 * fails. Every .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts and .cts file is read.
 */
const files = execFileSync('git', ['ls-files', 'app', 'lib', 'components', 'types', 'proxy.ts'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => /\.(c|m)?(j|t)sx?$/.test(f));
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));

it('FR-RES-01: no code writes or reads a research consent', () => {
  expect(files.length).toBeGreaterThan(50);
  expect(files.filter((f) => code(f).some((l) => /researchConsent|research_data_usage/i.test(l)))).toEqual([]);
  // The scan keeps code lines: this file's own regex line above is one, so a comment filter that
  // swallowed every line would show here instead of making the check above pass for nothing.
  expect(code('__tests__/lint/no-research-consent.test.ts').some((l) => /researchConsent/.test(l))).toBe(true);
});

it('FR-RES-01: there is no research extract route or page', () => {
  expect(
    execFileSync('git', ['ls-files', 'app'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /research/i.test(f)),
  ).toEqual([]);
});
