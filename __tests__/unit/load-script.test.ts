import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertLocalBase, createPacer, newStats, operationsToAsk, p95, paceDelay, parseArgs, record, renderReport, requestTarget, saveDecisionBody, SEAT_LIMITS, selectSeats, signInRetryDelay, withSignInRetry,
} from '../../scripts/load/save-decisions.mjs';

/**
 * NFR-PERF-04 (SRS line 3207): `scripts/load/save-decisions.mjs --base <url> --users 10 --seconds 60` runs the
 * five operations of the server response budgets concurrently and prints the 95th percentile of each. The load
 * must never reach production (NFR-SEC-17, K-10): the script runs against localhost or 127.0.0.1 and nothing else.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'load', 'save-decisions.mjs');

// The output is matched as text, so the child runs without colour and any escape that still arrives is removed.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
function runScript(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: process.cwd(), encoding: 'utf8', env, timeout: 20_000 });
  return { status: r.status, stdout: (r.stdout ?? '').replace(ANSI, ''), stderr: (r.stderr ?? '').replace(ANSI, '') };
}

it('NFR-PERF-04: p95 is the nearest-rank 95th percentile', () => {
  expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  expect(p95([7])).toBe(7);
  expect(p95([30, 10, 20])).toBe(30); // sorted first: rank ceil(0.95 * 3) = 3
  expect(p95(Array.from({ length: 20 }, (_, i) => 20 - i))).toBe(19); // rank ceil(0.95 * 20) = 19, input in descending order
  expect(() => p95([])).toThrow(/no samples/);
});

it('NFR-PERF-04 NFR-SEC-17: the load script refuses a non-local base', () => {
  expect(() => assertLocalBase('https://rai.example.org')).toThrow(/only localhost or 127\.0\.0\.1/);
  expect(spawnSync('node', ['scripts/load/save-decisions.mjs', '--base', 'https://rai.example.org']).status).toBe(2);
});

it('NFR-PERF-04 NFR-SEC-17: only the host decides, so a local-looking name, a userinfo trick or another loopback form is refused', () => {
  for (const base of [
    'http://localhost.example.org',
    'http://localhost@rai.example.org',
    'http://127.0.0.1.nip.io',
    'http://localhost:3000@rai.example.org',
    'http://[::1]:3000',
    'http://0.0.0.0:3000',
    'http://127.0.0.2:3000',
    'http://rai.example.org/localhost',
    'https://rai.example.org?next=http://localhost',
    'localhost:3000',
    'ftp://localhost',
    '',
  ])
    expect(() => assertLocalBase(base), base).toThrow();
  // Credentials in the address would be sent with every request and printed by an error: refused even for a local host.
  expect(() => assertLocalBase('http://user:pw@localhost:3000')).toThrow(/credentials/);
  // A refusal names the host and never repeats the rest of the address.
  expect(() => assertLocalBase('https://rai.example.org/secret/path?token=abc')).toThrow(/rai\.example\.org/);
  try {
    assertLocalBase('https://rai.example.org/secret/path?token=abc');
  } catch (e) {
    expect((e as Error).message).not.toMatch(/secret|token/);
  }
  for (const ok of ['http://localhost:3105', 'http://127.0.0.1:3105', 'http://localhost', 'https://127.0.0.1:8443/', 'HTTP://LOCALHOST:3105'])
    expect(() => assertLocalBase(ok), ok).not.toThrow();
});

it('NFR-PERF-04 NFR-SEC-17: a refused base stops the script before it reads a manifest or opens a connection', () => {
  const r = runScript(['--base', 'http://localhost.example.org', '--manifest', join(process.cwd(), 'does-not-exist', 'manifest.json')]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/only localhost or 127\.0\.0\.1/);
  expect(r.stderr).not.toMatch(/manifest/i); // the base was judged first
  expect(r.stdout).toBe('');
});

it('NFR-PERF-04: the options are checked before any request, and a missing base is a usage error', () => {
  expect(runScript([]).status).toBe(2);
  expect(runScript(['--base']).status).toBe(2);
  expect(runScript(['--base', 'http://localhost:3105', '--users', '0']).status).toBe(2);
  expect(runScript(['--base', 'http://localhost:3105', '--users', '51']).status).toBe(2); // a local load, but not an unbounded one
  expect(runScript(['--base', 'http://localhost:3105', '--seconds', '601']).status).toBe(2);
  expect(runScript(['--base', 'http://localhost:3105', '--users', 'ten']).status).toBe(2);
  expect(runScript(['--base', 'http://localhost:3105', '--bogus', '1']).status).toBe(2);
  expect(parseArgs(['--base', 'http://localhost:3105'])).toMatchObject({ base: 'http://localhost:3105', users: 10, seconds: 60 });
  expect(parseArgs(['--base', 'http://127.0.0.1:3105', '--users', '3', '--seconds', '5'])).toMatchObject({ users: 3, seconds: 5 });
});

it('NFR-PERF-04 NFR-SEC-17: --connect-to accepts only 127.0.0.1 or ::1 and an https base', () => {
  // (a) a non-loopback address, a name, another loopback form, a bad port
  for (const to of ['10.0.0.5:8460', '192.0.2.1:443', 'localhost:8460', '127.0.0.2:8460', '0.0.0.0:8460', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1', ':8460'])
    expect(() => assertLocalBase('https://makrai.org', to), to).toThrow();
  expect(() => assertLocalBase('https://makrai.org', '10.0.0.5:8460')).toThrow(/127\.0\.0\.1 or ::1/);
  // (d) http, with or without a local host, and credentials
  expect(() => assertLocalBase('http://makrai.org', '127.0.0.1:8460')).toThrow(/https/);
  expect(() => assertLocalBase('http://localhost:3105', '127.0.0.1:8460')).toThrow(/https/);
  expect(() => assertLocalBase('https://user:pw@makrai.org', '127.0.0.1:8460')).toThrow(/credentials/);
  // (c) without --connect-to a non-local base is still refused
  expect(() => assertLocalBase('https://makrai.org')).toThrow(/only localhost or 127\.0\.0\.1/);
  expect(() => requestTarget('https://makrai.org')).toThrow(/only localhost or 127\.0\.0\.1/);
  for (const ok of ['127.0.0.1:8460', '[::1]:8460', '::1:8460']) expect(() => assertLocalBase('https://makrai.org', ok), ok).not.toThrow();
  // the CLI: exit 2 and a message that names the ip, before any manifest is read
  const r = runScript(['--base', 'https://makrai.org', '--connect-to', '10.0.0.5:8460', '--manifest', join(process.cwd(), 'does-not-exist', 'manifest.json')]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/127\.0\.0\.1 or ::1/);
  expect(r.stderr).not.toMatch(/manifest/i);
  expect(runScript(['--base', 'http://makrai.org', '--connect-to', '127.0.0.1:8460']).status).toBe(2);
  expect(runScript(['--base', 'https://makrai.org', '--connect-to']).status).toBe(2);
});

it('NFR-PERF-04 NFR-SEC-17: --connect-to sends the base\'s name as server name, Host and Origin to the loopback address', () => {
  // (b)
  expect(requestTarget('https://makrai.org', '127.0.0.1:8460')).toEqual({ host: '127.0.0.1', port: 8460, servername: 'makrai.org', hostHeader: 'makrai.org', origin: 'https://makrai.org' });
  expect(requestTarget('https://makrai.org/', '[::1]:8460')).toMatchObject({ host: '::1', port: 8460, servername: 'makrai.org' });
  // a base with a port keeps it in Host and Origin; the connection still goes to the --connect-to port
  expect(requestTarget('https://makrai.org:8443', '127.0.0.1:8460')).toEqual({ host: '127.0.0.1', port: 8460, servername: 'makrai.org', hostHeader: 'makrai.org:8443', origin: 'https://makrai.org:8443' });
  // no --connect-to: the base itself, as before
  expect(requestTarget('http://localhost:3105')).toEqual({ host: 'localhost', port: 3105, servername: 'localhost', hostHeader: 'localhost:3105', origin: 'http://localhost:3105' });
  expect(requestTarget('https://127.0.0.1')).toMatchObject({ host: '127.0.0.1', port: 443, hostHeader: '127.0.0.1' });
  expect(parseArgs(['--base', 'https://makrai.org', '--connect-to', '127.0.0.1:8460'])).toMatchObject({ connectTo: '127.0.0.1:8460' });
  expect(parseArgs(['--base', 'http://localhost:3105']).connectTo).toBeNull();
});

it('NFR-PERF-04: a 429 during sign-in is waited out (Retry-After, else 2 s) for up to 60 s of waiting in all, and nothing else is retried', () => {
  // R16-6. signInRetryDelay(status, retryAfter, waitedMs) is pure: the milliseconds to wait before trying the same request again, or null for "do not retry".
  expect(signInRetryDelay(429, null, 0)).toBe(2000); // no Retry-After header (nginx's own 429 carries none)
  expect(signInRetryDelay(429, '7', 0)).toBe(7000); // whole seconds
  for (const odd of ['', '0', '-3', '1.5', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT']) expect(signInRetryDelay(429, odd, 0), odd).toBe(2000); // not a whole number of at least 1: treated as absent
  for (const status of [200, 204, 302, 400, 401, 403, 404, 500, 503]) expect(signInRetryDelay(status, '7', 0), String(status)).toBeNull(); // only 429 waits
  expect(signInRetryDelay(429, '7', 53_000)).toBe(7000); // 53 s + 7 s is exactly 60 s: allowed
  expect(signInRetryDelay(429, '7', 53_001)).toBeNull(); // one millisecond over: stop
  expect(signInRetryDelay(429, null, 58_000)).toBe(2000);
  expect(signInRetryDelay(429, null, 58_001)).toBeNull();
  expect(signInRetryDelay(429, '61', 0)).toBeNull(); // a single wait longer than the whole budget
});

// ---- what the run records and reports (C4 round 1 items 6 and 7) -------------------------------------------

const API_JSON = { apiJson: true };
const fill = (s: ReturnType<typeof newStats>, key: string, n: number, status: number, ms: number, answer: object = {}) => {
  for (let i = 0; i < n; i++) record(s, key, status, ms, answer);
};
/** Every key of a fresh run answered 200 in 10 ms, so a case changes only what it is about. */
const healthy = () => {
  const s = newStats();
  for (const key of ['save-decision', 'render-s10', 'render-s11', 'seal-stage', 'generate-document', 'team-export']) fill(s, key, 5, 200, 10);
  return s;
};

