import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { DecisionVersionView, SaveDecisionRequest } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import { GONE_NAME_COPY } from '@/lib/http/copy';
import { decisionHistory, saveDecision } from '@/lib/data/decisions';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addEvidence, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * NFR-PERF-04 (SRS line 3207), FIX-14: a save answers within 300 ms at the 95th percentile with ten users. A save's
 * cost is the Node thread's work per statement (Prisma's query and result processing, the `pg` protocol), not slow
 * SQL (run/fix14: no statement over 20 ms; the CPU profile of a ten-user save-only burst). These tests hold the save
 * to two things.
 *
 *  - Same answer. The view a save returns equals the view of the same version read back afterwards through
 *    `decisionHistory` (the full read path: names, the former-member mark, evidence, the erased marks, the content
 *    version), for a member decider, a former-member decider, an outside-role decider, attached evidence and a
 *    shortfall that raises a finding.
 *  - Fewer statements. Every statement the save sends to Postgres is counted at the `pg` client, so a relation load
 *    Prisma adds, BEGIN and COMMIT count too. The save does not read back the version it has just inserted (the
 *    insert returns it), does not read erasure marks for it (no tombstone can name a row created in this
 *    transaction), reads the content version once (the save already resolved the one it stores) and the member
 *    history once (the decider check and the names share it), and reads the current version's evidence only when the
 *    save repeats every other field of it (FR-DEC-01's unchanged check is the only reader).
 */

/** Every statement sent through any `pg` client while `on`, with its text. */
const sent = { on: false, statements: [] as string[] };
const realQuery = pg.Client.prototype.query;

beforeEach(() => {
  sent.on = false;
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    if (sent.on) {
      const first = args[0] as string | { text?: string };
      sent.statements.push(typeof first === 'string' ? first : String(first?.text ?? ''));
    }
    return (realQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pg.Client.prototype.query);
});
afterEach(() => {
  sent.on = false;
  vi.restoreAllMocks();
});

async function statementsOf<T>(f: () => Promise<T>): Promise<{ value: T; statements: string[] }> {
  sent.statements = [];
  sent.on = true;
  try {
    return { value: await f(), statements: sent.statements };
  } finally {
    sent.on = false;
  }
}

/** `<verb> <table>` of a statement: what it does to which table, its parameters left out. */
function shape(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  const table = (re: RegExp) => (re.exec(s)?.[1] ?? '?').replace(/"public"\./, '').replace(/"/g, '');
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return s.split(' ')[0].toUpperCase();
  if (/^INSERT/i.test(s)) return `INSERT ${table(/^INSERT INTO ((?:"public"\.)?"[^"]+")/i)}`;
  if (/^SELECT set_config/i.test(s)) return 'SET org';
  if (/^SELECT clock_timestamp/i.test(s)) return 'SELECT clock';
  if (/^SELECT/i.test(s)) return `SELECT ${table(/ FROM ((?:"public"\.)?"[^"]+")/i)}`;
  return s.slice(0, 40);
}

let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const body = (over: Partial<SaveDecisionRequest> = {}): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Fixture reason', decidedBy: { kind: 'member', userId: fx.members.owner.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...over,
});
const save = (role: OrgRole, b: SaveDecisionRequest) => saveDecision(ctxFor(fx, role), { userId: fx.members[role].userId, role },
  { ...b, projectId: project.id }, requestDigest({ path: { id: project.id }, body: b }));
const readBack = async (v: DecisionVersionView) =>
  (await decisionHistory(ctxFor(fx, 'viewer'), project.id, v.questionId)).find((x) => x.id === v.id);

/** Deletes the member's membership and records its removal, as MEM's removal does (decisions-versions.test.ts). */
async function removeMember(role: OrgRole): Promise<string> {
  const userId = fx.members[role].userId;
  await testDb.membership.deleteMany({ where: { orgId: fx.org.id, userId } });
  await testDb.$executeRaw`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action, "targetUserId")
    VALUES (gen_random_uuid()::text, ${fx.org.id}, ${fx.members.owner.userId}, 'owner', 'member_removed', ${userId})`;
  return userId;
}

