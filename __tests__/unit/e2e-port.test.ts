import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { e2ePort, e2eBaseURL } from '../../e2e/helpers/port';

/**
 * `NodeJS.ProcessEnv` requires `NODE_ENV` under this project's types, so a
 * partial environment needs the assertion to type-check (`npm run typecheck`
 * and `next build` both include the test files).
 */
const asEnv = (env: Record<string, string>) => env as NodeJS.ProcessEnv;

/**
 * H-S7 (00-master.md E2): a Playwright run must never attach to another
 * builder's server. The first two tests pin the helper; the `describe` below
 * pins the property itself, which is about `playwright.config.ts` as it loads:
 * a helper that throws proves nothing if the config never calls it.
 */

it('NFR-MNT-03 (harness): an unset E2E_PORT outside CI throws', () => {
  expect(() => e2ePort(asEnv({}))).toThrow(/E2E_PORT/);
});

it('NFR-MNT-03 (harness): a set but malformed E2E_PORT says so, without repeating the value, and the unset case keeps its own message', () => {
  // The unset message ("must be set") is false for a set value, and the value goes into a `sh -c` line, so it is never echoed.
  const malformed: Array<Record<string, string>> = [{ E2E_PORT: '31x' }, { CI: 'true', E2E_PORT: '3104; id' }, { E2E_PORT: '$(id)' }, { CI: 'true', E2E_PORT: '123456' }];
  for (const env of malformed) {
    expect(() => e2ePort(asEnv(env)), JSON.stringify(env)).toThrow(/E2E_PORT must be 2 to 5 digits/);
    let message = '';
    try {
      e2ePort(asEnv(env));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(env.E2E_PORT);
    expect(message).not.toMatch(/must be set/);
  }
  expect(() => e2ePort(asEnv({}))).toThrow(/E2E_PORT must be set/);
  expect(() => e2ePort(asEnv({ E2E_PORT: '' }))).toThrow(/E2E_PORT must be set/);
});

it('NFR-MNT-03 (harness): CI keeps port 3000, a slot uses its own', () => {
  expect(e2eBaseURL(asEnv({ CI: 'true' }))).toBe('http://localhost:3000');
  expect(e2eBaseURL(asEnv({ E2E_PORT: '3104' }))).toBe('http://localhost:3104');
  expect(() => e2ePort(asEnv({ E2E_PORT: '31x' }))).toThrow(/E2E_PORT/);
  // The port is interpolated into a `sh -c` command line (playwright.config.ts),
  // so anything but 2 to 5 digits must be refused, shell metacharacters and
  // trailing newlines included, and a bad value must not fall back to 3000 in CI.
  for (const bad of ['3104; id', '3104 ', ' 3104', '3104\n', '$(id)', '3', '123456', '']) {
    expect(() => e2ePort(asEnv({ E2E_PORT: bad })), JSON.stringify(bad)).toThrow(/E2E_PORT/);
  }
  expect(() => e2ePort(asEnv({ CI: 'true', E2E_PORT: '31x' }))).toThrow(/E2E_PORT/);
  // An empty value counts as unset: it is what `E2E_PORT=` in an env file gives.
  expect(e2ePort(asEnv({ CI: 'true', E2E_PORT: '' }))).toBe('3000');
  expect(e2ePort(asEnv({ CI: 'true', E2E_PORT: '3104' }))).toBe('3104');
});

describe('playwright.config.ts as it loads', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig(env: Record<string, string | undefined>) {
    for (const key of ['CI', 'E2E_PORT', 'E2E_BROWSER_CHANNEL']) {
      vi.stubEnv(key, env[key]);
    }
    vi.resetModules();
    return (await import('../../playwright.config')).default;
  }

  it('NFR-MNT-03 (harness): the config throws at load when E2E_PORT is unset outside CI', async () => {
    await expect(loadConfig({})).rejects.toThrow(/E2E_PORT must be set/);
  });

  it('NFR-MNT-03 NFR-PRIV-03 (harness): a slot run uses its own port, writes this server\'s log only and takes the channel once', async () => {
    const config = await loadConfig({ E2E_PORT: '3104', E2E_BROWSER_CHANNEL: 'chrome' });
    expect(config.use?.baseURL).toBe('http://localhost:3104');
    const server = config.webServer as { command: string; url: string; reuseExistingServer: boolean };
    expect(server.url).toBe('http://localhost:3104');
    // Never reuse a server that is already listening: a taken port must fail
    // loudly, or a run could test another server (H-S7).
    expect(server.reuseExistingServer).toBe(false);
    // `mkdir -p`: Playwright removes test-results/ before it starts the web
    // server (node_modules/playwright/lib/runner/index.js, createGlobalSetupTasks
    // lists the output-dir removal first), so without it the redirect fails with
    // "cannot create test-results/server.log: Directory nonexistent" and the run
    // aborts. Seen live on the first run of e2e/auth.spec.ts.
    // One `>`, not `>>` (unit/h0-1's review, CR-2): the file holds this server's lines and no earlier run's.
    expect(server.command).toBe("sh -c 'mkdir -p test-results && exec npm run dev -- -p 3104 > test-results/server.log 2>&1'");
    expect(server.command).not.toContain('>>');
    // The channel is in the top-level `use` once (S-1); every project, `content` and `outage` included, takes it from there.
    expect(config.use?.channel).toBe('chrome');
    const chromium = config.projects?.find((p) => p.name === 'chromium');
    expect(chromium?.use?.viewport).toBeTruthy(); // still the Desktop Chrome descriptor
    for (const project of config.projects ?? []) expect(project.use ?? {}, project.name).not.toHaveProperty('channel');
  });

  it('NFR-MNT-03 (harness): with CI set the config keeps port 3000, the production build and Playwright\'s own Chromium', async () => {
    const config = await loadConfig({ CI: 'true' });
    expect(config.use?.baseURL).toBe('http://localhost:3000');
    const server = config.webServer as { command: string; url: string; reuseExistingServer: boolean };
    expect(server.url).toBe('http://localhost:3000');
    expect(server.command).toBe("sh -c 'mkdir -p test-results && exec npm run start -- -p 3000 > test-results/server.log 2>&1'");
    expect(server.reuseExistingServer).toBe(false);
    expect(config.use ?? {}).not.toHaveProperty('channel');
    for (const project of config.projects ?? []) expect(project.use ?? {}, project.name).not.toHaveProperty('channel');
  });

  it('NFR-MNT-03 (harness): baseURL and the server url come from one e2eBaseURL call', async () => {
    const source = readFileSync('playwright.config.ts', 'utf8');
    expect(source.match(/e2eBaseURL\(/g)).toHaveLength(1); // the import names it without a call
    expect(source).toMatch(/const baseURL = e2eBaseURL\(process\.env\);/);
    const config = await loadConfig({ E2E_PORT: '3104' });
    expect(config.use?.baseURL).toBe((config.webServer as { url: string }).url);
  });

  it('FR-CNT-01 G-17: the live server serves the fixture bundle, and a content project publishes its registry rows before the sign-ins', async () => {
    const config = await loadConfig({ E2E_PORT: '3104' });
    const env = (config.webServer as { env: Record<string, string> }).env;
    expect(env.MAKRAI_TEST_SEAMS).toBe('1');
    expect(env.MAKRAI_CONTENT_ROOT).toBe(join(process.cwd(), '__tests__', 'fixtures', 'content'));
    expect(env.RESEND_API_KEY).toBe(''); // the earlier value stays
    const byName = Object.fromEntries((config.projects ?? []).map((p) => [p.name, p]));
    expect('content.setup.ts').toMatch(byName.content.testMatch as RegExp);
    expect('auth.setup.ts').not.toMatch(byName.content.testMatch as RegExp);
    expect(byName.setup.dependencies).toEqual(['content']);
    expect(byName.chromium.dependencies).toEqual(['setup']);
    // The browser project runs neither setup file as a test of its own.
    for (const file of ['auth.setup.ts', 'content.setup.ts']) expect(file).toMatch(byName.chromium.testIgnore as RegExp);
  });
});