it('NFR-PERF-04: only a 501, or a 404 that is not the API\'s JSON, means the route is not there yet; a JSON 404 is an error', () => {
  const s = newStats();
  record(s, 'save-decision', 501, 5);
  record(s, 'seal-stage', 404, 5, { apiJson: false }); // the app's HTML not-found page: no such route
  record(s, 'generate-document', 404, 5, API_JSON); // toResponse's {"error":"Not found","code":"not_found"}: the route is there and refused
  record(s, 'team-export', 404, 5); // no answer detail given: treated as not the API's JSON
  expect(s['save-decision']).toMatchObject({ pending: 1, errors: 0 });
  expect(s['seal-stage']).toMatchObject({ pending: 1, errors: 0 });
  expect(s['generate-document']).toMatchObject({ pending: 0, errors: 1, firstError: 404 });
  expect(s['team-export']).toMatchObject({ pending: 1, errors: 0 });
  const { lines, code } = renderReport(s);
  expect(lines).toContain('op=generate-document notmeasured errors=1 firstStatus=404');
  expect(code).toBe(1); // an error with nothing measured fails the run
});

it('NFR-PERF-04: a pending answer never stops an operation that already has samples, and render reports each page under its own key', () => {
  const s = healthy();
  record(s, 'save-decision', 501, 5); // a later pending answer after samples: the samples stand
  expect(renderReport(s).lines[0]).toMatch(/^op=save-decision p95ms=10 budgetms=300 n=5$/);
  expect(renderReport(s).code).toBe(0);

  // One page measured, the other not there: partial, naming the page.
  const partial = healthy();
  partial['render-s11'] = newStats()['render-s11'];
  record(partial, 'render-s11', 404, 5, { apiJson: false });
  const r = renderReport(partial);
  expect(r.lines).toContain('op=render-s10-s11 partial pending=S-11 p95ms=10 budgetms=800 n=5');
  expect(r.code).toBe(3);
  expect(r.notes.join('\n')).toMatch(/render-s10-s11[^\n]*S-11/);
  expect(renderReport(partial, { allowPending: true }).code).toBe(0);
  expect(renderReport(partial, { allowPending: true }).lines).toContain('op=render-s10-s11 partial pending=S-11 p95ms=10 budgetms=800 n=5');
});

