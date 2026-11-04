import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripAnsi } from '../helpers/spawnText';

/**
 * The nginx-in-front run's Playwright config (SRS NFR-SEC-06 "Verified by"; ACC-b Task 15), modelled on
 * __tests__/unit/e2e-port.test.ts: the environment is replaced, the module cache reset, and the config imported. It
 * starts no server: importing a Playwright config runs no webServer.
 */
const saved = { ...process.env };
async function load(env: Record<string, string>) {
  process.env = { PATH: saved.PATH, ...env } as unknown as NodeJS.ProcessEnv;
  vi.resetModules();
  return (await import('../../playwright.nginx.config')).default;
}
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

const URL_ = 'https://127.0.0.1:8444';
const env = { CI: '1', E2E_PORT: '3104', E2E_NGINX_URL: URL_ };

describe('playwright.nginx.config.ts', () => {
  it('NFR-SEC-06 R12-14: without E2E_NGINX_URL (or with another shape) the config refuses to load', async () => {
    await expect(load({ CI: '1', E2E_PORT: '3104' })).rejects.toThrow(/E2E_NGINX_URL must be https:\/\/127\.0\.0\.1:<8440\+K>/);
    await expect(load({ ...env, E2E_NGINX_URL: 'http://127.0.0.1:8444' })).rejects.toThrow(/E2E_NGINX_URL/);
    await expect(load({ ...env, E2E_NGINX_URL: 'https://127.0.0.1:80' })).rejects.toThrow(/E2E_NGINX_URL/);
  });

  it('NFR-SEC-06 R12-14: three servers start in order (mail catcher, the app on next start, nginx) and none is reused', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the webServer entries are read field by field
    const ws = (await load(env)).webServer as Array<Record<string, any>>;
    expect(ws.map((w) => w.name)).toEqual(['mail catcher', 'app', 'nginx']);
    expect(ws.every((w) => w.reuseExistingServer === false)).toBe(true);
    expect(ws[0].command).toMatch(/^node scripts\/mail-catcher\/catcher\.mjs --host 127\.0\.0\.1 --port 0 --out \S+makrai-mail-3104\.jsonl$/);
    expect(ws[0].wait.stdout.source).toContain('(?<mail_port>');
    expect(ws[1].command).toContain('RESEND_BASE_URL=http://127.0.0.1:$MAIL_PORT');
    expect(ws[1].command).toMatch(/exec npm run start -- -p 3104 /); // next start, never next dev
    expect(ws[1].env).toEqual({ NEXTAUTH_URL: 'https://makrai.org', RESEND_API_KEY: 're_test_local' });
    expect(ws[2]).toMatchObject({ command: 'scripts/nginx-test/up.sh 4', port: 8444, env: { E2E_PORT: '3104' }, gracefulShutdown: { signal: 'SIGTERM' } });
    expect(ws[2]).not.toHaveProperty('url'); // Playwright's url probe sends no server name and default.conf's default_server refuses it
    expect(ws[2]).not.toHaveProperty('ignoreHTTPSErrors'); // a port wait never speaks TLS
    for (const w of ws.slice(0, 2)) expect(w).not.toHaveProperty('port'); // the other two keep their own readiness
  });

  it('NFR-SEC-06 R12-14 R13-8: the config sets baseURL (the array form sets none), runs the nginx spec and the J-15 cases only, and names the mail out file', async () => {
    const c = await load(env);
    expect(c.use?.baseURL).toBe('http://localhost:3104');
    expect((c.testMatch as RegExp).test('e2e/sign-in-nginx.spec.ts')).toBe(true);
    expect((c.testMatch as RegExp).test('e2e/account.spec.ts')).toBe(true); // for its two J-15 cases only,
    expect((c.testMatch as RegExp).test('e2e/two-orgs.spec.ts')).toBe(false);
    expect((c.grep as RegExp).test('J-15 with a mail catcher @nginx')).toBe(true); // so the grep must keep every other case out
    expect((c.grep as RegExp).test('FR-ACC-07: sign out everywhere in one browser signs the other out on its next request')).toBe(false);
    const spec = readFileSync('e2e/sign-in-nginx.spec.ts', 'utf8');
    expect(spec).toMatch(/tag:\s*'@nginx'/);
    expect(spec).toMatch(/Host:\s*'makrai\.org'/); // nginx has one name; a request without it is refused at the handshake
    expect(spec).not.toMatch(/url:\s*process\.env\.E2E_NGINX_URL/);
    expect(readFileSync('e2e/account.spec.ts', 'utf8').match(/tag:\s*'@nginx'/g)).toHaveLength(1); // one describe holds both J-15 cases
    expect(process.env.E2E_MAIL_OUT).toMatch(/makrai-mail-3104\.jsonl$/);
    expect(process.env.E2E_MAIL_OUT!.startsWith(process.cwd())).toBe(false); // outside the repository
    // B20 (SO-4): in a fresh mkdtemp directory (mode 700), never at a predictable name in the shared temp directory.
    const dir = dirname(process.env.E2E_MAIL_OUT!);
    expect(basename(dir)).toMatch(/^makrai-mail-[A-Za-z0-9]{6}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A Playwright worker loads the config again with the runner's environment: it must name the same file.
    const first = process.env.E2E_MAIL_OUT;
    vi.resetModules();
    await import('../../playwright.nginx.config');
    expect(process.env.E2E_MAIL_OUT).toBe(first);
    // The health sample fits the default rule's minute even where the limiter applies (C4 CR-1), and the log read takes
    // both of the container's streams, the error log included (CR-4).
    expect(spec).toMatch(/HEALTH_SAMPLES = 50\b/);
    expect(spec).toMatch(/docker logs \$\{CONTAINER\} 2>&1|\['logs', CONTAINER\][\s\S]{0,120}stderr/);
  });

  it('R12-14: up.sh refuses a missing E2E_PORT, stays in the foreground and removes the container on TERM and INT', () => {
    const sh = readFileSync('scripts/nginx-test/up.sh', 'utf8');
    expect(sh).toMatch(/trap\s+'[^']*down\.sh[^']*'\s+TERM\s+INT/);
    expect(sh).toMatch(/docker wait v060-nginx-b/);
    expect(sh).toMatch(/--pull=never/);
    expect(sh).toMatch(/nginx:1\.31-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2/);
    // No E2E_PORT, so it must stop before any docker call. NO_COLOR for the child; ANSI stripped before matching.
    const r = spawnSync('sh', ['scripts/nginx-test/up.sh', '4'], { env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect([r.status, stripAnsi(r.stderr)]).toEqual([2, expect.stringMatching(/E2E_PORT/)]);
    const bad = spawnSync('sh', ['scripts/nginx-test/up.sh', '4'], { env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', E2E_PORT: '31x' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });

  it('NFR-SEC-06: the browser channel follows E2E_BROWSER_CHANNEL as playwright.config.ts does; unset, Playwright\'s own build', async () => {
    expect((await load({ ...env, E2E_BROWSER_CHANNEL: 'chrome' })).use).toMatchObject({ channel: 'chrome' });
    expect((await load(env)).use).not.toHaveProperty('channel');
  });
});
