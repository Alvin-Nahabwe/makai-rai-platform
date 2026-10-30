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

  it('NFR-MNT-03 NFR-PRIV-03 (harness): a slot run uses its own port, writes the server log and takes the channel', async () => {
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
    expect(server.command).toBe(
      "sh -c 'mkdir -p test-results && exec npm run dev -- -p 3104 >> test-results/server.log 2>&1'",
    );
    const chromium = config.projects?.find((p) => p.name === 'chromium');
    expect(chromium?.use?.channel).toBe('chrome');
    expect(chromium?.use?.viewport).toBeTruthy(); // still the Desktop Chrome descriptor
    // The `setup` project signs the fixture's 20 users in through a browser as
    // well, so it needs the channel too: without it, the first live run died on
    // "Executable doesn't exist ... chromium_headless_shell-1248".
    expect(config.projects?.find((p) => p.name === 'setup')?.use?.channel).toBe('chrome');
  });

  it('NFR-MNT-03 (harness): with CI set the config keeps port 3000, the production build and Playwright\'s own Chromium', async () => {
    const config = await loadConfig({ CI: 'true' });
    expect(config.use?.baseURL).toBe('http://localhost:3000');
    const server = config.webServer as { command: string; url: string; reuseExistingServer: boolean };
    expect(server.url).toBe('http://localhost:3000');
    expect(server.command).toBe(
      "sh -c 'mkdir -p test-results && exec npm run start -- -p 3000 >> test-results/server.log 2>&1'",
    );
    expect(server.reuseExistingServer).toBe(false);
    const chromium = config.projects?.find((p) => p.name === 'chromium');
    expect(chromium?.use).not.toHaveProperty('channel');
    expect(config.projects?.find((p) => p.name === 'setup')?.use ?? {}).not.toHaveProperty('channel');
  });
});
