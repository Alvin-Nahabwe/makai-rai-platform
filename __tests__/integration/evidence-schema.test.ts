import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { appClient } from '../../lib/data/tenant';

const TENANT_TABLES = ['evidence', 'evidence_blobs'];

/**
 * Task 3 brief (.superpowers/sdd/2026-08-06-phase1c-evidence-and-pinning/task-3-brief.md),
 * Step 1, reproduced verbatim except for two changes, both reported in
 * task-3-report.md rather than applied silently (AGENTS.md §2):
 *
 * 1. The brief's single test named "rejects both-null and both-set attach
 *    targets (O-2)" only ever exercised the both-null case — its body has no
 *    assertion touching a both-set insert at all. Renamed to
 *    "rejects both-null attach targets (O-2)" below, and the both-set half it
 *    claimed to prove is now its own test in the second describe block
 *    (AGENTS.md §3: "for each verification item, state the claim it proves —
 *    then check it proves that claim and not a neighbouring one").
 * 2. "indexes every foreign key column (O-4)" checked three of the table's
 *    four FK columns (assessmentId, remediationItemId, frameworkVersionId)
 *    and omitted `uploadedById` — the design spec itself
 *    (docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md
 *    §6, O-4) says "all four new FK columns". Extended below.
 */
describe('evidence schema', () => {
  it.each(TENANT_TABLES)('%s has RLS enabled AND forced', async (t) => {
    const [row] = await testDb.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, t);
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it.each(TENANT_TABLES)('%s has an org_isolation policy with USING and WITH CHECK (O-1)', async (t) => {
    const rows = await testDb.$queryRawUnsafe<Array<{ policyname: string; qual: string | null; with_check: string | null }>>(
      `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = $1`, t);
    expect(rows).toHaveLength(1);
    expect(rows[0].policyname).toBe('org_isolation');
    expect(rows[0].qual).not.toBeNull();
    expect(rows[0].with_check).not.toBeNull();
  });

  it('rejects both-null attach targets (O-2)', async () => {
    await expect(testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","filename","mimeType","byteSize","sha256")
      VALUES ('x','o','a','fv_3_0_0','f','text/plain',1,'h')`).rejects.toThrow(/attach_target/);
  });

  it('indexes every foreign key column (O-4)', async () => {
    const idx = await testDb.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'evidence'`;
    const defs = idx.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/"assessmentId"/);
    expect(defs).toMatch(/"remediationItemId"/);
    expect(defs).toMatch(/"frameworkVersionId"/);
    expect(defs).toMatch(/"uploadedById"/);
  });
});

/**
 * Fresh findings from the C1 senior-security pass (task-3-report.md), derived
 * for THIS task rather than reused from Task 1's or the design spec's threat
 * table (AGENTS.md §7.1, §2 "reusing a previously-derived conclusion").
 *
 * Fixture note: unlike the declarative checks above, these need a REAL
 * evidence row satisfying every FK and the attach-target CHECK, so each test
 * gets its own org/project/assessment (and, for the attach-target pair below,
 * a real remediation item) via `resetDb()` + Prisma create calls — the same
 * fixture shape `framework-registry.test.ts`'s O-3 trigger block uses, not
 * the brief's minimal fake-id inserts.
 *
 * That fixture choice is load-bearing, not stylistic. A first draft of the
 * two tests immediately below used a nonexistent `remediationItemId` (matching
 * the brief's own economical style), and when the non-vacuity pass dropped
 * `evidence_attach_target_check` to prove these tests depend on it, BOTH
 * still failed — but with `evidence_remediationItemId_fkey`'s error, not
 * `attach_target`. Red, for the wrong reason: the insert was never getting
 * far enough to test the CHECK at all once it was gone, because a made-up FK
 * target rejects it first regardless. That is the exact ambiguity Task 1's
 * report already named for a different constraint ("the test's rejection was
 * never exclusively dependent on the trigger") — recorded here because
 * re-deriving it independently, in a different constraint, on the very next
 * task, is the AGENTS.md §2 evidence discipline working as intended, not
 * evidence the first instance was a one-off. Fixed by giving both a REAL
 * remediation item, so every column other than the one(s) under test is
 * unimpeachably valid and a dropped CHECK has nothing else standing in for it.
 */
describe('evidence structural invariants beyond the brief (fresh C1 findings)', () => {
  let orgId: string;
  let otherOrgId: string;
  let assessmentId: string;
  let remediationItemId: string;

  beforeEach(async () => {
    await resetDb();
    const user = await testDb.user.create({
      data: { email: 'ev-schema@x.org', name: 'ev-schema', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: 'ev-schema-org', slug: 'ev-schema-org' } });
    const otherOrg = await testDb.organization.create({ data: { name: 'ev-schema-other', slug: 'ev-schema-other' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'ev-schema project', createdById: user.id },
    });
    const assessment = await testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: user.id,
        mode: 'full',
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        engineState: {} as never,
      },
    });
    const remediationItem = await testDb.remediationItem.create({
      data: {
        orgId: org.id,
        assessmentId: assessment.id,
        areaId: 'PO-03',
        areaName: 'Accountability',
        tier: 'gap',
        description: 'ev-schema fixture remediation item',
      },
    });
    orgId = org.id;
    otherOrgId = otherOrg.id;
    assessmentId = assessment.id;
    remediationItemId = remediationItem.id;
  });

  it('rejects both-null attach targets, with every other FK genuinely valid (O-2 non-vacuity variant)', async () => {
    // Unlike the brief's given test (fake orgId/assessmentId), every FK here
    // is real. That is what makes this test's non-vacuity proof clean: with
    // `evidence_attach_target_check` dropped, THIS exact insert succeeds
    // (task-3-report.md), proving the CHECK — and nothing else — was
    // rejecting it. The brief's own version proves a different, also-true
    // fact: the CHECK fires before Postgres validates any FK at all.
    await expect(testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-both-null-valid-fks', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'f.pdf','application/pdf',1,'h-both-null-valid')
    `).rejects.toThrow(/attach_target/);
  });

  it('rejects both-set attach targets, with every other FK genuinely valid (O-2, the half the brief’s given test does not exercise)', async () => {
    await expect(testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","remediationItemId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-both-set', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-1', ${remediationItemId}, 'f.pdf','application/pdf',1,'h-both-set')
    `).rejects.toThrow(/attach_target/);
  });

  it('rejects a duplicate upload with a NULL component (O-23, proves NULLS NOT DISTINCT is doing the work)', async () => {
    // remediationItemId is omitted (NULL) in both rows — the exact shape the
    // coordinator's brief flags as the case a plain UNIQUE would silently let
    // through, because two NULLs are distinct from each other under default
    // semantics.
    await testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-dedup-1', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-DEDUP', 'f.pdf','application/pdf',1,'same-hash')`;

    await expect(testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-dedup-2', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-DEDUP', 'f2.pdf','application/pdf',1,'same-hash')
    `).rejects.toThrow(/evidence_dedup_key/);
  });

  /**
   * evidence_blobs carries its own "orgId" so the DDL guard's RLS auto-enable
   * fires on it (brief context, migration.sql header). But nothing in the
   * brief's schema ties that column's VALUE to the evidence row it belongs
   * to — a plain `evidenceId REFERENCES evidence(id)` says nothing about
   * orgId. Since RLS on evidence_blobs is driven entirely by its OWN orgId
   * column, an insert that mismatches the two values would isolate the BLOB
   * under the wrong tenant while its metadata row sits under the right one:
   * a structural hole in O-1's isolation guarantee for the one table that
   * holds the actual bytes. Every other child table in this schema closes
   * the equivalent hole with a composite FK to its parent's (orgId, id) pair
   * (evidence's own FK to assessments is one; projects/assessments/
   * remediation_items do the same in prior migrations) — this test proves
   * evidence_blobs is not the exception.
   */
  it('rejects an evidence_blobs row whose orgId does not match its evidence row (closes an O-1 gap for evidence_blobs)', async () => {
    await testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-blob-mismatch', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-1', 'f.pdf','application/pdf',1,'h-blob-mismatch')`;

    await expect(testDb.$executeRaw`
      INSERT INTO "evidence_blobs" ("evidenceId","orgId","content")
      VALUES ('ev-blob-mismatch', ${otherOrgId}, ${Buffer.from('x')})
    `).rejects.toThrow(/evidence_blobs_evidence_fkey/);
  });

  it('accepts an evidence_blobs row whose orgId matches (proves the FK above rejects the MISMATCH, not everything)', async () => {
    await testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
      VALUES ('ev-blob-match', ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-1', 'f.pdf','application/pdf',1,'h-blob-match')`;

    await testDb.$executeRaw`
      INSERT INTO "evidence_blobs" ("evidenceId","orgId","content")
      VALUES ('ev-blob-match', ${orgId}, ${Buffer.from('x')})`;

    const [row] = await testDb.$queryRaw<Array<{ orgId: string }>>`
      SELECT "orgId" FROM "evidence_blobs" WHERE "evidenceId" = 'ev-blob-match'`;
    expect(row.orgId).toBe(orgId);
  });
});

