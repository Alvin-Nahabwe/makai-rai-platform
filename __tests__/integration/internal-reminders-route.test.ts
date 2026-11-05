import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { runReminders } from '@/lib/reminders/job';
import { POST } from '@/app/api/internal/reminders/route';
import { captureLogs } from '../helpers/logCapture';
import { shText } from '../helpers/spawnText';

/**
 * FR-OPS-02, NFR-SEC-13, NFR-SEC-14 (SRS line 1149): route 40 runs the reminder job for a caller that holds
 * REMINDER_JOB_TOKEN and for nobody else. No database: the job is replaced, because what is proved here is
 * who may start it, not what it does (FUP's tests).
 */

vi.mock('@/lib/reminders/job', () => ({
  runReminders: vi.fn(async () => ({ attempted: 2, sent: 1, failed: 1, optedOut: 0, skippedLocked: false })),
}));

const TOKEN = '0123456789abcdef'.repeat(4); // 64 lowercase hex, the form `openssl rand -hex 32` prints
const savedToken = process.env.REMINDER_JOB_TOKEN;

const callRoute = (authorization?: string) =>
  POST(new NextRequest('http://localhost/api/internal/reminders', { method: 'POST', headers: authorization === undefined ? {} : { authorization } }));

beforeEach(() => {
  vi.mocked(runReminders).mockClear();
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.REMINDER_JOB_TOKEN;
  else process.env.REMINDER_JOB_TOKEN = savedToken;
});

