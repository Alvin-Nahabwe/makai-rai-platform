import { afterAll, describe, expect, it } from 'vitest';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resend } from 'resend';
import { MARKER_PATTERN, markerFor } from '../helpers/markers';
import { colourlessEnv, stripAnsi } from '../helpers/spawnText';

/**
 * The live run's email transport (12.2 step 9, gap G102): ACC-b's mail catcher (scripts/mail-catcher/catcher.mjs,
 * contract row) stands in for Resend, reached through the SDK's RESEND_BASE_URL. The SDK reads that variable when a
 * client is constructed (node_modules/resend/dist/index.mjs:1633 and the constructor's `this.baseUrl`), so the test
 * sets it before `new Resend`. This file tests ACC-b's catcher against its contract row; it does not edit it.
 */
const CATCHER = 'scripts/mail-catcher/catcher.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A port no process listens on now: bind port 0, read the one the system gave, close. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (a === null || typeof a === 'string') { s.close(); reject(new Error('no port from listen(0)')); return; }
      s.close(() => resolve(a.port));
    });
  });
}

/** Lines of `ss -ltn` whose local address ends in :<port>. */
function listenersOn(port: number): string[] {
  return execFileSync('ss', ['-ltn'], { encoding: 'utf8' }).split('\n').slice(1)
    .filter((l) => l.split(/\s+/)[3]?.endsWith(`:${port}`));
}

/** Waits until GET / on the catcher answers 404 (its answer for any unknown path); fails after 10 s naming what it saw. */
async function waitFor404(port: number, child: ChildProcess, output: () => string): Promise<void> {
  const until = Date.now() + 10_000;
  let last = 'no answer';
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the catcher exited (${child.exitCode ?? child.signalCode}): ${output()}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.status === 404) return;
      last = `status ${r.status}`;
    } catch (e) {
      // Not listening yet: keep polling, and report the last error (with its cause, ECONNREFUSED and the like) if it never comes up.
      last = e instanceof Error && e.cause ? `${e} (${String(e.cause)})` : String(e);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the catcher did not answer GET / with 404 within 10 s (last: ${last}); output: ${output()}`);
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean };
/** How the process ended; `timedOut` when it was still running after 5 s (it is then killed). */
function exitWithin(child: ChildProcess, ms = 5_000): Promise<Exit> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false }); return; }
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'SIGKILL', timedOut: true }); }, ms);
    child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, timedOut: false }); });
  });
}

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the mail catcher behind the Resend SDK', () => {
  it('NFR-PRIV-02: the Resend SDK delivers to the mail catcher through RESEND_BASE_URL, and the catcher refuses 0.0.0.0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-catcher-'));
    dirs.push(dir);
    const out = join(dir, 'mail.jsonl');
    const port = await freePort();
    let text = '';
    const child = spawn(process.execPath, [CATCHER, '--host', '127.0.0.1', '--port', String(port), '--out', out],
      { env: colourlessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout!.on('data', (b: Buffer) => { text += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { text += b.toString(); });
    await waitFor404(port, child, () => stripAnsi(text));

    const previous = process.env.RESEND_BASE_URL;
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;
    let sent;
    try {
      sent = await new Resend('re_test_local').emails.send({
        from: 'a@example.test', to: 'b@example.test', subject: markerFor('subject', 1), html: '<p>x</p>',
      });
    } finally {
      if (previous === undefined) delete process.env.RESEND_BASE_URL; else process.env.RESEND_BASE_URL = previous;
    }
    expect(sent.error).toBeNull();
    expect(sent.data?.id).toMatch(UUID);

    const ping = await fetch(`http://127.0.0.1:${port}/hc/makrai-reminders/fail`, { method: 'POST' });
    expect(ping.status).toBe(200);

    const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const emails = lines.filter((l) => l.kind === 'email');
    expect(emails).toHaveLength(1);
    expect(String(emails[0].subject).match(MARKER_PATTERN)).toEqual([markerFor('subject', 1)]);
    expect(lines.filter((l) => l.kind === 'ping').map((l) => l.path)).toEqual(['/hc/makrai-reminders/fail']);

    child.kill('SIGTERM');
    expect((await exitWithin(child)).timedOut, 'the catcher stops on SIGTERM').toBe(false);

    // The catcher must not listen on every interface: a spawn with --host 0.0.0.0 exits non-zero and leaves no listener.
    const wide = await freePort();
    let wideText = '';
    const refused = spawn(process.execPath, [CATCHER, '--host', '0.0.0.0', '--port', String(wide), '--out', join(dir, 'wide.jsonl')],
      { env: colourlessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(refused);
    refused.stdout!.on('data', (b: Buffer) => { wideText += b.toString(); });
    refused.stderr!.on('data', (b: Buffer) => { wideText += b.toString(); });
    const exit = await exitWithin(refused);
    expect(exit.timedOut, `the catcher with --host 0.0.0.0 did not exit within 5 s; output: ${stripAnsi(wideText)}`).toBe(false);
    // The contract row: any --host other than 127.0.0.1 or 172.17.0.1 exits 2 (a crash or a usage error exits otherwise).
    expect(exit, stripAnsi(wideText)).toEqual({ code: 2, signal: null, timedOut: false });
    expect(listenersOn(wide)).toEqual([]);
  }, 30_000);
});
