import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { OrgContext } from '../../lib/data/tenant';
import { systemContext, withOrg } from '../../lib/data/tenant';
import { listOrganisationsForReminders, withReminderRunLock } from '../../lib/data/identityReads';
import { resetDb } from '../helpers/db';

/**
 * SRS 6.6 and ADR-C5: the reminder run reads each organisation's follow-up rows through
 * `systemContext`, a lane that exposes exactly five members, each running its own short
 * transaction with the organisation set (no transaction escapes), importable only by
 * lib/reminders/job.ts; `reminder_log` is reached only through it. NFR-INT-10: `withOrg` can
 * run at REPEATABLE READ and takes a timeout. NFR-REL-08: one reminder run at a time.
 */

let su: Client;
const ids = {
  orgA: randomUUID(), orgB: randomUUID(), orgS: randomUUID(),
  assessorA: randomUUID(), removedA: randomUUID(), memberOfB: randomUUID(),
  project: randomUUID(), archivedProject: randomUUID(), finding: randomUUID(), mitigation: randomUUID(),
};
const ctxA = { orgId: ids.orgA, role: 'owner' } as OrgContext;
const FV = 'fv_k0a_sc';

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
  const q = (sql: string, p: unknown[] = []) => su.query(sql, p);
  for (const u of [ids.assessorA, ids.removedA, ids.memberOfB]) {
    await q(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [u, `sc-${u}@fixture.test`]);
  }
  await q(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, 'Org A', 'sc-a', now()), ($2, 'Org B', 'sc-b', now()), ($3, 'Org S', 'sc-s', now())`, [ids.orgA, ids.orgB, ids.orgS]);
  await q(`UPDATE organizations SET "deletedAt" = now() WHERE id = $1`, [ids.orgS]);
  await q(`INSERT INTO memberships (id, "orgId", "userId", role) VALUES (gen_random_uuid()::text, $1, $2, 'assessor'), (gen_random_uuid()::text, $3, $4, 'viewer')`,
    [ids.orgA, ids.assessorA, ids.orgB, ids.memberOfB]);
  await q(`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ($1, '0.0.0-k0a-sc', repeat('a', 64), now(), 'deprecated') ON CONFLICT (id) DO NOTHING`, [FV]);
  await q(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [ids.project, ids.orgA, ids.assessorA]);
  await q(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt", "archivedAt") VALUES ($1, $2, 'old', $3, now(), now())`, [ids.archivedProject, ids.orgA, ids.assessorA]);
  await q(`INSERT INTO findings (id, "orgId", "projectId", stage, source, "raisedById", "requestId", "requestDigest") VALUES ($1, $2, $3, 'in-processing', 'team', $4, gen_random_uuid(), 'd')`,
    [ids.finding, ids.orgA, ids.project, ids.assessorA]);
  const mv = (v: number, status: string, due: string) => q(`INSERT INTO mitigation_versions (id, "orgId", "findingId", "mitigationId", "versionNumber", "ownerUserId", "dueDate", status, kind, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, 'action', $5, 'assessor', gen_random_uuid(), 'd')`, [ids.orgA, ids.finding, ids.mitigation, v, ids.assessorA, due, status]);
  await mv(1, 'planned', '2026-11-10');
  await mv(2, 'in_progress', '2026-11-12');
  await q(`INSERT INTO finding_events (id, "orgId", "findingId", kind, "byId", "requestId", "requestDigest") VALUES (gen_random_uuid()::text, $1, $2, 'reopened', $3, gen_random_uuid(), 'd')`,
    [ids.orgA, ids.finding, ids.assessorA]);
});
afterAll(async () => {
  // framework_versions survives resetDb (reference data): remove this file's row, after the rows that reference it.
  await resetDb();
  await su.query(`DELETE FROM framework_versions WHERE id = $1`, [FV]);
  await su.end();
});

const CLAIM = { mitigationId: ids.mitigation, dueDate: '2026-11-12', kind: 'due' as const, attempt: 1, outcome: 'claimed' as const, failureCode: null };