it('NFR-PERF-04: a run with a pending operation exits 3 unless --allow-pending is given, and says which; an over-budget one still exits 1', () => {
  const s = healthy();
  s['seal-stage'] = newStats()['seal-stage'];
  s['generate-document'] = newStats()['generate-document'];
  record(s, 'seal-stage', 501, 5);
  record(s, 'generate-document', 501, 5);
  const r = renderReport(s);
  expect(r.lines).toContain('op=seal-stage pending');
  expect(r.lines).toContain('op=generate-document pending');
  expect(r.code).toBe(3);
  expect(r.notes.join('\n')).toMatch(/seal-stage, generate-document/);
  expect(r.notes.join('\n')).toMatch(/--allow-pending/);
  const allowed = renderReport(s, { allowPending: true });
  expect(allowed.code).toBe(0);
  expect(allowed.lines).toContain('op=seal-stage pending'); // still shown as pending
  // Failure outranks pending.
  fill(s, 'save-decision', 100, 200, 5000);
  expect(renderReport(s).code).toBe(1);
  expect(renderReport(s, { allowPending: true }).code).toBe(1);
  expect(parseArgs(['--base', 'http://localhost:3105', '--allow-pending'])).toMatchObject({ allowPending: true });
  expect(parseArgs(['--base', 'http://localhost:3105']).allowPending).toBe(false);
  expect(parseArgs(['--allow-pending', '--base', 'http://localhost:3105', '--users', '3'])).toMatchObject({ allowPending: true, users: 3 });
});

it('NFR-PERF-04: a timeout counts as 60000 ms in the p95 and as an error, and a 5xx or a timeout fails the run', () => {
  // The refuter's simulation: 50 saves at 100 ms and 50 answers of 503.
  const saves = healthy();
  saves['save-decision'] = newStats()['save-decision'];
  fill(saves, 'save-decision', 50, 200, 100);
  fill(saves, 'save-decision', 50, 503, 5);
  const a = renderReport(saves);
  expect(a.lines).toContain('op=save-decision p95ms=100 budgetms=300 n=50 errors=50 firstStatus=503');
  expect(a.code).toBe(1); // the p95 is fine and the run still fails: half the saves were refused

  // 20 documents at 2000 ms and 80 timeouts: the p95 is the timeout.
  const docs = healthy();
  docs['generate-document'] = newStats()['generate-document'];
  fill(docs, 'generate-document', 20, 200, 2000);
  fill(docs, 'generate-document', 80, 0, 1234);
  const b = renderReport(docs);
  expect(b.lines).toContain('op=generate-document p95ms=60000 budgetms=15000 n=100 errors=80 firstStatus=timeout');
  expect(b.code).toBe(1);

  // One timeout among fast answers fails by itself, although the p95 is within budget.
  const one = healthy();
  fill(one, 'seal-stage', 200, 200, 100);
  record(one, 'seal-stage', 0, 100);
  const c = renderReport(one);
  expect(c.lines.find((l) => l.startsWith('op=seal-stage'))).toMatch(/p95ms=100 budgetms=3000 n=206 errors=1 firstStatus=timeout/);
  expect(c.code).toBe(1);
});

