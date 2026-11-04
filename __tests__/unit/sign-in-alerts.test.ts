import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs, scanLines } from '../helpers/logCapture';

/**
 * The password-spraying alert (NFR-OBS-04, SRS line 3370; obligation B16). Ruling 10 removed the address-keyed sign-in
 * limits, the coarse defence against one attacker trying a few passwords on many accounts; this alarm restores
 * visibility. In-process windows (one process, K-5). The mail goes to ADMIN_EMAIL, where the host's own alerts go
 * (ops/host/makrai-lib.sh), and holds counts and a time only.
 */
vi.mock('../../lib/email/send', () => ({ sendEmail: vi.fn(async () => ({ id: 'm1' })) }));
const { sendEmail } = await import('../../lib/email/send');
const { recordSignInFailure, resetSignInAlerts } = await import('../../lib/auth/signInAlerts');

const T0 = Date.parse('2026-11-02T08:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000 * 0.5); // every 30 s, all inside one hour
const saved = { ...process.env };

beforeEach(() => {
  resetSignInAlerts();
  vi.mocked(sendEmail).mockClear();
  vi.mocked(sendEmail).mockResolvedValue({ id: 'm1' });
  process.env.ADMIN_EMAIL = 'owner@makrai.example';
  process.env.EMAIL_FROM_ADDRESS = 'noreply@makrai.example';
  process.env.RESEND_API_KEY = 're_test_local';
});
afterEach(() => {
  process.env = { ...saved };
});

describe('sign-in alerts (NFR-OBS-04)', () => {
  it('NFR-OBS-04: 51 failures across 10 accounts within an hour give one alert; 50 give none', () => {
    for (let i = 0; i < 50; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, at(i));
    expect(sendEmail).not.toHaveBeenCalled();
    recordSignInFailure({ userId: 'u0', locked: false }, at(50));
    recordSignInFailure({ userId: 'u1', locked: false }, at(51));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('NFR-OBS-04: many failures across fewer than 10 accounts give no spray alert', () => {
    for (let i = 0; i < 80; i++) recordSignInFailure({ userId: `u${i % 9}`, locked: false }, at(i));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('NFR-OBS-04: failures older than an hour do not count, and the spray alert repeats only after an hour', () => {
    for (let i = 0; i < 40; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, new Date(T0 + i * 1000));
    // 61 minutes later the first 40 have left the window.
    for (let i = 0; i < 40; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, new Date(T0 + 61 * 60_000 + i * 1000));
    expect(sendEmail).not.toHaveBeenCalled();
    for (let i = 0; i < 11; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, new Date(T0 + 62 * 60_000 + i * 1000));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, new Date(T0 + 63 * 60_000 + i * 1000));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, new Date(T0 + 123 * 60_000 + i * 1000));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('NFR-OBS-04: an account locked 3 times within 24 hours gives one alert', () => {
    const h = (n: number) => new Date(T0 + n * 3600_000);
    recordSignInFailure({ userId: 'u1', locked: true }, h(0));
    recordSignInFailure({ userId: 'u1', locked: true }, h(5));
    recordSignInFailure({ userId: 'u2', locked: true }, h(6));
    expect(sendEmail).not.toHaveBeenCalled();
    recordSignInFailure({ userId: 'u1', locked: true }, h(10));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0].text).toMatch(/^Sign-in alert: an account was locked 3 times in the 24 hours to /);
    recordSignInFailure({ userId: 'u1', locked: true }, h(11));
    expect(sendEmail).toHaveBeenCalledTimes(1); // one per account per 24 hours
    // Locks spread wider than 24 hours give none.
    recordSignInFailure({ userId: 'u3', locked: true }, h(0));
    recordSignInFailure({ userId: 'u3', locked: true }, h(13));
    recordSignInFailure({ userId: 'u3', locked: true }, h(25));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('NFR-OBS-04: the alert mail holds counts and a time only', async () => {
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 51; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, at(i));
    });
    const m = vi.mocked(sendEmail).mock.calls[0][0];
    expect(m.to).toBe(process.env.ADMIN_EMAIL);
    expect(m.from).toBe(process.env.EMAIL_FROM_ADDRESS);
    expect(m.subject).toBe('[makrai] Sign-in alert');
    expect(m.text).not.toMatch(/u\d|@/);
    expect(m.html).not.toMatch(/u\d|@/);
    expect(m.text).toBe(`Sign-in alert: 51 failed sign-ins across 10 accounts in the hour to ${at(50).toISOString().slice(0, 19)} UTC. Read the security log on the host. This message carries no other data.`);
    const events = lines.filter((l) => l.includes('SIGN_IN_ALERT')).map((l) => JSON.parse(l));
    expect(events).toEqual([expect.objectContaining({ event: 'SIGN_IN_ALERT', details: { kind: 'spray', count: 51 } })]);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-OBS-04: a failed send is logged and never thrown into sign-in', async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error('Email send failed (validation_error): bad to owner@makrai.example'));
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 51; i++) expect(() => recordSignInFailure({ userId: `u${i % 10}`, locked: false }, at(i))).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
    });
    const failed = lines.filter((l) => l.includes('SIGN_IN_ALERT')).map((l) => JSON.parse(l)).filter((e) => e.details?.mailed === false);
    expect(failed).toEqual([expect.objectContaining({ level: 'error', details: { kind: 'spray', mailed: false, reason: 'send_failed' } })]);
    expect(scanLines(lines, { markers: false, emails: true })).toEqual([]);
  });

  it('NFR-OBS-04: with no ADMIN_EMAIL the alert is logged as not mailed', async () => {
    delete process.env.ADMIN_EMAIL;
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 51; i++) recordSignInFailure({ userId: `u${i % 10}`, locked: false }, at(i));
    });
    expect(sendEmail).not.toHaveBeenCalled();
    const failed = lines.filter((l) => l.includes('SIGN_IN_ALERT')).map((l) => JSON.parse(l)).filter((e) => e.details?.mailed === false);
    expect(failed).toEqual([expect.objectContaining({ level: 'error', details: { kind: 'spray', mailed: false, reason: 'recipient_unset' } })]);
  });
});
