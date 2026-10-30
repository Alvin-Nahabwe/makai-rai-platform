import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * NFR-MNT-03 (harness) and NFR-OBS-05 (harness). Outside CI a Playwright run needs `E2E_PORT`
 * (`e2e/helpers/port.ts`), so the three documents that tell a person how to run the e2e suite say so,
 * and `ci.yml` keeps the server log that the web server's redirect to `test-results/server.log` would
 * otherwise hide from the Actions log.
 */

it('NFR-MNT-03 (harness): README, CONTRIBUTING and the pull request template give the E2E_PORT form of the e2e command', () => {
  for (const f of ['README.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
    const src = readFileSync(f, 'utf8');
    expect(src, f).toContain('E2E_PORT=<port> npm run test:e2e');
    expect(src, f).not.toContain('`npm run test:e2e`'); // the bare command is gone
    expect(src, f).not.toMatch(/playwright\.config\.ts:\d/); // no line number of a file this unit rewrote
  }
});

it('NFR-OBS-05 (harness): ci.yml uploads test-results/server.log with the Playwright report whatever the result, and cites no playwright.config.ts line', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const step = ci.split(/\n {6}- name: /).find((b) => b.startsWith('Upload Playwright report')) ?? '';
  expect(step).toMatch(/if: always\(\)/);
  expect(step).toContain('playwright-report/');
  expect(step).toContain('test-results/server.log');
  expect(ci).not.toMatch(/playwright\.config\.ts:\d/);
});

it('NFR-MNT-03 (harness): the README and CONTRIBUTING rows say an unset E2E_PORT stops the run', () => {
  for (const f of ['README.md', 'CONTRIBUTING.md']) {
    const row = readFileSync(f, 'utf8').split('\n').find((l) => l.includes('E2E_PORT=<port> npm run test:e2e')) ?? '';
    expect(row, f).toMatch(/E2E_PORT/);
    expect(row, f).toMatch(/free port/);
    expect(row, f).toMatch(/unset/);
  }
});