it('NFR-PERF-04: a 409 base_version_moved on a save and the export\'s 429 are counted in expected409 and expected429 only, never in errors, and do not fail the run', () => {
  // V\'s rule is errors=0 with expected409 at most --users: an expected answer must not be in errors, or a correct server fails it.
  const s = healthy();
  fill(s, 'save-decision', 7, 409, 20, { apiJson: true, code: 'base_version_moved' });
  fill(s, 'team-export', 3, 429, 20, { apiJson: true, code: 'rate_limited' });
  expect(s['save-decision']).toMatchObject({ errors: 0, firstError: null, expected409: 7 });
  expect(s['team-export']).toMatchObject({ errors: 0, firstError: null, expected429: 3 });
  const r = renderReport(s);
  expect(r.lines).toContain('op=save-decision p95ms=10 budgetms=300 n=5 expected409=7');
  expect(r.lines).toContain('op=team-export p95ms=10 budgetms=10000 n=5 expected429=3');
  expect(r.lines.join('\n')).not.toMatch(/errors=/);
  expect(r.code).toBe(0);
  // Not expected: a 409 with another code, a 429 on a save, any 4xx elsewhere. Counted as errors, never as expected.
  const other = healthy();
  record(other, 'save-decision', 409, 20, { apiJson: true, code: 'request_id_reused' });
  record(other, 'save-decision', 429, 20, API_JSON);
  record(other, 'seal-stage', 403, 20, API_JSON);
  const o = renderReport(other);
  expect(o.lines.find((l) => l.startsWith('op=save-decision'))).toMatch(/errors=2 firstStatus=409$/);
  expect(o.lines.find((l) => l.startsWith('op=seal-stage'))).toMatch(/errors=1 firstStatus=403$/);
  expect(o.code).toBe(1); // V's rule is errors=0: any unexpected answer beside measured ones fails the run
  // One 422 beside samples is enough, and it is the only thing that fails here.
  const refused = healthy();
  record(refused, 'save-decision', 422, 20, API_JSON);
  const rr = renderReport(refused);
  expect(rr.lines.find((l) => l.startsWith('op=save-decision'))).toMatch(/errors=1 firstStatus=422$/);
  expect(rr.code).toBe(1);
  // Ten expected 409s and nothing else is a pass.
  const moved = healthy();
  fill(moved, 'save-decision', 10, 409, 20, { apiJson: true, code: 'base_version_moved' });
  expect(renderReport(moved).code).toBe(0);
  // An operation whose every answer was a 409 measured nothing.
  const none = newStats();
  fill(none, 'save-decision', 4, 409, 20, { apiJson: true, code: 'base_version_moved' });
  expect(renderReport(none).lines).toContain('op=save-decision notmeasured expected409=4');
  expect(renderReport(none).code).toBe(1);
});

// ---- the whole script against a stand-in server on 127.0.0.1 --------------------------------------------------

interface Stub {
  base: string;
  hits: Array<{ method: string; path: string; at: number; cookie: string }>;
  close(): Promise<void>;
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A server that signs a seat in (csrf, credentials callback, session) and answers everything else through `others`. With no
 * handler for a path it answers the app's HTML not-found page, as a route that does not exist does.
 */
async function stubServer(others: (req: IncomingMessage, res: ServerResponse) => boolean = () => false): Promise<Stub> {
  const hits: Stub['hits'] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits.push({ method: req.method ?? '', path, at: Date.now(), cookie: req.headers.cookie ?? '' });
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/auth/csrf') return json(200, { csrfToken: 'token' }, { 'set-cookie': 'csrf=1; Path=/' });
    if (path === '/api/auth/callback/credentials') {
      // The session cookie names the account that signed in, so a test can tell the seats apart.
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const email = new URLSearchParams(raw).get('email') ?? 'nobody';
        res.writeHead(302, { location: '/', 'set-cookie': `session=${encodeURIComponent(email)}; Path=/; HttpOnly` });
        res.end();
      });
      return;
    }
    if (path === '/api/auth/session') return json(200, /session=/.test(req.headers.cookie ?? '') ? { user: { id: 'u1' } } : null);
    if (others(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>404: This page could not be found.</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  cleanups.push(() => {
    server.closeAllConnections();
    return stub.close();
  });
  return stub;
}

function manifestFile(seats: number | string[] = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-script-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const roles = typeof seats === 'number' ? Array.from({ length: seats }, () => 'owner') : seats;
  const users = roles.map((role, i) => ({
    userId: `u${i + 1}`, email: `${role}${i + 1}@example.test`, password: 'fixture-password', orgSlug: 'acme', role, index: i % 2, storageStatePath: 'unused',
  }));
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify({ orgs: [{ id: 'org1', slug: 'acme' }], users }));
  return file;
}

function runAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout: stdout.replace(ANSI, ''), stderr: stderr.replace(ANSI, '') }));
  });
}

