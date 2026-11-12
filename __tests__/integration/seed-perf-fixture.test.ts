import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compare } from 'bcryptjs';
import { STAGES, type Stage } from '@/types/record';
import { runningContent, questionsInStage } from '@/lib/content/loader';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { colourlessEnv, stripAnsi } from '../helpers/spawnText';
import {
  PERF_FIXTURE, PERF_REDUCED, type PerfManifest, type PerfScale, type PerfSeedResult,
  assertLoopbackDatabaseUrl, seedPerfFixture, summaryLines,
} from '../../scripts/load/seed-perf-fixture';

/**
 * NFR-PERF-04's fixture (SRS line 3208), read per project (ruling R17-10): one organisation, 3 projects, every question
 * of the running content answered with 5 versions, 60 findings, 40 evidence files and 3 seals in each stage, and the ten
 * seats of the load script (one owner, nine admins; R17-1 (d)). The seeder writes the record through the app's own data
 * functions and refuses any database that is not on a loopback host (NFR-SEC-17, K-10). The always-on cases use a reduced
 * scale (R17-15: CI's verify job has a 15-minute limit, NFR-MNT-02); the full count runs with PERF_FIXTURE_TEST=1.
 */

// The CLI's stderr is matched, so the child runs colourless and its output is stripped (round 13, R13-2). It runs tsx's own
// binary, not `npx tsx`: npm 12 prints `npm notice run '<cmd>' <args>` to stderr for every npx run, which would echo the
// --database-url (and its password) and make the "no password on stderr" check fail on npm's line, not the seeder's.
// spawnSync blocks the event loop, so vitest's timeout cannot stop a hung child: the child gets its own.
const cli = (args: string[]) => {
  const r = spawnSync('node_modules/.bin/tsx', ['scripts/load/seed-perf-fixture.ts', ...args], { encoding: 'utf8', env: colourlessEnv(), timeout: 50_000 });
  if (r.error) throw new Error(`could not run the seeder CLI: ${r.error.message}`);
  if (r.signal) throw new Error(`the seeder CLI was killed by ${r.signal}; stderr: ${stripAnsi(r.stderr ?? '')}`);
  return { ...r, stdout: stripAnsi(r.stdout ?? ''), stderr: stripAnsi(r.stderr ?? '') };
};
const outFile = () => join(mkdtempSync(join(tmpdir(), 'perf-seed-')), 'perf-manifest.json');
const count = async (sql: string, ...p: unknown[]) => Number((await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...p))[0].n);

