import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { MARKER_PATTERN, markerText } from '../helpers/markers';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { withReminderRunLock } from '../../lib/data/identityReads';
import { eatDate } from '../../lib/followup/overdue';
import { openMitigationsByStage } from '../../lib/data/followup';

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
import { sendEmail } from '@/lib/email/send';
import { runReminders } from '@/lib/reminders/job';

/**
 * FR-FUP-03 to 06, NFR-REL-06, NFR-REL-08, NFR-PRIV-02, NFR-OBS-01: the reminder job, run with an
 * explicit `now`. The transport is mocked in every case: no mail leaves this file.
 */

const D = '2026-11-02';
const t = (iso: string) => new Date(iso);
const send = vi.mocked(sendEmail);
type Sent = { to: string; from: string; subject: string; html: string; text: string };
const sends = (kind?: 'due' | 'overdue'): Sent[] =>
  (send.mock.calls.map((c) => c[0]) as Sent[]).filter((m) =>
    kind === undefined || (kind === 'due' ? m.subject.startsWith('A mitigation is due today') : m.subject.startsWith('A mitigation is 7 days overdue')));
const logRows = (where: { kind?: string; outcome?: string }) =>
  testDb.reminderLog.findMany({ where, orderBy: [{ attempt: 'asc' }, { at: 'asc' }] });

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  send.mockResolvedValue({ id: 'test-message' });
  process.env.EMAIL_FROM_ADDRESS = 'reminders@fixture.test';
});
afterAll(async () => { await resetDb(); });

async function removeMember(fx: OrgFixture, role: OrgRole): Promise<void> {
  const userId = fx.members[role].userId;
  await testDb.membership.deleteMany({ where: { orgId: fx.org.id, userId } });
}

/** One org, one open team finding, one planned mitigation per entry of `owners`, all due `due`. */
async function world(owners: OrgRole[] = ['assessor'], opts: { due?: string; text?: Parameters<typeof buildOrg>[0] } = {}) {
  const fx = await buildOrg({ label: 'rj', ...(opts.text ?? {}) });
  const p = await addProject(fx);
  const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  const ms: string[] = [];
  for (const owner of owners) ms.push((await addMitigationVersion(fx, f.id, { status: 'planned', owner, dueDate: opts.due ?? D })).mitigationId);
  return { fx, p, f, ms };
}