it('NFR-PERF-04: against a server whose routes are not there, every operation is pending and the run exits 3, or 0 with --allow-pending', async () => {
  const stub = await stubServer();
  const manifest = manifestFile(2);
  const args = ['--base', stub.base, '--manifest', manifest, '--project', 'p1', '--users', '2', '--seconds', '2'];
  const strict = await runAsync(args);
  expect(strict.stdout.trim().split('\n')).toEqual([
    'op=save-decision pending',
    'op=render-s10-s11 pending',
    'op=seal-stage pending',
    'op=generate-document pending',
    'op=team-export pending',
  ]);
  expect(strict.status).toBe(3);
  expect(strict.stderr).toMatch(/pending, not measured: save-decision, render-s10-s11, seal-stage, generate-document, team-export; exit 3 unless --allow-pending/);
  const allowed = await runAsync([...args, '--allow-pending']);
  expect(allowed.status).toBe(0);
  expect(allowed.stdout).toContain('op=save-decision pending');
  expect(allowed.stderr).toMatch(/allowed by --allow-pending/);
}, 30_000);

it('NFR-PERF-04: a JSON 404 from a route is the route refusing, not the route missing: that operation is an error and the run exits 1', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url?.endsWith('/decisions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', code: 'not_found' }));
      return true;
    }
    return false;
  });
  const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(), '--project', 'p1', '--users', '1', '--seconds', '1', '--allow-pending']);
  expect(r.stdout).toMatch(/^op=save-decision notmeasured errors=\d+ firstStatus=404$/m);
  expect(r.stdout).toContain('op=render-s10-s11 pending');
  expect(r.status).toBe(1);
}, 30_000);

