import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertLocalBase, newStats, p95, parseArgs, record, renderReport } from '../../scripts/load/save-decisions.mjs';

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

it('NFR-PERF-04: a 409 base_version_moved on a save and the export\'s 429 are counted and printed but do not fail the run', () => {
  const s = healthy();
  fill(s, 'save-decision', 7, 409, 20, { apiJson: true, code: 'base_version_moved' });
  fill(s, 'team-export', 3, 429, 20, { apiJson: true, code: 'rate_limited' });
  const r = renderReport(s);
  expect(r.lines).toContain('op=save-decision p95ms=10 budgetms=300 n=5 errors=7 firstStatus=409 expected409=7');
  expect(r.lines).toContain('op=team-export p95ms=10 budgetms=10000 n=5 errors=3 firstStatus=429 expected429=3');
  expect(r.code).toBe(0);
  // Not expected: a 409 with another code, a 429 on a save, any 4xx elsewhere. Counted as errors, never as expected.
  const other = healthy();
  record(other, 'save-decision', 409, 20, { apiJson: true, code: 'request_id_reused' });
  record(other, 'save-decision', 429, 20, API_JSON);
  record(other, 'seal-stage', 403, 20, API_JSON);
  const o = renderReport(other);
  expect(o.lines.find((l) => l.startsWith('op=save-decision'))).toMatch(/errors=2 firstStatus=409$/);
  expect(o.lines.find((l) => l.startsWith('op=seal-stage'))).toMatch(/errors=1 firstStatus=403$/);
  expect(o.code).toBe(0); // 4xx answers beside measured ones are printed; only 5xx, timeouts and an unmeasured operation fail
  // An operation whose every answer was a 409 measured nothing.
  const none = newStats();
  fill(none, 'save-decision', 4, 409, 20, { apiJson: true, code: 'base_version_moved' });
  expect(renderReport(none).lines).toContain('op=save-decision notmeasured errors=4 firstStatus=409 expected409=4');
});

// ---- the whole script against a stand-in server on 127.0.0.1 --------------------------------------------------

interface Stub {
  base: string;
  hits: Array<{ method: string; path: string; at: number }>;
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
    hits.push({ method: req.method ?? '', path, at: Date.now() });
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/auth/csrf') return json(200, { csrfToken: 'token' }, { 'set-cookie': 'csrf=1; Path=/' });
    if (path === '/api/auth/callback/credentials') {
      res.writeHead(302, { location: '/', 'set-cookie': 'session=abc; Path=/; HttpOnly' });
      return void res.end();
    }
    if (path === '/api/auth/session') return json(200, /session=abc/.test(req.headers.cookie ?? '') ? { user: { id: 'u1' } } : null);
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

function manifestFile(seats = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-script-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const users = Array.from({ length: seats }, (_, i) => ({
    userId: `u${i + 1}`, email: `owner${i + 1}@example.test`, password: 'fixture-password', orgSlug: 'acme', role: 'owner', index: i % 2, storageStatePath: 'unused',
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
  const manifest = manifestFile();
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