/**
 * The brief's "Note on the grants" (task-3-brief.md, Step 4): no UPDATE,
 * because evidence is uploaded or deleted, never edited. Stated as design
 * intent but never asserted anywhere — this is the same class of gap
 * `framework-registry.test.ts`'s "O-5" block closes for `framework_versions`
 * (SELECT succeeds, INSERT/UPDATE/DELETE rejected), applied here to the one
 * grant this design actually withholds. `appClient` (lib/data/tenant.ts) is
 * the production client already connected as makrai_app; called directly
 * (not through `withOrg`) because the ACL check Postgres performs for a
 * privilege the role was never granted happens before RLS is ever evaluated,
 * so no org context is needed to observe the rejection.
 */
describe('makrai_app cannot UPDATE evidence or evidence_blobs (grant immutability)', () => {
  let orgId: string;
  let assessmentId: string;
  let evidenceId: string;

  beforeEach(async () => {
    await resetDb();
    const user = await testDb.user.create({
      data: { email: 'ev-grant@x.org', name: 'ev-grant', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: 'ev-grant-org', slug: 'ev-grant-org' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'ev-grant project', createdById: user.id },
    });
    const assessment = await testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: user.id,
        mode: 'full',
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        engineState: {} as never,
      },
    });
    orgId = org.id;
    assessmentId = assessment.id;
    evidenceId = 'ev-grant-target';

    await testDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
      VALUES (${evidenceId}, ${orgId}, ${assessmentId}, ${SEEDED_FRAMEWORK_VERSION_ID}, 'Q-1', 'f.pdf','application/pdf',1,'h-grant')`;
    await testDb.$executeRaw`
      INSERT INTO "evidence_blobs" ("evidenceId","orgId","content")
      VALUES (${evidenceId}, ${orgId}, ${Buffer.from('x')})`;
  });

  it('UPDATE on evidence is rejected', async () => {
    await expect(
      appClient.$executeRaw`UPDATE "evidence" SET "filename" = 'renamed' WHERE "id" = ${evidenceId}`,
    ).rejects.toThrow(/permission denied/i);
  });

  it('UPDATE on evidence_blobs is rejected', async () => {
    await expect(
      appClient.$executeRaw`UPDATE "evidence_blobs" SET "content" = ${Buffer.from('y')} WHERE "evidenceId" = ${evidenceId}`,
    ).rejects.toThrow(/permission denied/i);
  });
});