it('NFR-PERF-04: when the project list cannot be read the message says what came back, not that there is no project', async () => {
  const cases: Array<[string, (req: IncomingMessage, res: ServerResponse) => boolean, RegExp]> = [
    ['500', (req, res) => (req.url?.endsWith('/projects') ? (res.writeHead(500, { 'content-type': 'application/json' }), res.end('{"error":"x"}'), true) : false), /listing the organisation's projects answered 500/],
    ['403', (req, res) => (req.url?.endsWith('/projects') ? (res.writeHead(403, { 'content-type': 'application/json' }), res.end('{"error":"Forbidden","code":"forbidden"}'), true) : false), /answered 403/],
    ['not JSON', (req, res) => (req.url?.endsWith('/projects') ? (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>login</html>'), true) : false), /answered 200 but the body is not JSON/],
    ['not a list', (req, res) => (req.url?.endsWith('/projects') ? (res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"projects":[]}'), true) : false), /is not a list of projects/],
    ['empty list', (req, res) => (req.url?.endsWith('/projects') ? (res.writeHead(200, { 'content-type': 'application/json' }), res.end('[]'), true) : false), /the organisation has no project/],
  ];
  for (const [why, handler, message] of cases) {
    const stub = await stubServer(handler);
    const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(), '--users', '1', '--seconds', '1']);
    expect(r.status, why).toBe(2);
    expect(r.stderr, why).toMatch(message);
    if (why !== 'empty list') expect(r.stderr, why).not.toMatch(/has no project/);
  }
}, 60_000);

it('NFR-PERF-04: a seat\'s sign-in requests wait out a 429 and go again, with the same arguments, up to 60 s in all', async () => {
  // R16-6, the sequence around signInRetryDelay: no network, a stand-in for send and for sleep.
  const answers = [new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }), new Response('slow down', { status: 429 }), new Response('ok', { status: 200 })];
  const calls: Array<[string, unknown]> = [];
  const slept: number[] = [];
  const send = withSignInRetry(
    async (path: string, init?: unknown) => {
      calls.push([path, init]);
      return answers.shift() as Response;
    },
    { sleep: async (ms: number) => void slept.push(ms), onGiveUp: () => new Error('gave up') },
  );
  const body = new URLSearchParams({ a: '1' });
  const res = await send('/api/auth/callback/credentials', { method: 'POST', body });
  expect(res.status).toBe(200);
  expect(slept).toEqual([1000, 2000]);
  expect(calls).toHaveLength(3);
  expect(calls.every(([path, init]) => path === '/api/auth/callback/credentials' && (init as { body: URLSearchParams }).body === body)).toBe(true);

  // A seat that is answered 429 for ever stops after 60 s of waiting, having waited exactly that.
  const slept2: number[] = [];
  const stubborn = withSignInRetry(async () => new Response('', { status: 429 }), { sleep: async (ms: number) => void slept2.push(ms), onGiveUp: () => new Error('gave up') });
  await expect(stubborn('/api/auth/csrf')).rejects.toThrow('gave up');
  expect(slept2.reduce((a, b) => a + b, 0)).toBe(60_000);
  // Anything but 429 is handed back untouched, whatever it is.
  for (const status of [200, 302, 401, 500]) {
    const never = withSignInRetry(async () => new Response('', { status }), { sleep: async () => { throw new Error('must not sleep'); }, onGiveUp: () => new Error('gave up') });
    expect((await never('/x')).status).toBe(status);
  }
});

it('NFR-PERF-04 NFR-SEC-17: --connect-to puts the base\'s name on the wire as server name, Host and Origin, and a 429 at sign-in is waited out', async () => {
  // R15-2 and R16-6 on the wire, without the nginx stack: a self-signed certificate for makrai.org, a server on 127.0.0.1.
  const dir = mkdtempSync(join(tmpdir(), 'load-script-tls-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'k.pem');
  const cert = join(dir, 'c.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=makrai.org'], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  const seen: Array<{ path: string; servername: string | false | null; host: string | undefined; origin: string | undefined; at: number }> = [];
  let csrfAnswers = 0;
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    seen.push({ path, servername: (req.socket as TLSSocket).servername, host: req.headers.host, origin: req.headers.origin, at: Date.now() });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/auth/csrf') {
      csrfAnswers += 1;
      return csrfAnswers === 1 ? (res.writeHead(429, { 'content-type': 'text/html' }), void res.end('<html>429</html>')) : json(200, { csrfToken: 'token' }, { 'set-cookie': 'csrf=1; Path=/' });
    }
    if (path === '/api/auth/callback/credentials') return void (res.writeHead(302, { location: '/', 'set-cookie': 'session=abc; Path=/; HttpOnly' }), res.end());
    if (path === '/api/auth/session') return json(200, /session=abc/.test(req.headers.cookie ?? '') ? { user: { id: 'u1' } } : null);
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>404</html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;

  const r = await runAsync(['--base', 'https://makrai.org', '--connect-to', `127.0.0.1:${port}`, '--manifest', manifestFile(), '--project', 'p1', '--users', '1', '--seconds', '1', '--allow-pending']);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('op=save-decision pending');
  // The first request names makrai.org three ways, and so does every other.
  expect(seen[0]).toMatchObject({ path: '/api/auth/csrf', servername: 'makrai.org', host: 'makrai.org', origin: 'https://makrai.org' });
  for (const hit of seen) expect(hit, hit.path).toMatchObject({ servername: 'makrai.org', host: 'makrai.org', origin: 'https://makrai.org' });
  // The 429 was waited out: the second csrf request came about two seconds after the first, and nothing else came between them.
  const csrf = seen.filter((h) => h.path === '/api/auth/csrf');
  expect(csrf).toHaveLength(2);
  expect(csrf[1].at - csrf[0].at).toBeGreaterThanOrEqual(1900);
  expect(seen.indexOf(csrf[1])).toBe(1);
}, 30_000);

it('NFR-PERF-04: the seats sign in one at a time, in manifest order, before the first measured request', async () => {
  const stub = await stubServer((req, res) => {
    if (req.url?.endsWith('/projects')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[{"id":"p1"}]');
      return true;
    }
    return false;
  });
  const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(3), '--users', '3', '--seconds', '1', '--allow-pending']);
  expect(r.status, r.stderr).toBe(0);
  const paths = stub.hits.map((h) => h.path);
  // Three requests per seat, a seat after the previous one's last; then the project list; then the measured window.
  const authSteps = ['/api/auth/csrf', '/api/auth/callback/credentials', '/api/auth/session'];
  expect(paths.slice(0, 9)).toEqual([...authSteps, ...authSteps, ...authSteps]);
  expect(paths[9]).toMatch(/\/projects$/);
  expect(paths.slice(10).some((p) => p.startsWith('/api/auth/'))).toBe(false); // no sign-in request inside the window
}, 30_000);


// ---- C4 round 1 items 22, 23 and 24 ---------------------------------------------------------------------------

it('NFR-PERF-04: every save of a virtual user differs from its last one, and the users differ from each other', () => {
  // DEC-a refuses a save equal to the current version with 422, so a repeated body would be refused after the first.
  const base = { requestId: 'r', stage: 'pre-processing', questionId: 'Q-PP-01', baseVersion: null, userId: 'u1', today: '2026-10-30' };
  const a1 = saveDecisionBody({ ...base, i: 0, n: 1 });
  const a2 = saveDecisionBody({ ...base, i: 0, n: 2, baseVersion: 1 });
  const b1 = saveDecisionBody({ ...base, i: 1, n: 1, userId: 'u2' });
  expect([a1.reason, a2.reason, b1.reason]).toEqual(['load u0 #1', 'load u0 #2', 'load u1 #1']);
  expect(new Set([a1.reason, a2.reason, b1.reason]).size).toBe(3);
  expect(a1).toMatchObject({ stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', decidedBy: { kind: 'member', userId: 'u1' }, declaredDate: '2026-10-30' });
  expect(a2.baseVersionNumber).toBe(1);
  // Nothing else of a body is a reason to think two saves are the same save: the request id is the caller's.
  expect(saveDecisionBody({ ...base, i: 0, n: 3, requestId: 'other' }).requestId).toBe('other');
});

it('NFR-PERF-04: the users take the manifest\'s owner and admin seats, one each, and fewer seats than users is a refusal that names both counts', async () => {
  const seat = (role: string, k: number, orgSlug = 'acme') => ({ userId: `u${k}`, email: `${role}${k}@x.test`, role, orgSlug });
  const manifest = [seat('owner', 1), seat('assessor', 2), seat('admin', 3), seat('viewer', 4), seat('owner', 5, 'other'), seat('owner', 6)];
  // Owners and admins of the organisation, in manifest order; the assessor, the viewer and the other organisation's owner are not seats.
  expect(selectSeats(manifest, 'acme', 3).map((u: { userId: string }) => u.userId)).toEqual(['u1', 'u3', 'u6']);
  expect(selectSeats(manifest, 'acme', 2).map((u: { userId: string }) => u.userId)).toEqual(['u1', 'u3']);
  expect(() => selectSeats(manifest, 'acme', 4)).toThrow(/--users 4[\s\S]*3/);

  // The whole script: 3 seats and 10 users exits 2 before anything is sent.
  const few = await stubServer();
  const refused = await runAsync(['--base', few.base, '--manifest', manifestFile(3), '--project', 'p1', '--users', '10', '--seconds', '1']);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/--users 10[\s\S]*owner or admin seats[\s\S]*3/);
  expect(few.hits).toEqual([]);
  // The assessor and viewer seats of a manifest do not count towards the users.
  const roles = ['owner', 'assessor', 'admin', 'viewer'];
  const mixed = await runAsync(['--base', few.base, '--manifest', manifestFile(roles), '--project', 'p1', '--users', '3', '--seconds', '1']);
  expect(mixed.status).toBe(2);
  expect(mixed.stderr).toMatch(/--users 3[\s\S]*2/);

  // 10 seats and 10 users: 10 accounts sign in, and each virtual user then works with its own session.
  const ten = await stubServer();
  const ok = await runAsync(['--base', ten.base, '--manifest', manifestFile(10), '--project', 'p1', '--users', '10', '--seconds', '1', '--allow-pending']);
  expect(ok.status, ok.stderr).toBe(0);
  const signedIn = ten.hits.filter((h) => h.path === '/api/auth/callback/credentials');
  expect(signedIn).toHaveLength(10);
  const sessions = new Set(ten.hits.filter((h) => /\/reviews$/.test(h.path)).map((h) => h.cookie.match(/session=[^;]+/)?.[0]));
  expect(sessions.size).toBe(10); // ten virtual users, ten sessions: never sessions[i % n]
}, 60_000);

it('NFR-PERF-04: a seat asks for at most 20 seals and 10 documents in a run, then skips them for the rest of the window', () => {
  expect(SEAT_LIMITS).toEqual({ 'seal-stage': 20, 'generate-document': 10 }); // 1 h, 20 and 10 per user (00-contract.md:1061-1062)
  const none = new Set<string>();
  const ask = (sent: Record<string, number>, more: object = {}) =>
    operationsToAsk({ sent, hasReview: true, exportsLeft: 0, pendingOnly: none, ...more }) as string[];
  expect(ask({})).toEqual(['save-decision', 'render-s10', 'render-s11', 'seal-stage', 'generate-document']);
  expect(ask({ 'seal-stage': 19, 'generate-document': 9 })).toContain('seal-stage');
  expect(ask({ 'seal-stage': 19, 'generate-document': 9 })).toContain('generate-document');
  expect(ask({ 'seal-stage': 20, 'generate-document': 9 })).not.toContain('seal-stage');
  expect(ask({ 'seal-stage': 19, 'generate-document': 10 })).not.toContain('generate-document');
  expect(ask({ 'seal-stage': 19, 'generate-document': 10 })).toContain('seal-stage'); // the documents' cap is lower, the seals go on
  expect(ask({ 'seal-stage': 20, 'generate-document': 10 })).toEqual(['save-decision', 'render-s10', 'render-s11']);
  // The other reasons to skip an operation are unchanged.
  expect(ask({}, { hasReview: false })).toEqual(['save-decision', 'render-s10', 'render-s11']);
  expect(ask({}, { exportsLeft: 2 })).toContain('team-export');
  expect(ask({}, { pendingOnly: new Set(['render-s11', 'seal-stage']) })).toEqual(['save-decision', 'render-s10', 'generate-document']);
  // Over a whole run the requests a seat sends stay within its caps.
  const sent: Record<string, number> = {};
  for (let iteration = 0; iteration < 500; iteration++)
    for (const op of ask(sent)) sent[op] = (sent[op] ?? 0) + 1;
  expect(sent['seal-stage']).toBe(20);
  expect(sent['generate-document']).toBe(10);
  expect(sent['save-decision']).toBe(500);
  // A 429 on a seal or a document is an error, never an expected answer.
  const s = newStats();
  record(s, 'seal-stage', 429, 5, { apiJson: true, code: 'rate_limited' });
  record(s, 'generate-document', 429, 5, { apiJson: true, code: 'rate_limited' });
  expect(s['seal-stage']).toMatchObject({ errors: 1, expected429: 0 });
  expect(s['generate-document']).toMatchObject({ errors: 1, expected429: 0 });
});

it('NFR-PERF-04: against routes that all succeed, no seat sends more than 20 seal and 10 document requests', async () => {
  const counts = new Map<string, { seals: number; documents: number }>();
  const stub = await stubServer((req, res) => {
    const url = req.url ?? '';
    const cookie = req.headers.cookie ?? '';
    const answer = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)), true);
    if (req.method === 'POST' && /\/reviews$/.test(url)) return answer(201, { id: 'rv1' });
    if (req.method === 'POST' && /\/seals$/.test(url)) {
      counts.set(cookie, { seals: (counts.get(cookie)?.seals ?? 0) + 1, documents: counts.get(cookie)?.documents ?? 0 });
      return answer(201, { id: 's1' });
    }
    if (req.method === 'POST' && /\/documents$/.test(url)) {
      counts.set(cookie, { seals: counts.get(cookie)?.seals ?? 0, documents: (counts.get(cookie)?.documents ?? 0) + 1 });
      return answer(201, { id: 'd1' });
    }
    if (req.method === 'POST' && /\/decisions$/.test(url)) return answer(201, { versionNumber: 1 });
    if (/\/export$/.test(url)) return answer(200, {});
    if (/\/orgs\/acme\/projects\//.test(url)) return (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>page</html>'), true);
    return false;
  });
  const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(2), '--project', 'p1', '--users', '2', '--seconds', '2']);
  expect(r.status, r.stderr).toBe(0);
  expect([...counts.values()]).toEqual([
    { seals: 20, documents: 10 },
    { seals: 20, documents: 10 },
  ]);
  expect(r.stdout).toMatch(/^op=seal-stage p95ms=\d+ budgetms=3000 n=40$/m);
  expect(r.stdout).toMatch(/^op=generate-document p95ms=\d+ budgetms=15000 n=20$/m);
}, 30_000);


