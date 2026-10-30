import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { OrgContext } from '../../lib/data/tenant';
import { NotFoundError, withOrg } from '../../lib/data/tenant';
import { assertProjectWritable } from '../../lib/data/projectGuard';
import { assertEvidenceAttachable } from '../../lib/data/evidenceGuard';
import { listOrganisationEvents, recordOrgEvent } from '../../lib/data/orgEvents';
import { erasedFields, evidenceViews, memberHistory, userRefs } from '../../lib/data/views';
import { adminCreateOrganisation } from '../../lib/data/definer';
import { resetDb, testDb } from '../helpers/db';

/**
 * The shared DB-reading helpers of 00-contract.md, Services, K0a: the archived-project guard
 * (FR-PRJ-03, gap G092), the evidence-attach guard (FR-EVD-04), the organisation-event insert
 * (FR-ORG-09), and the views every record unit composes (FR-DEC-01's former-member rule,
 * FR-EVD-05 and FR-REV-08's erased marks). Rows are written with testDb in this file's setup.
 */

const hex = (s: string) => createHash('sha256').update(s).digest('hex');
let orgId: string; let owner: string; let assessor: string; let removedViewer: string; let stranger: string; let platformAdmin: string;
let p1: string; let p2: string; let archived: string; let evOfP2: string; let liveEv: string; let erasedEv: string; let decision: string;
const ctx = (role: 'owner' | 'assessor' | 'viewer' = 'owner') => ({ orgId, role }) as OrgContext;

beforeAll(async () => {
  await resetDb();
  const user = async (name: string, role: 'admin' | 'assessor' = 'assessor') =>
    (await testDb.user.create({ data: { email: `h-${randomUUID()}@fixture.test`, name, passwordHash: 'x', role } })).id;
  [owner, assessor, removedViewer, stranger] = [await user('Owner'), await user('Assessor'), await user('Removed Viewer'), await user('Stranger')];
  platformAdmin = await user('Platform Admin', 'admin');
  // An organisation created by the administrator, so its organisation_created row names the administrator.
  orgId = (await adminCreateOrganisation({ actorUserId: platformAdmin, name: 'Helpers', slug: `helpers-${randomUUID().slice(0, 6)}`,
    agreement: { agreementVersion: '1', textHash: hex('a'), acceptedOn: '2026-10-30', controllerLegalName: 'C', dpContactEmail: 'dpo@fixture.test' },
    ownerEmail: 'first-owner@fixture.test', tokenHash: hex(randomUUID()), expiresAt: new Date(Date.now() + 86400000), linkShown: false })).orgId;
  for (const [u, role] of [[owner, 'owner'], [assessor, 'assessor']] as const) await testDb.membership.create({ data: { orgId, userId: u, role } });
  await testDb.$executeRaw`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action, "targetUserId") VALUES (gen_random_uuid()::text, ${orgId}, ${owner}, 'owner', 'member_removed', ${removedViewer})`;
  p1 = (await testDb.project.create({ data: { orgId, name: 'p1', createdById: owner } })).id;
  p2 = (await testDb.project.create({ data: { orgId, name: 'p2', createdById: owner } })).id;
  archived = (await testDb.project.create({ data: { orgId, name: 'old', createdById: owner, archivedAt: new Date() } })).id;
  const ev = async (projectId: string, by: string) => (await testDb.evidence.create({ data: { orgId, projectId, kind: 'file', filename: 'f.pdf',
    mimeType: 'application/pdf', byteSize: 3, sha256: hex(randomUUID()), uploadedById: by, requestId: randomUUID(), requestDigest: 'd' } })).id;
  evOfP2 = await ev(p2, assessor);
  liveEv = await ev(p1, removedViewer);
  erasedEv = await ev(p1, assessor);
  await testDb.$executeRaw`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", "erasureCode", "instructionReference", at) VALUES (gen_random_uuid()::text, ${orgId}, 'evidence', ${erasedEv}, 'ER', 'I', now())`;
  await testDb.$executeRaw`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ('fv_k0a_h', '0.0.0-k0a-h', ${hex('fv')}, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`;
  decision = (await testDb.decisionVersion.create({ data: { orgId, projectId: p1, stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: 'fv_k0a_h',
    versionNumber: 1, status: 'done', reason: null, enteredById: assessor, enteredByRole: 'assessor', requestId: randomUUID(), requestDigest: 'd' } })).id;
  await testDb.$executeRaw`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", field, digest, "erasureCode", "instructionReference") VALUES (gen_random_uuid()::text, ${orgId}, 'decision_versions', ${decision}, 'reason', ${hex('d')}, 'ER', 'I')`;
});
afterAll(async () => {
  // framework_versions survives resetDb (reference data): remove this file's row, after the rows that reference it.
  await resetDb();
  await testDb.$executeRaw`DELETE FROM framework_versions WHERE id = 'fv_k0a_h'`;
  await testDb.$disconnect();
});

const utcToday = () => new Date().toISOString().slice(0, 10);

