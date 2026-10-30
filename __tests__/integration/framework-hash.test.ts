import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { computeBundleHash, BUNDLE_FILES } from '@/lib/framework/bundleHash';
import { testDb } from '../helpers/db';

/**
 * The `data/*.json` files v0.6.0 adds that are not part of the 4.0.0 bundle (FR-CNT-05, contract revocation
 * table): the resources file (CNT), the credit, privacy-recipient and help-contact files (PUB) and the
 * UNCST 16.6 file (C-MAP). They hold no framework content, so `lib/framework/bundleHash.ts` leaves them out
 * and this listing must too. A unit that adds another `data/*.json` adds its name here in the same commit; a
 * file that is in neither this list nor `BUNDLE_FILES` still fails the enumeration below. `unit/rm-2` deletes
 * the 4.0.0 cases with the file.
 */
const V060_DATA_JSON = [
  'data/resources.json',
  'data/credit.json',
  'data/privacy-recipients.json',
  'data/help-contact.json',
  'data/uncst-16-6.json',
] as const;

/** `find data -maxdepth 1 -name '*.json'` in `dir`, less the v0.6.0 names, sorted. */
function listedDataJson(dir = '.'): string[] {
  return execSync(`find data -maxdepth 1 -name '*.json'`, { cwd: dir })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((f) => !(V060_DATA_JSON as readonly string[]).includes(f))
    .sort();
}

