import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertLocalBase, p95, parseArgs } from '../../scripts/load/save-decisions.mjs';

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