describe('K0a DB-reading helpers', () => {
  it('FR-PRJ-03 (helper): assertProjectWritable throws project_archived for an archived project, and not_found for none', async () => {
    await expect(withOrg(ctx(), (tx) => assertProjectWritable(tx, archived))).rejects.toMatchObject({ status: 409, code: 'project_archived' });
    await expect(withOrg(ctx(), (tx) => assertProjectWritable(tx, p1))).resolves.toBeUndefined();
    await expect(withOrg(ctx(), (tx) => assertProjectWritable(tx, randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('FR-PRJ-03 (helper): assertProjectWritable locks the project row for share', async () => {
    const mode = await withOrg(ctx(), async (tx) => {
      await assertProjectWritable(tx, p1);
      return (await tx.$queryRaw<{ mode: string }[]>`SELECT mode FROM pg_locks WHERE locktype = 'relation' AND relation = 'projects'::regclass AND pid = pg_backend_pid()`).map((r) => r.mode);
    });
    expect(mode).toContain('RowShareLock');
  });

  it('FR-PRJ-03 (helper, C4 CR-5): while assertProjectWritable holds the row, archiving the project waits and times out', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let checked!: () => void;
    const isChecked = new Promise<void>((r) => (checked = r));
    const holder = withOrg(ctx(), async (tx) => { await assertProjectWritable(tx, p1); checked(); await held; });
    await isChecked;
    const other = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SET LOCAL lock_timeout = '200ms'`);
      await expect(other.query(`UPDATE projects SET "archivedAt" = now() WHERE id = $1`, [p1])).rejects.toThrow(/lock timeout/);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
      release();
      await holder;
    }
    expect((await testDb.project.findUniqueOrThrow({ where: { id: p1 } })).archivedAt).toBeNull();
  });

  it('FR-EVD-04 (helper): assertEvidenceAttachable refuses an id of another project', async () => {
    await expect(withOrg(ctx('assessor'), (tx) => assertEvidenceAttachable(tx, p1, [evOfP2]))).rejects.toMatchObject({ status: 422, code: 'validation',
      extra: { fields: [expect.objectContaining({ field: 'evidenceIds' })] } });
    await expect(withOrg(ctx('assessor'), (tx) => assertEvidenceAttachable(tx, p1, [randomUUID()]))).rejects.toMatchObject({ code: 'validation' });
    await expect(withOrg(ctx('assessor'), (tx) => assertEvidenceAttachable(tx, p1, [liveEv, erasedEv, liveEv]))).resolves.toBeUndefined();
    await expect(withOrg(ctx('assessor'), (tx) => assertEvidenceAttachable(tx, p1, []))).resolves.toBeUndefined();
  });

  it('FR-ORG-09 (helper): recordOrgEvent writes one row in the context organisation, and a member action needs its target', async () => {
    const count = () => testDb.organisationEvent.count({ where: { orgId, action: 'member_role_changed' } });
    const before = await count();
    await withOrg(ctx(), (tx) => recordOrgEvent(tx, { actorId: owner, actorRole: 'owner', action: 'member_role_changed', targetUserId: assessor, reason: 'moved' }));
    expect(await count()).toBe(before + 1);
    await expect(withOrg(ctx(), (tx) => recordOrgEvent(tx, { actorId: owner, actorRole: 'owner', action: 'member_left' }))).rejects.toThrow(TypeError);
  });

  it('FR-DEC-01 (helper): a former member is "former", a stranger "never", and UserRef marks the former', async () => {
    const h = await withOrg(ctx(), (tx) => memberHistory(tx, [assessor, removedViewer, stranger]));
    expect(Object.fromEntries(h)).toEqual({ [assessor]: 'member', [removedViewer]: 'former', [stranger]: 'never' });
    const refs = await withOrg(ctx(), (tx) => userRefs(tx, [removedViewer, assessor]));
    expect(refs.get(removedViewer)).toEqual({ userId: removedViewer, name: 'Removed Viewer', formerMember: true });
    expect(refs.get(assessor)).toEqual({ userId: assessor, name: 'Assessor', formerMember: false });
  });

  it('FR-DEC-01 FR-ORG-03 (helper): an administrator who created the organisation reads never', async () => {
    expect(await testDb.organisationEvent.count({ where: { orgId, actorId: platformAdmin } })).toBeGreaterThan(0);
    const h = await withOrg(ctx(), (tx) => memberHistory(tx, [platformAdmin]));
    expect(h.get(platformAdmin)).toBe('never');
  });

  it('FR-EVD-05 (helper): evidenceViews marks erased bytes with the erasure date', async () => {
    const v = await withOrg(ctx('viewer'), (tx) => evidenceViews(tx, [erasedEv, liveEv, evOfP2]));
    expect(v.get(erasedEv)!.erased).toEqual({ erasedOn: utcToday() });
    expect(v.get(liveEv)).toMatchObject({ id: liveEv, kind: 'file', fileName: 'f.pdf', erased: null,
      uploadedBy: { userId: removedViewer, name: 'Removed Viewer', formerMember: true } });
    expect(v.get(liveEv)!.uploadedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(v.size).toBe(3);
  });

  it('FR-REV-08 (helper): erasedFields lists the erased fields of each row with the date', async () => {
    const e = await withOrg(ctx('viewer'), (tx) => erasedFields(tx, 'decision_versions', [decision, randomUUID()]));
    expect(Object.fromEntries(e)).toEqual({ [decision]: { fields: ['reason'], erasedOn: utcToday() } });
  });

  it("FR-ORG-09 NFR-MNT-01: listOrganisationEvents is ORG's stub returning an empty page", async () => {
    expect(await listOrganisationEvents(ctx(), { limit: 50 })).toEqual({ events: [], hasMore: false });
  });
});