describe('content bundle hash', () => {
  it('hashes exactly the four content files, in a fixed order', () => {
    expect(BUNDLE_FILES).toEqual([
      'data/assessmentAreas.json',
      'data/projectConfig.json',
      'data/questionBank.json',
      'data/scoringConfig.json',
    ]);
  });

  /**
   * Task 2 review, fix round 2, Important 1 (2026-08-08). `BUNDLE_FILES`
   * above is a hand-written list with nothing anywhere cross-checking it
   * against `data/` -- AGENTS.md §3: "Where a list must be complete,
   * generate it rather than writing it... a hand-written list that must be
   * complete is a latent defect with a timestamp on it." Someone adds
   * `data/newContent.json`, forgets `BUNDLE_FILES`, and `computeBundleHash()`
   * keeps hashing only the original four -- content changes, the hash does
   * not, and `resolveFramework` reports `matches: true` for an assessment
   * pinned against content that changed underneath it. That is exactly "the
   * pin is a stored claim nothing verifies," one level down from what this
   * whole task exists to fix. Modelled on
   * `__tests__/integration/port-completeness.test.ts`'s shape (also D-103:
   * an authoritative hand list, proven complete by a disk enumeration on
   * every run, rather than trusted or auto-generated).
   *
   * DELIBERATELY NOT auto-generating `BUNDLE_FILES` from `readdirSync('data')`
   * at runtime instead of asserting equality here -- coordinator's ruling,
   * recorded so a future reader does not "improve" this back into the
   * version already rejected: a runtime-generated list would make the hash
   * depend on whatever happens to be traced into the standalone image at
   * that moment (see lib/framework/bundleHash.ts and next.config.ts's
   * `outputFileTracingIncludes` comments for why tracing gaps are a real,
   * previously-hit failure mode here). A file silently missing from the
   * standalone image would then silently drop out of the runtime-generated
   * list too, and the hash would still compute successfully over the
   * remaining files -- a quiet mismatch on every assessment instead of a
   * loud throw. `BUNDLE_FILES`'s determinism is the feature this test
   * protects, not a gap to close.
   *
   * Sorts both sides before comparing: this test's claim is that the SET of
   * `.json` files under `data/` is complete, not that `find`'s filesystem
   * enumeration order (unspecified, not guaranteed alphabetical) matches
   * `BUNDLE_FILES`'s array order -- a different property (that order is what
   * makes the hash deterministic across processes, already proven by the
   * "matches the hash recorded in the registry" test below reproducing a
   * fixed golden value).
   */
  it('BUNDLE_FILES enumerates exactly the .json files present in data/', () => {
    const filesOnDisk = listedDataJson();
    expect(filesOnDisk.length).toBeGreaterThan(0);
    expect(filesOnDisk).toEqual([...BUNDLE_FILES].sort());
  });

  it('FR-CNT-05: the 4.0.0 listing leaves out exactly the five v0.6.0 data files and still counts any other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-hash-'));
    try {
      mkdirSync(join(dir, 'data'));
      for (const f of [...BUNDLE_FILES, ...V060_DATA_JSON, 'data/stray.json']) writeFileSync(join(dir, f), '{}');
      expect(V060_DATA_JSON).toEqual(['data/resources.json', 'data/credit.json', 'data/privacy-recipients.json', 'data/help-contact.json', 'data/uncst-16-6.json']);
      expect(listedDataJson(dir)).toEqual([...BUNDLE_FILES, 'data/stray.json'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches the hash recorded in the registry (O-13)', async () => {
    const [row] = await testDb.$queryRaw<Array<{ contentHash: string }>>`
      SELECT "contentHash" FROM "framework_versions" WHERE "semver" = '4.0.0'`;
    expect(computeBundleHash()).toBe(row.contentHash);
  });

  /**
   * O-14, first half. Deviates from the brief in two ways, both because the
   * brief's snippet was written from memory rather than verified (reported
   * per AGENTS.md §2 "an assumption in the brief turns out false"):
   *
   * 1. `fx.orgA.usersByRole.owner[0].id` does not exist on `TwoOrgFixture`
   *    (__tests__/helpers/fixture.ts:52-57): the real shape is
   *    `{ orgs: [FixtureOrg, FixtureOrg], users: FixtureUser[] }` with a
   *    FLAT `users` array carrying `userId`/`orgSlug`/`role`/`index`, not a
   *    per-org `usersByRole` map. Matches the idiom already used by
   *    `__tests__/integration/fixture.test.ts` and
   *    `permission-matrix.test.ts` (`fixture.orgs[0]`,
   *    `fixture.users.filter((u) => u.orgSlug === org.slug && ...)`).
   * 2. `tx.project.findFirstOrThrow({ select: { id: true } })` assumes a
   *    Project already exists in the fresh org. It does not:
   *    `buildTwoOrgFixture()` -> `bootstrapOrgWithOwner`
   *    (lib/data/preauth.ts:155-175) creates only User, Organization and
   *    ConsentRecord rows -- no Project. Verified live: running the brief's
   *    literal form throws
   *    `PrismaClientKnownRequestError: An operation failed because it
   *    depends on one or more records that were required but not found.`
   *    (P2025) from `findFirstOrThrow`. A Project is created explicitly
   *    below instead, matching the pattern every other integration test
   *    that needs one already uses (e.g. framework-registry.test.ts:113,
   *    permission-matrix.test.ts:409).
   *
   * Task 2 review, fix round 2, Important 2 (2026-08-08). This test's own
   * INSERT below is already idempotent (`ON CONFLICT ("id") DO NOTHING`),
   * but idempotent is not the same as cleaned up: nothing deleted the
   * `fv_bogus` row afterward, and `framework_versions` is deliberately
   * excluded from `resetDb()`'s TRUNCATE (`__tests__/helpers/db.ts:34-53`,
   * reference data) with no `globalSetup`/`pretest` to catch it either -- so
   * every run of this suite left a permanent `status='published'` row at
   * semver `9.9.9` in `makrai_test`. That collides with this codebase's own
   * idiom: `framework-current-version.test.ts` already uses a `…-9.9.9`
   * string to mean "a semver that must not exist" in a no-fallback throw
   * test, and a bare `9.9.9` literal used the same way elsewhere would
   * resolve instead of throwing. The `afterEach` below pairs with the
   * INSERT the same way `framework-registry.test.ts`:76-104 pairs its
   * idempotent insert with an `afterEach` -> `deleteMany` for
   * `OTHER_VERSION_ID` -- but does NOT carry that pairing over verbatim.
   * Found live, not reasoned, and worth recording because it is the reason
   * this is not a direct copy-paste: a first draft that only deleted
   * `frameworkVersion` failed every run with `PrismaClientKnownRequestError:
   * Foreign key constraint violated on the constraint:
   * assessments_frameworkVersionId_fkey`. Unlike O-3's `OTHER_VERSION_ID`
   * (only ever referenced by an UPDATE that gets ROLLED BACK via SAVEPOINT,
   * so nothing durable ever points at it) and O-5's `TEST_ROW_ID` (never
   * referenced by an assessment at all), THIS test's whole point is to
   * create a real, COMMITTED `Assessment` permanently pinned to `fv_bogus`
   * -- `Assessment.frameworkVersion` carries no `onDelete: Cascade`
   * (prisma/schema.prisma:146), by design (a pin must not silently vanish),
   * so Postgres correctly refuses to delete a `framework_versions` row a
   * real assessment still points to. The assessment (and its throwaway
   * fixture org/user/project) is deleted first, breaking the FK reference,
   * before the `framework_versions` row itself.
   */
  afterEach(async () => {
    await testDb.assessment.deleteMany({ where: { frameworkVersionId: 'fv_bogus' } });
    await testDb.frameworkVersion.deleteMany({ where: { id: 'fv_bogus' } });
  });

  it('reports a mismatch when the pinned hash differs from the running bundle', async () => {
    const { buildTwoOrgFixture } = await import('@/__tests__/helpers/fixture');
    const { resolveFramework } = await import('@/lib/data/framework');
    const { withOrg, createOrgContext } = await import('@/lib/data/tenant');

    const fx = await buildTwoOrgFixture();
    const orgA = fx.orgs[0];
    const owner = fx.users.find(
      (u) => u.orgSlug === orgA.slug && u.role === 'owner' && u.index === 0,
    );
    expect(owner, 'fixture must carry a bootstrap owner (index 0) for orgA').toBeDefined();

    // A second registry row with a deliberately wrong hash. The migration's own
    // row is correct by construction, so this is the only way to produce a
    // mismatch. framework_versions is not tenant data, so it is written on the
    // identity connection.
    await testDb.$executeRaw`
      INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
      VALUES ('fv_bogus','9.9.9','0000000000000000000000000000000000000000000000000000000000000000', now())
      ON CONFLICT ("id") DO NOTHING`;

    const ctx = createOrgContext(orgA.id, 'owner');
    // buildTwoOrgFixture() creates no Project for either org -- see the
    // doc comment above. Created explicitly, scoped to orgA the same way
    // the RLS INSERT policy requires (orgId must equal the GUC withOrg set).
    const project = await withOrg(ctx, (tx) =>
      tx.project.create({
        data: { orgId: orgA.id, name: 'fw-hash-mismatch project', createdById: owner!.userId },
      }),
    );
    // A NEW assessment pinned to the bogus row at creation. Do NOT update an
    // existing assessment's pin: Task 1's write-once trigger rejects that, and
    // the trigger is a control this plan installs, never something a test
    // works around. Written through the owner role (testDb), not makrai_app:
    // v0.6.0 step 6 revokes INSERT on assessments from makrai_app
    // (prisma/migrations/20261030000600_v060_06_freeze; 00-contract.md
    // revocation table, REACH-1), so this is setup, and the read below still
    // goes through withOrg.
    const created = await testDb.assessment.create({
      data: {
        orgId: orgA.id,
        projectId: project.id,
        userId: owner!.userId,
        frameworkVersionId: 'fv_bogus',
        // `engineState` is NOT NULL; its content is irrelevant here because
        // resolveFramework reads only the pinned version.
        engineState: {} as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const res = await withOrg(ctx, (tx) => resolveFramework(created.id, tx));

    expect(res?.pinned.semver).toBe('9.9.9');
    expect(res?.matches).toBe(false);
  });
});

/**
 * D-227. `computeBundleHash()` hashes the RAW BYTES of the four
 * `BUNDLE_FILES` (bundleHash.ts:6-12, deliberate -- see that comment), which
 * means whether a file ends with a trailing newline (0x0a) is part of the
 * hash. Three of the four currently end with one; `data/assessmentAreas.json`
 * does not (ends `}`, no newline) -- confirmed live below, not asserted from
 * memory:
 *
 *   $ tail -c 1 data/assessmentAreas.json | xxd -p   -> 7d          ('}')
 *   $ tail -c 1 data/projectConfig.json   | xxd -p   -> 0a
 *   $ tail -c 1 data/questionBank.json    | xxd -p   -> 0a
 *   $ tail -c 1 data/scoringConfig.json   | xxd -p   -> 0a
 *
 * An editor with "insert final newline" (or "trim trailing newline")
 * enabled silently flips one of these bytes on save, which silently changes
 * the platform-wide framework content hash for every assessment created
 * afterward -- D-147 records a trailing-newline normalisation as exactly
 * this class of byte change, and D-167 records that a hash mismatch 409s
 * assessment creation with no in-product recovery. Nothing guarded this
 * before D-227.
 *
 * This test PINS the CURRENT state. It does not "fix" `assessmentAreas.json`
 * to match the other three -- adding the missing newline IS the byte change
 * this test exists to catch, and doing so would need its own framework
 * content version bump (ADR-0003; one was just published, 4.0.0,
 * prisma/migrations/20260827143754_framework_4_0_0_flat_weights), not a
 * decision a test gets to make silently. If this test ever needs to change,
 * that is the signal a content version bump is already underway, not a
 * reason to "fix" it here.
 *
 * The file list itself is `BUNDLE_FILES`, imported from bundleHash.ts, not a
 * second hand-copied list (AGENTS.md §3: "derive the file list ... never a
 * hand-written copy"). Only the per-file trailing-newline FLAG is written
 * below, because pinning a snapshot of the present has no source to
 * generate it from -- unlike `BUNDLE_FILES` itself, which is cross-checked
 * against `data/` above ("BUNDLE_FILES enumerates exactly the .json files
 * present in data/").
 */
describe('trailing-newline state of the BUNDLE_FILES is pinned (D-227)', () => {
  const EXPECTED_TRAILING_NEWLINE: Record<(typeof BUNDLE_FILES)[number], boolean> = {
    'data/assessmentAreas.json': false,
    'data/projectConfig.json': true,
    'data/questionBank.json': true,
    'data/scoringConfig.json': true,
  };

  it('EXPECTED_TRAILING_NEWLINE covers every current BUNDLE_FILES entry, in the same order', () => {
    // Guards the map above against drifting out of sync with BUNDLE_FILES
    // itself: a fifth content file added there with no entry here would
    // otherwise be silently skipped below instead of failing loudly.
    expect(Object.keys(EXPECTED_TRAILING_NEWLINE)).toEqual([...BUNDLE_FILES]);
  });

  it.each(BUNDLE_FILES)('%s keeps its current trailing-newline state', (file) => {
    const bytes = readFileSync(join(process.cwd(), file));
    const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
    expect(
      endsWithNewline,
      `${file}'s trailing-newline state changed (recorded: ` +
        `${EXPECTED_TRAILING_NEWLINE[file]}, now: ${endsWithNewline}). ` +
        `computeBundleHash() (lib/framework/bundleHash.ts) hashes RAW BYTES, so this ` +
        `is a real framework content-hash change -- almost certainly an editor's ` +
        `"insert/trim final newline" setting silently rewriting the file underneath ` +
        `you, not a deliberate edit. Do NOT "fix" this by editing the file to match, ` +
        `and do NOT update this test's expectation -- either launders an unintended ` +
        `content-hash change (D-227; D-147; D-167: a hash mismatch 409s assessment ` +
        `creation with no in-product recovery). Instead: run ` +
        `'git diff -- ${file}' to confirm an editor touched it, then ` +
        `'git checkout -- ${file}' to revert. If a trailing-newline change here is ` +
        `actually wanted, that is a deliberate framework content version bump ` +
        `(ADR-0003), tracked and published like any other content edit -- not a ` +
        `same-commit fix to this test.`,
    ).toBe(EXPECTED_TRAILING_NEWLINE[file]);
  });
});