// ---- C4 round 1 items 25 and 27 -----------------------------------------------------------------------------------

it('NFR-PERF-04: 60 requests for one seat and path are spread so that no 60 s window holds more than 50', () => {
  // K0b\'s default limit is 60 a minute per user per path (lib/rate-limit.ts); the script stays under it with room.
  const WINDOW = 60_000;
  let now = 0;
  const sent: number[] = [];
  for (let i = 0; i < 60; i++) {
    now += paceDelay(sent, now);
    sent.push(now);
  }
  expect(sent.slice(0, 50).every((t) => t === 0)).toBe(true); // 50 may go at once
  expect(sent[50]).toBe(WINDOW); // the 51st waits until the first has left the window
  for (const t of sent) expect(sent.filter((u) => u > t - WINDOW && u <= t).length, `window ending at ${t}`).toBeLessThanOrEqual(50);
  // The same, for requests that are wanted every 10 ms for five minutes.
  const steady: number[] = [];
  let clock = 0;
  for (let i = 0; i < 30_000; i++) {
    clock = Math.max(clock + 10, clock + paceDelay(steady, clock));
    steady.push(clock);
  }
  for (let i = 0; i < steady.length; i += 97) {
    expect(steady.filter((u) => u > steady[i] - WINDOW && u <= steady[i]).length).toBeLessThanOrEqual(50);
  }
  expect(paceDelay([], 0)).toBe(0);
  expect(paceDelay([0, 1000, 2000], 3000)).toBe(0); // under the limit: no wait
  expect(paceDelay(Array.from({ length: 50 }, () => 0), 59_999)).toBe(1); // one millisecond short of leaving the window
});

