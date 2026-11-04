import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { MARKER_PATTERN, markerText } from '../helpers/markers';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { withReminderRunLock } from '../../lib/data/identityReads';
import { openMitigationsByStage } from '../../lib/data/followup';

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
// A seam on the lane, so a case can make one log insert fail; unset, the real lane is used.
const seam = vi.hoisted(() => ({ wrap: null as null | ((lane: ReminderLane) => ReminderLane), failOrganisationList: false }));
vi.mock('@/lib/data/identityReads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data/identityReads')>();
  return {
    ...actual,
    listOrganisationsForReminders: async () => {
      if (seam.failOrganisationList) throw new Error('database down');
      return actual.listOrganisationsForReminders();
    },
  };
});
vi.mock('@/lib/data/tenant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data/tenant')>();
  return {
    ...actual,
    systemContext: ((orgId: string, purpose: 'reminders', cb: (lane: ReminderLane) => Promise<unknown>) =>
      actual.systemContext(orgId, purpose, (lane) => cb(seam.wrap ? seam.wrap(lane) : lane))) as typeof actual.systemContext,
  };
});
import type { ReminderLane } from '@/lib/data/tenant';
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

const savedEnv = { from: process.env.EMAIL_FROM_ADDRESS, key: process.env.RESEND_API_KEY };
beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  seam.wrap = null;
  seam.failOrganisationList = false;
  send.mockResolvedValue({ id: 'test-message' });
  process.env.EMAIL_FROM_ADDRESS = 'reminders@fixture.test';
  process.env.RESEND_API_KEY = 'placeholder-not-a-key';   // only its presence is checked: sendEmail is mocked
});
afterAll(async () => {
  await resetDb();
  for (const [name, v] of [['EMAIL_FROM_ADDRESS', savedEnv.from], ['RESEND_API_KEY', savedEnv.key]] as const) {
    if (v === undefined) delete process.env[name]; else process.env[name] = v;
  }
});

/** The REMINDER_RUN line of a run: its level and details. */
async function runLogged(now: Date, opts?: Parameters<typeof runReminders>[1]) {
  let thrown: unknown;
  const { lines } = await captureLogs(async () => { try { await runReminders(now, opts); } catch (e) { thrown = e; } });
  const runLines = lines.filter((l) => l.includes('"REMINDER_RUN"'));
  expect(runLines).toHaveLength(1);
  const line = JSON.parse(runLines[0]) as { level: string; details: Record<string, unknown> };
  return { level: line.level, details: line.details, thrown, lines };
}

/**
 * Writes log rows with the time the case gives them: the database stamps every row with its own clock in a
 * trigger, so a controlled-clock case switches that trigger off for the insert and restores it, as
 * decisions-versions.test.ts does for decision_versions.
 */