describe('route 40, POST /api/internal/reminders', () => {
  it('FR-OPS-02 NFR-SEC-13: without the token, with a wrong one, or with none configured, the route answers 401 and runs nothing', async () => {
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    for (const auth of [undefined, 'Bearer ' + 'b'.repeat(64), 'Basic ' + TOKEN, TOKEN]) {
      const res = await callRoute(auth);
      expect([auth, res.status, await res.json()]).toEqual([auth, 401, { error: 'Unauthorized', code: 'unauthenticated' }]);
    }
    delete process.env.REMINDER_JOB_TOKEN;
    expect((await callRoute('Bearer ' + TOKEN)).status).toBe(401);
    process.env.REMINDER_JOB_TOKEN = '';
    expect((await callRoute('Bearer ')).status).toBe(401);
    // Not 64 lowercase hex characters: refused even when presented exactly (fail closed).
    for (const bad of ['short', 'x'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(32)]) {
      process.env.REMINDER_JOB_TOKEN = bad;
      expect({ bad, status: (await callRoute('Bearer ' + bad)).status }).toEqual({ bad, status: 401 });
    }
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    // (A trailing space cannot be sent: the Headers API trims it, as an HTTP server does, so it never reaches the route.)
    for (const auth of ['Bearer ' + TOKEN.toUpperCase(), 'Bearer  ' + TOKEN, 'Bearer ' + TOKEN + 'a', 'bearer ' + TOKEN]) {
      expect({ auth, status: (await callRoute(auth)).status }).toEqual({ auth, status: 401 });
    }
    expect(runReminders).not.toHaveBeenCalled();
  });

  it('FR-OPS-02: a well-formed header answers 401 while the setting is malformed (the setting is checked, not only the header)', async () => {
    // The header is valid. These settings also differ from the token, so the digest comparison refuses them too: this case
    // pins the answer, it does not prove the form check on its own (a digest that matched would imply a 64-hex setting).
    // The form check is contract row 40's rule, and the REMINDER_TOKEN_UNSET_OR_MALFORMED case below sees it act.
    for (const setting of [TOKEN + '\n', ' ' + TOKEN, `"${TOKEN}"`, TOKEN + 'a']) {
      process.env.REMINDER_JOB_TOKEN = setting;
      expect({ setting, status: (await callRoute('Bearer ' + TOKEN)).status }).toEqual({ setting, status: 401 });
    }
    expect(runReminders).not.toHaveBeenCalled();
  });

  it('FR-OPS-02: a token of another length answers 401, not 500', async () => {
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    expect((await callRoute('Bearer x')).status).toBe(401);
    expect((await callRoute('Bearer ' + 'a'.repeat(65))).status).toBe(401);
  });

  it('FR-OPS-02: with the token, the route runs the job once and answers its counts only', async () => {
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    vi.mocked(runReminders).mockResolvedValueOnce({ attempted: 2, sent: 1, failed: 1, optedOut: 0, skippedLocked: false, extra: 'x' } as never);
    const res = await callRoute('Bearer ' + TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attempted: 2, sent: 1, failed: 1, optedOut: 0, skippedLocked: false });
    expect(runReminders).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runReminders).mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('FR-OPS-02: a run that throws after a partial failure answers 500 with a support reference and no detail', async () => {
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    vi.mocked(runReminders).mockRejectedValueOnce(new Error('Reminder run finished with failures.'));
    const { result: res, lines } = await captureLogs(() => callRoute('Bearer ' + TOKEN));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('internal_error');
    expect(typeof body.reference).toBe('string');
    expect(lines.join('\n')).toContain(body.reference);   // the same reference is in exactly the log the operator reads
    expect(JSON.stringify(body)).not.toContain('failures');
  });

  it('FR-OPS-02 NFR-OBS-01: an unset, empty or malformed setting answers the same 401 as a wrong token and logs one error event per process, without the value', async () => {
    vi.resetModules();
    const fresh = (await import('@/app/api/internal/reminders/route')).POST;
    const call = (authorization: string) => fresh(new NextRequest('http://localhost/api/internal/reminders', { method: 'POST', headers: { authorization } }));
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    const wrong = await call('Bearer ' + 'b'.repeat(64));
    const wrongBody = await wrong.json();
    const marker = 'MALFORMED-SETTING-MARKER-' + 'q'.repeat(40);
    const run = async (setting: string | undefined) => {
      if (setting === undefined) delete process.env.REMINDER_JOB_TOKEN; else process.env.REMINDER_JOB_TOKEN = setting;
      return captureLogs(async () => {
        const res = await call('Bearer ' + TOKEN);
        return [res.status, await res.json()] as const;
      });
    };
    const first = await run(undefined);
    expect(first.result).toEqual([401, wrongBody]);
    const events = first.lines.filter((l) => l.includes('REMINDER_TOKEN_UNSET_OR_MALFORMED'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0])).toMatchObject({ level: 'error', event: 'REMINDER_TOKEN_UNSET_OR_MALFORMED' });
    // Once per process: a second refusal for the same cause, or for another malformed value, writes nothing more.
    const second = await run(marker);
    expect(second.result[0]).toBe(401);
    expect(second.lines.filter((l) => l.includes('REMINDER_TOKEN_UNSET_OR_MALFORMED'))).toEqual([]);
    expect([...first.lines, ...second.lines].join('\n')).not.toContain(marker);
    expect([...first.lines, ...second.lines].join('\n')).not.toContain(TOKEN);
    // A wrong token against a well-formed setting is not that event.
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    const ordinary = await captureLogs(() => call('Bearer ' + 'b'.repeat(64)));
    expect(ordinary.lines.filter((l) => l.includes('REMINDER_TOKEN_UNSET_OR_MALFORMED'))).toEqual([]);
    expect(runReminders).not.toHaveBeenCalled();
  });

  it('FR-OPS-02 NFR-SEC-14: the route logs neither the token nor an authorization header', async () => {
    process.env.REMINDER_JOB_TOKEN = TOKEN;
    const ok = await captureLogs(() => callRoute('Bearer ' + TOKEN));
    vi.mocked(runReminders).mockRejectedValueOnce(new Error('boom'));
    const failing = await captureLogs(() => callRoute('Bearer ' + TOKEN));
    const wrong = await captureLogs(() => callRoute('Bearer ' + 'b'.repeat(64)));
    const text = [...ok.lines, ...failing.lines, ...wrong.lines].join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('b'.repeat(64));
    expect(text.toLowerCase()).not.toContain('authorization');
  });

  it('NFR-SEC-13 FR-OPS-02: the internal route is the only production caller of runReminders', () => {
    // OPS's own pin: reminder-surface.test.ts allows the route, this case requires it.
    const hits = shText(`git grep -l --untracked -F -e runReminders -- app lib components proxy.ts || true`).split('\n').filter(Boolean);
    expect(hits.filter((f) => f !== 'lib/reminders/job.ts')).toEqual(['app/api/internal/reminders/route.ts']);
  });
});