it('NFR-PERF-04: the pacer keeps a count per path, waits outside the measured time, and refuses a wait that would pass the end of the window', async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = createPacer({ now: () => clock, sleep: async (ms: number) => void (slept.push(ms), (clock += ms)) });
  const deadline = 600_000;
  for (let i = 0; i < 50; i++) expect(await pacer.wait('/api/a', deadline)).toBe(true);
  expect(slept).toEqual([]); // 50 requests on one path: no wait
  expect(await pacer.wait('/api/b', deadline)).toBe(true); // another path has its own count
  expect(slept).toEqual([]);
  expect(await pacer.wait('/api/a', deadline)).toBe(true); // the 51st on /api/a
  expect(slept).toEqual([60_000]);
  expect(clock).toBe(60_000);
  // A wait that ends after the deadline is not taken: the caller stops, and nothing is slept.
  const late = createPacer({ now: () => clock, sleep: async () => { throw new Error('must not sleep'); } });
  for (let i = 0; i < 50; i++) await late.wait('/api/c', clock + 10_000);
  expect(await late.wait('/api/c', clock + 10_000)).toBe(false);
  // The query string is not part of the path.
  const q = createPacer({ now: () => clock, sleep: async (ms: number) => void (clock += ms) });
  for (let i = 0; i < 50; i++) await q.wait(`/api/d?page=${i}`, deadline);
  const before = clock;
  await q.wait('/api/d?page=99', deadline);
  expect(clock - before).toBe(60_000);
});

it('NFR-PERF-04: a seat sends at most 50 saves in a minute, the run ends at the end of its window, and the wait is not in a p95', async () => {
  const stamps: number[] = [];
  const stub = await stubServer((req, res) => {
    if (req.method === 'POST' && /\/decisions$/.test(req.url ?? '')) {
      stamps.push(Date.now());
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"versionNumber":1}');
      return true;
    }
    return false;
  });
  const started = Date.now();
  const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(1), '--project', 'p1', '--users', '1', '--seconds', '2', '--allow-pending']);
  expect(r.status, r.stderr).toBe(0);
  expect(Date.now() - started).toBeLessThan(20_000); // a seat at its limit does not sleep past the window
  expect(stamps).toHaveLength(50);
  expect(r.stdout).toMatch(/^op=save-decision p95ms=\d+ budgetms=300 n=50$/m); // the wait for the 51st is in no sample
}, 40_000);

it('NFR-PERF-04: a one-owner manifest with the default 10 users exits 2 at seat selection, before any request', async () => {
  // Step 10\'s live check therefore runs with --users 1.
  const stub = await stubServer();
  const r = await runAsync(['--base', stub.base, '--manifest', manifestFile(1), '--project', 'p1', '--seconds', '1']);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/--users 10[\s\S]*owner or admin seats[\s\S]*1/);
  expect(stub.hits).toEqual([]);
}, 20_000);
