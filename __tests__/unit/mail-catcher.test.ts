import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resend } from 'resend';
import { markerFor, MARKER_PATTERN } from '../helpers/markers';
import { stripAnsi } from '../helpers/spawnText';

/**
 * The local mail catcher (SRS 12.2 step 9; contract "Further cross-unit symbols", gap G102; obligation B20): it stands in
 * for Resend through the SDK's RESEND_BASE_URL (node_modules/resend/dist/index.mjs, getDefaultBaseUrl), so a live run
 * reads the reset link from a file and no real mailbox or key is used. The key is `re_test_local`, never a real one. It
 * binds the loopback or the Docker bridge only, and its out file (which holds reset links) is mode 600.
 * The child runs with NO_COLOR=1 and no FORCE_COLOR; its output is stripped of ANSI codes before matching.
 */
function childEnv(): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _f, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
}

function spawnCatcher(args: string[]): Promise<{ port: number; stop: () => Promise<void> }> {
  const child = spawn('node', ['scripts/mail-catcher/catcher.mjs', ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening (\d+)/.exec(stripAnsi(out));
      if (m) resolve({ port: Number(m[1]), stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); }) });
    });
    child.once('exit', (code) => reject(new Error(`catcher exited ${code}`)));
  });
}

describe('scripts/mail-catcher/catcher.mjs', () => {
  it('NFR-PRIV-02: the mail catcher stores each POST /emails body and answers as Resend does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-'));
    const outFile = join(dir, 'mail.jsonl');
    const { port, stop } = await spawnCatcher(['--host', '127.0.0.1', '--port', '0', '--out', outFile]);
    const saved = process.env.RESEND_BASE_URL;
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const res = await new Resend('re_test_local').emails.send({ from: 'a@example.test', to: 'b@example.test', subject: markerFor('subject', 1), html: '<p>x</p>', text: 'x' });
      expect(res).toMatchObject({ data: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, error: null });
      expect((await fetch(`http://127.0.0.1:${port}/hc/makrai-reminders/fail`, { method: 'POST' })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/emails`)).status).toBe(404); // only POST
      const lines = readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.kind)).toEqual(['email', 'ping']);
      expect(lines[0]).toMatchObject({ from: 'a@example.test', to: 'b@example.test', html: '<p>x</p>', text: 'x' });
      expect(lines[0].subject).toMatch(MARKER_PATTERN);
      expect(Number.isNaN(Date.parse(lines[0].receivedAt))).toBe(false);
      expect(lines[1].path).toBe('/hc/makrai-reminders/fail');
      expect(statSync(outFile).mode & 0o777).toBe(0o600);
    } finally {
      process.env.RESEND_BASE_URL = saved;
      await stop();
    }
    for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
      const r = spawnSync('node', ['scripts/mail-catcher/catcher.mjs', '--host', host, '--port', '0', '--out', join(dir, 'x.jsonl')], { env: childEnv(), encoding: 'utf8' });
      expect({ host, status: r.status }).toEqual({ host, status: 2 });
    }
  }, 30_000);
});

describe('the catcher keeps its promises', () => {
  it('NFR-PRIV-02: an existing out file is made mode 600, and a mail without a subject is refused as Resend refuses it', async () => {
    const { writeFileSync, chmodSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'mail-'));
    const outFile = join(dir, 'mail.jsonl');
    writeFileSync(outFile, 'old\n');
    chmodSync(outFile, 0o644);
    const { port, stop } = await spawnCatcher(['--host', '127.0.0.1', '--port', '0', '--out', outFile]);
    try {
      expect(statSync(outFile).mode & 0o777).toBe(0o600);
      const r = await fetch(`http://127.0.0.1:${port}/emails`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'a@example.test', to: 'b@example.test' }) });
      expect(r.status).toBe(422);
      expect(readFileSync(outFile, 'utf8')).toBe('');
    } finally {
      await stop();
    }
  }, 30_000);
});