async function insertLogRows(rows: Array<{ orgId: string; mitigationId: string; dueDate: string; kind: 'due' | 'overdue'; attempt: number; outcome: string; at: string }>): Promise<void> {
  const triggers = await testDb.$queryRaw<{ tgname: string; tgenabled: string }[]>`
    SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgrelid = 'reminder_log'::regclass AND tgname = 'reminder_log_db_time'`;
  expect(triggers).toHaveLength(1);
  const [{ tgname, tgenabled }] = triggers;
  const restore = { A: 'ENABLE ALWAYS', R: 'ENABLE REPLICA', O: 'ENABLE', D: 'DISABLE' }[tgenabled];
  if (restore === undefined) throw new Error(`unknown tgenabled ${tgenabled}`);
  await testDb.$executeRawUnsafe(`ALTER TABLE reminder_log DISABLE TRIGGER "${tgname}"`);
  try {
    for (const r of rows) {
      await testDb.reminderLog.create({ data: { ...r, dueDate: new Date(`${r.dueDate}T00:00:00Z`), at: new Date(r.at) } });
    }
  } finally {
    await testDb.$executeRawUnsafe(`ALTER TABLE reminder_log ${restore} TRIGGER "${tgname}"`);
  }
  const [after] = await testDb.$queryRaw<{ tgenabled: string }[]>`SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgrelid = 'reminder_log'::regclass AND tgname = ${tgname}`;
  expect(after.tgenabled).toBe(tgenabled);
}

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

  it('FR-FUP-04: an unset sender or mailer key claims nothing, spends no attempt, logs the reason at error level and throws', async () => {
    await world();
    for (const [name, reason] of [['EMAIL_FROM_ADDRESS', 'sender_unset'], ['RESEND_API_KEY', 'api_key_unset']] as const) {
      const saved = process.env[name];
      delete process.env[name];
      const run = await runLogged(t('2026-11-02T04:00:00Z'));
      process.env[name] = saved;
      expect(run.thrown).toBeInstanceOf(Error);
      expect(run.level).toBe('error');
      expect(run.details).toMatchObject({ reason, attempted: 0 });
      expect(await logRows({})).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    }
    await runReminders(t('2026-11-02T05:00:00Z'));                                                 // configured again: attempt 1 is still free
    expect((await logRows({})).map((r) => [r.attempt, r.outcome]).sort()).toEqual([[1, 'claimed'], [1, 'sent']]);
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
    const { fx, f, ms } = await world();
    // m1's E-04 was sent at 06:30 EAT on the due date; the rows carry that time (the database would stamp now).
    await insertLogRows(['claimed', 'sent'].map((outcome) => ({ orgId: fx.org.id, mitigationId: ms[0], dueDate: D, kind: 'due' as const, attempt: 1, outcome, at: '2026-11-02T03:30:00Z' })));
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: D });   // becomes eligible after that send
    await runReminders(t('2026-11-02T09:00:00Z'));
    expect(sends('due')).toHaveLength(0);                                                          // the cap holds it
    await runReminders(t('2026-11-03T04:00:00Z'));                                                 // the next day
    expect(sends('due')).toHaveLength(1);
  });

  it('FR-FUP-03: a key held back by the daily cap on its last eligible day is sent the day after', async () => {
    const { fx, f, ms } = await world(['assessor'], { due: '2026-11-01' });
    // The E-04 went out on 2 Nov (the due date + 1); a second mitigation due 1 Nov is created that evening.
    await insertLogRows(['claimed', 'sent'].map((outcome) => ({ orgId: fx.org.id, mitigationId: ms[0], dueDate: '2026-11-01', kind: 'due' as const, attempt: 1, outcome, at: '2026-11-02T04:00:00Z' })));
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    await runReminders(t('2026-11-02T09:00:00Z'));
    expect(sends('due')).toHaveLength(0);                                                          // last eligible day, capped
    await runReminders(t('2026-11-03T04:00:00Z'));                                                 // one extra day, for that reason only
    expect(sends('due')).toHaveLength(1);
    await runReminders(t('2026-11-04T04:00:00Z'));
    expect(sends('due')).toHaveLength(1);                                                          // and no further
  });

  it('FR-FUP-03: a key that was not held back by the cap gets no extra day', async () => {
    await world(['assessor'], { due: '2026-11-01' });
    await runReminders(t('2026-11-03T04:00:00Z'));                                                 // due date + 2, nothing was sent before
    expect(sends('due')).toHaveLength(0);
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
    expect(Object.keys(JSON.parse(runLines[0]).details).sort()).toEqual(['attempted', 'deferred', 'failed', 'optedOut', 'reason', 'sent']);
    expect(JSON.parse(runLines[0]).level).toBe('info');
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('FR-FUP-04 NFR-OBS-01: a step that fails to record is logged at error level with its count, and the run throws', async () => {
    const { fx } = await world();
    seam.wrap = (lane) => ({ ...lane, insertReminderLog: async (row) => {
      if (row.outcome === 'claimed') throw new Error('database down');
      return lane.insertReminderLog(row);
    } });
    const run = await runLogged(t('2026-11-02T04:00:00Z'));
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.level).toBe('error');
    expect(run.details).toMatchObject({ failed: 1, sent: 0, reason: 'none' });
    expect(send).not.toHaveBeenCalled();
    expect(scanLines(run.lines, { markers: true, emails: true })).toEqual([]);
    expect(await logRows({})).toHaveLength(0);
    expect(fx.org.id).toBeTruthy();
  });

  it('FR-FUP-04: one organisation failing does not stop the next organisation\'s email', async () => {
    const a = await world(['assessor']);
    const b = await world(['admin']);
    let failedOrg: string | null = null;
    seam.wrap = (lane) => ({ ...lane, followUpRows: async () => {
      if (failedOrg === null) { failedOrg = lane.orgId; throw new Error('database down'); }
      return lane.followUpRows();
    } });
    const run = await runLogged(t('2026-11-02T04:00:00Z'));
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.details).toMatchObject({ failed: 1, sent: 1 });
    expect(sends('due')).toHaveLength(1);
    expect([a.fx.org.id, b.fx.org.id]).toContain(failedOrg);
  });

  it('FR-FUP-04: a claimed key is recorded in the log before its email is sent', async () => {
    const { fx } = await world();
    let claimedAtSend = -1;
    const sender = vi.fn(async () => {
      claimedAtSend = await testDb.reminderLog.count({ where: { orgId: fx.org.id, outcome: 'claimed' } });
      return { id: 'x' };
    });
    await runReminders(t('2026-11-02T04:00:00Z'), { send: sender });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(claimedAtSend).toBe(1);
  });

  it('NFR-REL-08: a key whose first attempt is already claimed is claimed again as attempt 2', async () => {
    const { fx, ms } = await world();
    await insertLogRows([{ orgId: fx.org.id, mitigationId: ms[0], dueDate: D, kind: 'due', attempt: 1, outcome: 'claimed', at: '2026-11-02T03:30:00Z' }]);
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect((await logRows({})).map((r) => [r.attempt, r.outcome]).sort()).toEqual([[1, 'claimed'], [2, 'claimed'], [2, 'sent']]);
  });

  it('FR-FUP-04: a failed outcome insert is retried once; if it fails again every other key is still recorded and the run throws', async () => {
    const { fx } = await world(['assessor', 'assessor', 'assessor']);
    // Retried once: the first 'sent' insert fails, the retry works.
    let flaked = false;
    seam.wrap = (lane) => ({ ...lane, insertReminderLog: async (row) => {
      if (row.outcome === 'sent' && !flaked) { flaked = true; throw new Error('blip'); }
      return lane.insertReminderLog(row);
    } });
    await runReminders(t('2026-11-02T04:00:00Z'));
    expect(await logRows({ outcome: 'sent' })).toHaveLength(3);
    // Failing for good on one key: the other two still get their outcome rows.
    await resetDb();
    await world(['assessor', 'assessor', 'assessor']);
    let firstKey: string | null = null;
    seam.wrap = (lane) => ({ ...lane, insertReminderLog: async (row) => {
      if (row.outcome === 'sent') { firstKey ??= row.mitigationId; if (row.mitigationId === firstKey) throw new Error('down'); }
      return lane.insertReminderLog(row);
    } });
    const run = await runLogged(t('2026-11-03T04:00:00Z'));
    expect(run.thrown).toBeInstanceOf(Error);
    expect(await logRows({ outcome: 'sent' })).toHaveLength(2);
    expect(fx.org.id).toBeTruthy();
  });

  it('FR-FUP-03 (pinned edge, DEFERRAL): a key first seen on its last extra day is sent when the person was sent that kind the day before', async () => {
    // The log cannot say a key was capped yesterday; the job asks only whether the person got that kind yesterday.
    // So a mitigation recorded on due + 2 for an owner who got an E-04 on due + 1 is sent. This pins that edge.
    const { fx, f, ms } = await world(['assessor'], { due: '2026-11-01' });
    await insertLogRows(['claimed', 'sent'].map((outcome) => ({ orgId: fx.org.id, mitigationId: ms[0], dueDate: '2026-11-01', kind: 'due' as const, attempt: 1, outcome, at: '2026-11-02T04:00:00Z' })));
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });   // first seen on 3 Nov
    await runReminders(t('2026-11-03T04:00:00Z'));
    expect(sends('due')).toHaveLength(1);
  });

  it('FR-FUP-04: a retried outcome insert that answers duplicate is the first try having landed, not a failure', async () => {
    await world(['assessor', 'assessor']);
    let first = true;
    seam.wrap = (lane) => ({ ...lane, insertReminderLog: async (row) => {
      if (row.outcome === 'sent' && first) { first = false; await lane.insertReminderLog(row); throw new Error('reply lost'); }
      return lane.insertReminderLog(row);
    } });
    const run = await runLogged(t('2026-11-02T04:00:00Z'));
    expect(run.thrown).toBeUndefined();
    expect(run.level).toBe('info');
    expect(await logRows({ outcome: 'sent' })).toHaveLength(2);
  });

  it('NFR-REL-08: past the deadline an organisation is not read at all and is counted as deferred', async () => {
    await world(['assessor']);
    const lanes: string[] = [];
    seam.wrap = (lane) => ({ ...lane, followUpRows: async () => { lanes.push(lane.orgId); return lane.followUpRows(); } });
    const run = await runLogged(t('2026-11-02T04:00:00Z'), { send: vi.fn(), deadlineMs: 0 });
    expect(lanes).toEqual([]);
    expect(run.details).toMatchObject({ deferred: 1, sent: 0 });
    expect(await logRows({})).toHaveLength(0);
  });

  it('NFR-OBS-01: when the lock transaction itself fails the run still logs REMINDER_RUN at error level, then throws', async () => {
    await world();
    seam.failOrganisationList = true;
    const run = await runLogged(t('2026-11-02T04:00:00Z'));
    expect(run.thrown).toBeInstanceOf(Error);
    expect(run.level).toBe('error');
    expect(run.details).toMatchObject({ failed: 1, sent: 0 });
    expect(JSON.stringify(run.lines)).not.toContain('database down');
  });

  it('NFR-REL-08: past the run deadline no new group is started, the rest is deferred and the next run sends it', async () => {
    await world(['assessor', 'admin']);
    let now = 1_000_000;
    const sender = vi.fn(async () => { now += 11 * 60 * 1000; return { id: 'x' }; });   // the first send "takes" 11 minutes
    const run = await runLogged(t('2026-11-02T04:00:00Z'), { send: sender, clock: () => now, deadlineMs: 10 * 60 * 1000 });
    expect(run.level).toBe('info');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(run.details).toMatchObject({ sent: 1, deferred: 1 });
    await runReminders(t('2026-11-02T05:00:00Z'), { send: sender });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('NFR-REL-06: a send that does not answer within the send timeout is recorded as transport_error and the next group goes on', async () => {
    await world(['assessor', 'admin']);
    const sender = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))                      // never answers
      .mockResolvedValueOnce({ id: 'x' });
    const res = await runReminders(t('2026-11-02T04:00:00Z'), { send: sender, sendTimeoutMs: 30 });
    expect(res).toMatchObject({ attempted: 2, sent: 1, failed: 1 });
    expect((await logRows({ outcome: 'failed' })).map((r) => r.failureCode)).toEqual(['transport_error']);
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