describe('runReminders', () => {
  it('FR-FUP-03: two runs on the due date send one E-04; day 7 one E-05; day 8 none', async () => {
    await world();
    await runReminders(t('2026-11-02T04:00:00Z')); await runReminders(t('2026-11-02T05:00:00Z'));
    expect(sends('due')).toHaveLength(1);
    await runReminders(t('2026-11-09T04:00:00Z')); expect(sends('overdue')).toHaveLength(1);
    await runReminders(t('2026-11-10T04:00:00Z')); expect(sends('overdue')).toHaveLength(1);
  });

  it('FR-FUP-03: three mitigations of one owner due today give one E-04 with no number and three sent rows', async () => {
    const { fx } = await world(['assessor', 'assessor', 'assessor']);
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends('due')).toHaveLength(1);
    // The link and the organisation name are fixture values that carry a run number; the email's own text holds no count.
    expect(sends('due')[0].text.replace('2 Nov 2026', '').replace(/https?:\/\/\S+\/dashboard/, '').replace(fx.org.name, '').match(/\d/)).toBeNull();
    expect(await logRows({ kind: 'due', outcome: 'sent' })).toHaveLength(3);
  });

  it('FR-FUP-03: a mitigation whose finding was closed by an accepted risk gets no reminder', async () => {
    const { fx, f } = await world();
    await addAcceptedRisk(fx, f.id, {});
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends()).toHaveLength(0);
  });

  it('FR-FUP-03: before 06:00 East Africa Time no E-04 is sent', async () => {
    await world();
    await runReminders(t('2026-11-02T02:59:00Z'));
    expect(sends('due')).toHaveLength(0);
  });

  it('NFR-REL-08: two runs started together send exactly one E-04', async () => {
    await world();
    await Promise.all([runReminders(t('2026-11-02T04:00:00Z')), runReminders(t('2026-11-02T04:00:00Z'))]);
    expect(sends('due')).toHaveLength(1);
  });

  it('NFR-REL-08: after 30 hours without a run, the next run sends the reminder that came due, once', async () => {
    await world();
    await runReminders(t('2026-11-01T22:00:00Z'));                         // 01:00 EAT on the due date: too early
    await runReminders(t('2026-11-03T04:00:00Z'));                         // 30 hours later
    await runReminders(t('2026-11-03T05:00:00Z'));
    expect(sends('due')).toHaveLength(1);
  });

  it('FR-FUP-04 NFR-REL-06: a failed send is recorded and retried at the next run', async () => {
    await world();
    send.mockRejectedValueOnce(new Error('Email send failed (x): y'));
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(await logRows({ outcome: 'failed' })).toHaveLength(1);
    expect(await logRows({ outcome: 'sent' })).toHaveLength(0);
    expect((await logRows({ outcome: 'failed' }))[0].failureCode).toBe('transport_error');
    await runReminders(t('2026-11-02T05:00:00Z'));
    expect(await logRows({ outcome: 'sent' })).toHaveLength(1);
    // a claim and its outcome share an attempt number (gap G091, owner question B24)
    expect((await logRows({})).map((r) => [r.attempt, r.outcome]).sort()).toEqual([[1, 'claimed'], [1, 'failed'], [2, 'claimed'], [2, 'sent']]);
  });

  it('FR-FUP-04: an unset sender address is recorded as not_configured and nothing is sent', async () => {
    await world();
    delete process.env.EMAIL_FROM_ADDRESS;
    const res = await runReminders(t('2026-11-02T04:00:00Z'));
    expect(send).not.toHaveBeenCalled();
    expect((await logRows({ outcome: 'failed' })).map((r) => r.failureCode)).toEqual(['not_configured']);
    expect(res).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
  });

  it('FR-FUP-04: after one send and three retries fail, no fifth attempt is made', async () => {
    await world();
    send.mockRejectedValue(new Error('down'));
    for (const h of ['04', '05', '06', '07', '08']) await runReminders(t(`2026-11-02T${h}:00:00Z`));
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('FR-FUP-04: a failure for one owner does not stop the next owner\'s email', async () => {
    await world(['assessor', 'admin']);
    send.mockRejectedValueOnce(new Error('down'));
    const res = await runReminders(t('2026-11-02T04:00:00Z'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(await logRows({ outcome: 'sent' })).toHaveLength(1);
    expect(await logRows({ outcome: 'failed' })).toHaveLength(1);
    expect(res).toMatchObject({ attempted: 2, sent: 1, failed: 1 });
  });

  it('NFR-REL-06: the follow-up lists are unchanged when email fails', async () => {
    const { fx, p } = await world();
    const before = await openMitigationsByStage(ctxFor(fx, 'viewer'), p.id, D);
    send.mockRejectedValue(new Error('down'));
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(await openMitigationsByStage(ctxFor(fx, 'viewer'), p.id, D)).toEqual(before);
  });

  it('FR-FUP-05: a removed owner and an owner changed to viewer get no email', async () => {
    const { fx } = await world(['assessor', 'admin', 'owner']);
    await removeMember(fx, 'admin');
    await testDb.membership.updateMany({ where: { orgId: fx.org.id, userId: fx.members.assessor.userId }, data: { role: 'viewer' } });
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends().map((m) => m.to)).toEqual([fx.members.owner.email]);
  });

  it('FR-FUP-05: a deactivated owner gets no email', async () => {
    const { fx } = await world();
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { isActive: false } });
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends()).toHaveLength(0);
  });

  it('FR-FUP-05 FR-PRJ-03: a mitigation in an archived project gets no reminder', async () => {
    const fx = await buildOrg({ label: 'ra' });
    const p = await addProject(fx, { archived: true });
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: D });
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends()).toHaveLength(0);
  });

  it('FR-FUP-06: with the setting off, no email and one opted-out row', async () => {
    const { fx } = await world();
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { reminderEmails: false } });
    await runReminders(t('2026-11-02T04:00:00Z')); await runReminders(t('2026-11-02T05:00:00Z'));
    expect(sends()).toHaveLength(0);
    expect(await logRows({ outcome: 'opted_out' })).toHaveLength(1);
  });

  it('FR-FUP-03: a person gets one E-04 per organisation and day, even when a second mitigation becomes eligible later that day', async () => {
    // The database stamps a log row with its own clock (a trigger overrides `at`), and the rule
    // compares a sent row's day with `now`, so this case runs on the real clock: the first
    // mitigation was due yesterday (eligible the whole day after), the second is due today.
    const now = new Date();
    const today = eatDate(now);
    const yesterday = eatDate(new Date(now.getTime() - 24 * 3600 * 1000));
    const { fx, f } = await world(['assessor'], { due: yesterday });
    await runReminders(now);
    expect(sends('due')).toHaveLength(1);
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: today });
    await runReminders(now);
    expect(sends('due')).toHaveLength(1);                                                           // same day: it waits
    await runReminders(new Date(now.getTime() + 24 * 3600 * 1000));                                 // the next day: the second mitigation's day after
    expect(sends('due')).toHaveLength(2);
  });

  it('FR-FUP-03 NFR-SEC-09: each email names its own organisation and links its own dashboard', async () => {
    const a = await world();
    const b = await world(['admin']);
    await runReminders(t('2026-11-02T04:00:00Z'));
    const bySlug = new Map([[a.fx.members.assessor.email, a.fx], [b.fx.members.admin.email, b.fx]]);
    expect(sends()).toHaveLength(2);
    for (const m of sends()) {
      const fx = bySlug.get(m.to)!;
      expect(m.subject.endsWith(fx.org.name)).toBe(true);
      expect(m.text).toContain(`/orgs/${fx.org.slug}/dashboard`);
    }
  });

  it('NFR-PRIV-02: a run over the marker fixture sends no marker', async () => {
    await world(['assessor'], { text: { text: markerText } });
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(sends()).toHaveLength(1);
    for (const m of sends()) expect((m.subject + m.text + m.html).match(MARKER_PATTERN)).toBeNull();
  });

  it('NFR-OBS-01: a run logs one REMINDER_RUN line with counts and no email', async () => {
    await world();
    const { lines } = await captureLogs(() => runReminders(t('2026-11-02T04:00:00Z')));
    const runLines = lines.filter((l) => l.includes('"REMINDER_RUN"'));
    expect(runLines).toHaveLength(1);
    expect(Object.keys(JSON.parse(runLines[0]).details).sort()).toEqual(['attempted', 'failed', 'optedOut', 'sent']);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-REL-08: a run that finds the lock held sends nothing and says so', async () => {
    await world();
    let release!: () => void;
    const held = withReminderRunLock(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 300));
    try {
      expect(await runReminders(t('2026-11-02T04:00:00Z'))).toEqual({ attempted: 0, sent: 0, failed: 0, optedOut: 0, skippedLocked: true });
      expect(send).not.toHaveBeenCalled();
    } finally { release(); await held; }
  });
});