describe('withOrg options, systemContext and the identity-lane reads', () => {
  it('NFR-INT-10: withOrg with RepeatableRead runs at repeatable read and still sets the org', async () => {
    const r = await withOrg(ctxA, async (tx) => tx.$queryRaw<{ l: string; g: string }[]>`SELECT current_setting('transaction_isolation') l, current_setting('app.current_org_id', true) g`, { isolationLevel: 'RepeatableRead' });
    expect(r[0]).toEqual({ l: 'repeatable read', g: ids.orgA });
    const d = await withOrg(ctxA, async (tx) => tx.$queryRaw<{ l: string }[]>`SELECT current_setting('transaction_isolation') l`);
    expect(d[0].l).toBe('read committed');
  });

  it('NFR-INT-10 (helper): withOrg passes timeoutMs to the transaction', async () => {
    await expect(withOrg(ctxA, () => new Promise((r) => setTimeout(r, 300)), { timeoutMs: 100 })).rejects.toThrow();
    await expect(withOrg(ctxA, () => new Promise((r) => setTimeout(r, 300)), { timeoutMs: 2000 })).resolves.toBeUndefined();
  });

  it('NFR-SEC-09 ADR-C5: the lane exposes exactly its five members and no transaction', async () => {
    await systemContext(ids.orgA, 'reminders', async (lane) => {
      expect(Object.keys(lane).sort()).toEqual(['followUpRows', 'insertReminderLog', 'memberRoles', 'orgId', 'reminderLogRows']);
      expect(lane.orgId).toBe(ids.orgA);
      const rows = await lane.followUpRows();
      expect(rows.currentMitigations.every((m) => m.findingId)).toBe(true);
      expect(rows).toEqual({
        findings: [{ id: ids.finding, projectId: ids.project, stage: 'in-processing', source: 'team' }],
        events: [{ findingId: ids.finding, kind: 'reopened', findingSeq: 3 }],
        acceptedRisks: [],
        currentMitigations: [expect.objectContaining({ mitigationId: ids.mitigation, findingId: ids.finding, ownerUserId: ids.assessorA,
          dueDate: '2026-11-12', status: 'in_progress', findingSeq: 2 })],
        archivedProjectIds: [ids.archivedProject],
      });
      expect(Object.isFrozen(lane)).toBe(true);
    });
    await expect(systemContext('  ', 'reminders', async () => 1)).rejects.toThrow(/orgId/);
  });

  it('NFR-SEC-09 (helper): the lane reads only its own organisation', async () => {
    await systemContext(ids.orgB, 'reminders', async (lane) => {
      expect(await lane.followUpRows()).toEqual({ findings: [], events: [], acceptedRisks: [], currentMitigations: [], archivedProjectIds: [] });
      expect(await lane.reminderLogRows([ids.mitigation])).toEqual([]);
    });
  });

  it('FR-FUP-05 (helper): memberRoles gives current roles and leaves out former members', async () => {
    await systemContext(ids.orgA, 'reminders', async (lane) => {
      expect(await lane.memberRoles([ids.assessorA, ids.removedA, ids.memberOfB])).toEqual(new Map([[ids.assessorA, 'assessor']]));
    });
  });

  it("FR-FUP-04 NFR-REL-08 (helper): insertReminderLog answers 'duplicate' on the claimed unique key, and reminderLogRows reads them back", async () => {
    await systemContext(ids.orgA, 'reminders', async (lane) => {
      expect(await lane.insertReminderLog(CLAIM)).toBe('inserted');
      expect(await lane.insertReminderLog(CLAIM)).toBe('duplicate');
      expect(await lane.insertReminderLog({ ...CLAIM, outcome: 'sent' })).toBe('inserted');
      const rows = await lane.reminderLogRows([ids.mitigation]);
      expect(rows.map((r) => ({ ...r, at: typeof r.at }))).toEqual([
        { mitigationId: ids.mitigation, dueDate: '2026-11-12', kind: 'due', attempt: 1, outcome: 'claimed', at: 'string' },
        { mitigationId: ids.mitigation, dueDate: '2026-11-12', kind: 'due', attempt: 1, outcome: 'sent', at: 'string' }]);
      expect(rows[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });
  });

  it('NFR-REL-08 FR-FUP-03 (helper): two concurrent runs, one gets the lock', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withReminderRunLock(async () => { await held; return 'ran'; });
    const sleepUntilLockHeld = async () => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await su.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND objid = 7106652 AND granted`);
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('the run lock was never taken');
    };
    await sleepUntilLockHeld();
    expect(await withReminderRunLock(async () => 'ran')).toBe('locked');
    release();
    expect(await first).toBe('ran');
    expect(await withReminderRunLock(async () => 'again')).toBe('again');   // released at commit
  });

  it('FR-FUP-03 (helper): listOrganisationsForReminders lists live organisations with name and slug', async () => {
    const orgs = await listOrganisationsForReminders();
    expect(orgs).toEqual([{ orgId: ids.orgA, name: 'Org A', slug: 'sc-a' }, { orgId: ids.orgB, name: 'Org B', slug: 'sc-b' }]
      .sort((x, y) => (x.orgId < y.orgId ? -1 : 1)));   // by id, as code units; archived org S left out
  });

  it('NFR-SEC-09 ADR-C5: only lib/reminders/job.ts may import systemContext', () => {
    const hits = execSync(`grep -rlE "\\bsystemContext\\b" app lib components --include=*.ts --include=*.tsx || true`).toString().trim().split('\n').filter(Boolean);
    expect(hits).toContain('lib/data/tenant.ts');   // the search finds the definition, so it is not vacuous
    expect(hits.filter((f) => !['lib/data/tenant.ts', 'lib/reminders/job.ts'].includes(f))).toEqual([]);
  });

  it('NFR-SEC-09 ADR-C5: reminder_log is named only in lib/data/tenant.ts (and in the APPEND_ONLY_TABLES registry)', () => {
    const hits = execSync(`grep -rlE "reminderLog\\b|reminder_log" app lib components --include=*.ts --include=*.tsx || true`).toString().trim().split('\n').filter(Boolean);
    // lib/data/appendOnly.ts names the table in the one registry 00-contract.md fixes; it reads no row.
    expect(hits.filter((f) => f !== 'lib/data/appendOnly.ts')).toEqual(['lib/data/tenant.ts']);
  });
});