describe('NFR-PERF-04 FIX-14: a save answers the view a read gives', () => {
  it('NFR-PERF-04 FIX-14 FR-DEC-01: a member decider, entered by another member', async () => {
    const out = await save('assessor', body());
    expect(out.replayed).toBe(false);
    expect(out.value).toEqual(await readBack(out.value));
    expect(out.value.decidedBy).toEqual({ kind: 'member', user: { userId: fx.members.owner.userId, name: expect.any(String), formerMember: false } });
    expect(out.value.enteredBy.userId).toBe(fx.members.assessor.userId);
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01: a former-member decider keeps the former-member mark', async () => {
    const former = await removeMember('reviewer');
    const out = await save('owner', body({ decidedBy: { kind: 'member', userId: former } }));
    expect(out.value).toEqual(await readBack(out.value));
    expect(out.value.decidedBy).toMatchObject({ kind: 'member', user: { userId: former, formerMember: true } });
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01: the entering account is the decider', async () => {
    const out = await save('owner', body());
    expect(out.value).toEqual(await readBack(out.value));
    expect(out.value.enteredBy).toEqual((out.value.decidedBy as { user: unknown }).user);
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01 FR-EXP-03: a scrubbed former member as decider keeps the scrubbed name and the former-member mark', async () => {
    const former = await removeMember('reviewer');
    await testDb.user.update({ where: { id: former }, data: { name: GONE_NAME_COPY.deletedAccount, isActive: false } });
    const out = await save('owner', body({ decidedBy: { kind: 'member', userId: former } }));
    expect(out.value).toEqual(await readBack(out.value));
    expect(out.value.decidedBy).toEqual({ kind: 'member', user: { userId: former, name: GONE_NAME_COPY.deletedAccount, formerMember: true } });
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01: an outside-role decider', async () => {
    const out = await save('owner', body({ decidedBy: { kind: 'outside_role', role: 'ethics_committee' } }));
    expect(out.value).toEqual(await readBack(out.value));
    expect(out.value.decidedBy).toEqual({ kind: 'outside_role', role: 'ethics_committee' });
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01: attached evidence, on a second version', async () => {
    const file = await addEvidence(fx, project.id, { kind: 'file' });
    const link = await addEvidence(fx, project.id, { kind: 'link', url: 'https://example.test/policy' });
    const v1 = await save('owner', body());
    const v2 = await save('owner', body({ baseVersionNumber: v1.value.versionNumber, reason: 'With evidence', evidenceIds: [link.id, file.id] }));
    expect(v2.value.versionNumber).toBe(2);
    expect(v2.value.evidence.map((e) => e.id).sort()).toEqual([file.id, link.id].sort());
    expect(v2.value).toEqual(await readBack(v2.value));
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-05: a save on a base that moved answers 409 with the current version as a read gives it, evidence included', async () => {
    const file = await addEvidence(fx, project.id, { kind: 'file' });
    const v1 = await save('owner', body({ evidenceIds: [file.id] }));
    const v2 = await save('owner', body({ baseVersionNumber: 1, reason: 'Second' }));
    const e = await save('owner', body({ baseVersionNumber: 1, reason: 'Third' })).catch((x: unknown) => x) as { status?: number; code?: string; extra?: { current?: unknown } };
    expect(e.status).toBe(409);
    expect(e.code).toBe('base_version_moved');
    expect(e.extra?.current).toEqual(await readBack(v2.value));
    expect(v1.value.evidence.map((x) => x.id)).toEqual([file.id]);
  });

  it('NFR-PERF-04 FIX-14 FR-DEC-01: a save that repeats the current version, its evidence included, is still refused; one that differs only in evidence is saved', async () => {
    const file = await addEvidence(fx, project.id, { kind: 'file' });
    await save('owner', body({ evidenceIds: [file.id] }));
    const same = await save('owner', body({ baseVersionNumber: 1, evidenceIds: [file.id] })).catch((x: unknown) => x) as { status?: number };
    expect(same.status).toBe(422);
    const other = await save('owner', body({ baseVersionNumber: 1, evidenceIds: [] }));
    expect(other.value.versionNumber).toBe(2);
    expect(other.value).toEqual(await readBack(other.value));
  });

  it('NFR-PERF-04 FIX-14 FR-FND-01: a shortfall that raises a finding', async () => {
    const out = await save('owner', body({ status: 'not_yet', reasonCode: 'ny_planned_later' }));
    expect(out.value).toEqual(await readBack(out.value));
    expect(await testDb.finding.count({ where: { decisionVersionId: out.value.id } })).toBe(1);
  });
});

describe('NFR-PERF-04 FIX-14: the statements of a save', () => {
  it('NFR-PERF-04 FIX-14: a save with a member decider sends 13 statements, and none reads back the version it inserted', async () => {
    const { value: out, statements } = await statementsOf(() => save('assessor', body()));
    expect(out.replayed).toBe(false);
    const shapes = statements.map(shape);
    expect(shapes).toEqual([
      'BEGIN', 'SET org',
      'SELECT decision_versions',           // the request id seen before (idempotentWrite)
      'SELECT projects',                    // writable, FOR SHARE
      'SELECT framework_versions',          // the running content version
      'SELECT clock',                       // today, from the database clock
      'SELECT memberships', 'SELECT organisation_events',   // the decider's and the enterer's member history, once
      'SELECT decision_versions',           // the current version's columns (its evidence only if every other field repeats)
      'INSERT decision_versions',
      'SELECT users',                       // the names (identity lane)
      'SELECT decision_versions',           // the request's stamp on its row (idempotentWrite)
      'COMMIT',
    ]);
  });

  it('NFR-PERF-04 FIX-14: no save reads erasure marks or a second content version for the version it inserted', async () => {
    const file = await addEvidence(fx, project.id, { kind: 'file' });
    const v1 = await save('owner', body());
    const { statements } = await statementsOf(() => save('owner', body({ baseVersionNumber: v1.value.versionNumber, reason: 'Again', evidenceIds: [file.id] })));
    const shapes = statements.map(shape);
    expect(shapes.filter((s) => s === 'SELECT framework_versions')).toHaveLength(1);
    expect(shapes.filter((s) => s === 'SELECT memberships')).toHaveLength(2);   // the decider's history, then the uploader's name
    // The evidence's own erased mark is still read (evidenceViews); none for the new version's fields.
    expect(statements.filter((s) => /"targetTable" = \$\d+ AND "field" IS NOT NULL/.test(s.replace(/\s+/g, ' ')))).toEqual([]);
    expect(shapes.filter((s) => s === 'SELECT decision_versions')).toHaveLength(3);
  });

  it('NFR-PERF-04 FIX-14: a save whose fields differ from the current version does not read that version\'s evidence', async () => {
    const v1 = await save('owner', body());
    const { statements } = await statementsOf(() => save('owner', body({ baseVersionNumber: v1.value.versionNumber, reason: 'Changed' })));
    expect(statements.map(shape).filter((s) => s === 'SELECT decision_evidence')).toEqual([]);
  });
});