it('NFR-PERF-04 NFR-SEC-17: the seeder refuses a database that is not on a loopback host', () => {
  for (const ok of ['postgresql://makrai:pw@localhost:5460/makrai', 'postgresql://makrai:pw@127.0.0.1:5460/makrai',
    'postgresql://makrai:pw@[::1]:5460/makrai', 'postgresql://makrai:pw@127.0.0.1:5460/makrai?sslmode=disable'])
    expect(() => assertLoopbackDatabaseUrl(ok), ok).not.toThrow();
  for (const bad of ['postgresql://makrai:pw@db.example.org:5432/makrai', 'postgresql://makrai:pw@10.0.0.5:5432/makrai',
    'postgresql://makrai:pw@postgres:5432/makrai', 'postgresql://makrai:pw@127.0.0.2:5432/makrai',
    'postgresql://makrai:pw@localhost.example.org:5432/makrai', 'not a url',
    // R17-9: node-postgres reads host and hostaddr from the query string and lets them replace the url's host
    'postgresql://makrai:pw@127.0.0.1:5460/makrai?host=db.example.org', 'postgresql://makrai:pw@localhost:5460/makrai?hostaddr=10.0.0.5',
    'postgresql://makrai:pw@127.0.0.1:5460/makrai?sslmode=disable&host=%2Fvar%2Frun%2Fpostgresql'])
    expect(() => assertLoopbackDatabaseUrl(bad), bad).toThrow(/loopback/);
  const out = outFile();
  for (const bad of ['postgresql://makrai:s3cret@db.example.org:5432/makrai', 'postgresql://makrai:s3cret@127.0.0.1:5460/makrai?host=db.example.org']) {
    const r = cli(['--database-url', bad, '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--database-url must name a loopback host/);     // R17-8: the CLI names the flag, not DATABASE_URL
    expect(r.stderr).not.toContain('s3cret');
    expect(r.stderr, 'the refusal names no part of the url').not.toMatch(/db\.example\.org|makrai:|5432/);
    expect(existsSync(out)).toBe(false);
  }
  // A malformed call must not echo the url either: the --flag=value form, and a url in place of a flag.
  for (const args of [['--database-url=postgresql://makrai:s3cret@127.0.0.1:5460/makrai', '--out', out],
    ['postgresql://makrai:s3cret@127.0.0.1:5460/makrai', '--out', out]]) {
    const r = cli(args);
    expect(r.status, args[0]).toBe(2);
    expect(r.stderr).toMatch(/refused: unknown (flag --database-url|argument 1); usage/);
    expect(r.stderr).not.toContain('s3cret');
    expect(existsSync(out)).toBe(false);
  }
}, 120_000);

it('NFR-PERF-04 NFR-SEC-17: the seeder checks the app and identity urls too, and that the three name one database', async () => {
  const saved = { APP_DATABASE_URL: process.env.APP_DATABASE_URL, IDENTITY_DATABASE_URL: process.env.IDENTITY_DATABASE_URL };
  const out = outFile();
  try {
    process.env.APP_DATABASE_URL = 'postgresql://makrai_app:pw@db.example.org:5432/makrai_test';
    await expect(seedPerfFixture({ out, scale: PERF_REDUCED })).rejects.toThrow(/APP_DATABASE_URL must name a loopback host/);
    process.env.APP_DATABASE_URL = saved.APP_DATABASE_URL;
    delete process.env.IDENTITY_DATABASE_URL;
    await expect(seedPerfFixture({ out, scale: PERF_REDUCED })).rejects.toThrow(/IDENTITY_DATABASE_URL is not set/);
    const other = new URL(saved.IDENTITY_DATABASE_URL!); other.pathname = '/another_database';
    process.env.IDENTITY_DATABASE_URL = other.toString();
    await expect(seedPerfFixture({ out, scale: PERF_REDUCED })).rejects.toThrow(/the three database urls must name one database/);
  } finally {
    // Assigning undefined to process.env stores the string "undefined", so an unset variable is deleted instead.
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  expect(existsSync(out)).toBe(false);
});

it('NFR-PERF-04 NFR-SEC-17: an existing --out is refused and left as it was, and nothing is written', async () => {
  await resetDb(); await useFixtureContent('0.0.1-fixture');
  const out = outFile();
  writeFileSync(out, 'kept as it was\n', { mode: 0o644 });
  chmodSync(out, 0o644);
  await expect(seedPerfFixture({ out, scale: PERF_REDUCED })).rejects.toThrow(/refused: .* exists/);
  expect(readFileSync(out, 'utf8')).toBe('kept as it was\n');
  expect(statSync(out).mode & 0o777).toBe(0o644);
  expect(await count(`select count(*) n from organizations`)).toBe(0);
});

it('NFR-PERF-04 NFR-SEC-17: an --out inside a git repository is refused, because the manifest holds the run\'s password', async () => {
  await resetDb(); await useFixtureContent('0.0.1-fixture');
  const out = join(process.cwd(), 'test-results', `perf-manifest-${process.pid}.json`);
  mkdirSync(dirname(out), { recursive: true });
  await expect(seedPerfFixture({ out, scale: PERF_REDUCED })).rejects.toThrow(/inside the git repository/);
  expect(existsSync(out)).toBe(false);
  expect(await count(`select count(*) n from organizations`)).toBe(0);
});

it('NFR-PERF-04 NFR-SEC-17: a failure after the manifest is created removes it and writes nothing', async () => {
  await resetDb(); await useFixtureContent('0.0.1-fixture');
  const out = outFile();
  // More findings than the content has non-gate questions: refused inside the seed, after the file exists, before any row.
  await expect(seedPerfFixture({ out, scale: { ...PERF_REDUCED, findingsPerProject: 100_000 } })).rejects.toThrow(/non-gate questions/);
  expect(existsSync(out)).toBe(false);
  expect(await count(`select count(*) n from organizations`)).toBe(0);
});

// The checks of one seeded fixture, whatever its scale; the full-count test adds the literal counts of SRS line 3208.
async function checkFixture(r: PerfSeedResult, out: string, scale: PerfScale) {
  const content = runningContent();
  const inScale = (s: Stage) => scale.stages.includes(s);
  const q = scale.stages.reduce((n, s) => n + questionsInStage(content, s).length, 0);   // Q is read from the running content
  expect(r.questionCount).toBe(q);
  const { id: org, slug } = r.manifest.orgs[0];
  expect(await count(`select count(*) n from organizations where slug like 'fixture-org-perf-fixture-%'`)).toBe(1);
  expect(r.projectIds).toHaveLength(scale.projects);
  expect(await count(`select count(*) n from projects where "orgId" = $1`, org)).toBe(scale.projects);
  for (const p of r.projectIds) {
    expect(await count(`select count(*) n from decision_versions where "projectId" = $1`, p)).toBe(scale.versionsPerQuestion * q);
    expect(await count(`select count(*) n from (select "questionId" from decision_versions where "projectId" = $1
      group by "questionId" having count(*) = $2) x`, p, scale.versionsPerQuestion)).toBe(q);
    expect(await count(`select count(*) n from findings where "projectId" = $1`, p)).toBe(scale.findingsPerProject);
    expect(await count(`select count(*) n from findings where "projectId" = $1 and source = 'shortfall'`, p)).toBe(scale.findingsPerProject);
    expect(await count(`select count(*) n from evidence where "projectId" = $1 and kind = 'file'`, p)).toBe(scale.evidenceFilesPerProject);
    expect(await count(`select count(*) n from decision_evidence d join decision_versions v on v.id = d."versionId"
      where v."projectId" = $1`, p)).toBe(scale.evidenceFilesPerProject);
    for (const s of STAGES)
      expect(await count(`select count(*) n from seals x join stage_reviews r on r.id = x."stageReviewId"
        where r."projectId" = $1 and r.stage = $2`, p, s), `${p} ${s}`).toBe(inScale(s) ? scale.sealsPerStage : 0);
  }
  const m = JSON.parse(readFileSync(out, 'utf8')) as PerfManifest;
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(m.orgs).toEqual([{ id: org, slug }]);
  // R17-1 (d): ten seats for ten virtual users, one owner and nine admin, each its own account, all with the run's one password
  expect(m.users).toHaveLength(10);
  expect(m.users.map((u) => u.role).sort()).toEqual([...Array(9).fill('admin'), 'owner']);
  for (const key of ['userId', 'email', 'storageStatePath'] as const) expect(new Set(m.users.map((u) => u[key])).size, key).toBe(10);
  const owner = m.users.find((u) => u.role === 'owner')!;
  expect(owner.storageStatePath).toBe(join(dirname(out), 'perf-owner.storage.json'));
  const pw = m.users[0].password;
  expect(new Set(m.users.map((u) => u.password))).toEqual(new Set([pw]));    // one password per run
  expect(pw.length).toBeGreaterThanOrEqual(24); expect(pw).not.toBe('FixturePass123!');   // not the builder's shared one
  expect(await testDb.consentRecord.count({ where: { userId: owner.userId } })).toBeGreaterThan(0);
  for (const u of m.users) {
    expect(u).toMatchObject({ orgSlug: slug, index: 0 });
    expect(await testDb.membership.count({ where: { orgId: org, userId: u.userId, role: u.role } }), u.email).toBe(1);
    expect(await testDb.consentRecord.count({ where: { userId: u.userId } }), u.email)
      .toBe(await testDb.consentRecord.count({ where: { userId: owner.userId } }));          // every seat holds the acceptances, so it can sign in
  }
  // no seat of the organisation keeps the builder's shared password, the three seats outside the manifest included
  const seatIds = (await testDb.membership.findMany({ where: { orgId: org }, select: { userId: true } })).map((x) => x.userId);
  expect(seatIds).toHaveLength(13);                                           // the builder's five and the eight further admins
  // Every seat's hash is checked, with one compare for each distinct hash: bcryptjs runs on this thread and a compare at
  // the seeder's cost of 12 takes a quarter of a second, and the seeder writes one hash to every seat. A seat that held a
  // hash of its own would get its own compare.
  const accepts = new Map<string, boolean>();
  for (const u of await testDb.user.findMany({ where: { id: { in: seatIds } } })) {
    const stored = u.passwordHash!;
    if (!accepts.has(stored)) accepts.set(stored, await compare(pw, stored));
    expect(accepts.get(stored), u.email).toBe(true);
  }
  const lines = summaryLines(r);
  expect(lines[0]).toBe(`perf-fixture: org=${slug} projects=${scale.projects} questions=${q} decision_versions=${scale.versionsPerQuestion * q * scale.projects}`
    + ` findings=${scale.findingsPerProject * scale.projects} evidence=${scale.evidenceFilesPerProject * scale.projects} seals=${scale.sealsPerStage * scale.stages.length * scale.projects}`);
  for (const l of lines) { expect(l).not.toContain(pw); expect(l).not.toMatch(/@/); }   // no password, no email
  const pre = questionsInStage(content, 'pre-processing');
  expect(r.loadQuestions).toEqual(pre.filter((x) => x.type !== 'gate').slice(0, 10).map((x) => x.id));
  const largest = scale.stages.reduce((a, s) => (questionsInStage(content, s).length > questionsInStage(content, a).length ? s : a));
  expect(r.s11Path).toBe(`/orgs/${slug}/projects/${r.projectIds[0]}/stages/${largest}`);
  expect(r.s12Path).toBe(`${r.s11Path}/questions/${questionsInStage(content, largest)[0].id}`);
  return { slug, q };
}

describe('NFR-PERF-04: the seeded fixture at a reduced scale (every run)', () => {
  let out: string; let first: PerfSeedResult;
  beforeAll(async () => {
    await resetDb(); await useFixtureContent('0.0.1-fixture');
    out = outFile(); first = await seedPerfFixture({ out, scale: PERF_REDUCED });
  }, 120_000);

  it('NFR-PERF-04: one run writes one project and one stage of the fixture, the ten seats and the manifest', async () => {
    await checkFixture(first, out, PERF_REDUCED);
  });

  it('NFR-PERF-04: a second run on the same database refuses and writes nothing', async () => {
    const before = [await count(`select count(*) n from organizations`), await count(`select count(*) n from decision_versions`)];
    const out2 = outFile();
    await expect(seedPerfFixture({ out: out2, scale: PERF_REDUCED })).rejects.toThrow(/already holds the perf fixture/);
    expect([await count(`select count(*) n from organizations`), await count(`select count(*) n from decision_versions`)]).toEqual(before);
    expect(existsSync(out2)).toBe(false);
    const r = cli(['--database-url', process.env.DATABASE_URL!, '--out', out2]);
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/already holds the perf fixture/);
    expect(existsSync(out2)).toBe(false);
  }, 60_000);
});

// R17-15: the full count of SRS line 3208. Run with PERF_FIXTURE_TEST=1 (V-prog Step 4, V Task 3 Step 2 (a)); it empties the database first.
describe.runIf(process.env.PERF_FIXTURE_TEST === '1')('NFR-PERF-04: the seeded fixture at the full count of SRS line 3208', () => {
  let out: string; let full: PerfSeedResult;
  beforeAll(async () => {
    await resetDb(); await useFixtureContent('0.0.1-fixture');
    out = outFile(); full = await seedPerfFixture({ out });
  }, 600_000);

  it('NFR-PERF-04: one run writes the full fixture, with the question count read from the running content', async () => {
    const { q } = await checkFixture(full, out, PERF_FIXTURE);
    expect(q).toBe(78);                                   // 0.0.1-fixture (G-17): 24 + 26 + 28; the seeder reads it, the test checks the reading
    expect(summaryLines(full)[0]).toMatch(/projects=3 questions=78 decision_versions=1170 findings=180 evidence=120 seals=27$/);
    expect(full.s11Path).toMatch(/\/stages\/post-processing$/);    // 28 questions, the largest
    expect(full.s12Path).toMatch(/\/questions\/Q-PO-01$/);
  });
});
