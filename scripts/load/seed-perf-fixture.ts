/**
 * NFR-PERF-04's fixture (SRS line 3208) on a loopback database, for the load step V runs on the candidate
 * (scripts/load/save-decisions.mjs --manifest). Read per project (ruling R17-10): one organisation; 3 projects; in each,
 * every question of the running content answered with 5 versions, 60 findings, 40 evidence files, and 3 seals in each of
 * the three stages; plus ten seats for the load script's ten virtual users, one owner and nine admins (R17-1 (d)).
 *
 *   node_modules/.bin/tsx scripts/load/seed-perf-fixture.ts --database-url <owner-role url> --out <file>
 *
 * (not `npx tsx`: npm 12 prints `npm notice run '<cmd>' <args>` on stderr for every npx run, which would echo the url
 * and its password)
 * with APP_DATABASE_URL and IDENTITY_DATABASE_URL in the environment (the app's data functions connect through them,
 * lib/data/connection.ts). It prints the three summaryLines and exits 0; a refusal prints `seed-perf-fixture: <message>`
 * on stderr and exits 2; any other error prints its name, its code, and the message only of the seeder's own errors
 * (safeDetail), and exits 1. The CLI always seeds PERF_FIXTURE.
 *
 * Two kinds of writes:
 *  - Through the app's own data functions, as the routes call them (requestDigest({ path, body })): decision_versions and
 *    decision_evidence (DEC-a's saveDecision), findings (FND-a's onShortfallSaved, inside saveDecision's transaction, for
 *    each 'partly' version), evidence and evidence_blobs (EVD's createFileEvidence), stage_reviews (REV-b's
 *    openStageReview) and seals (REV-a's sealStageReview).
 *  - Through the owner role (K0a's record fixture builder, __tests__/helpers/recordFixture.ts, and testDb), because no
 *    app function creates them: users and consent_records (an account is made by the invitation flow, with the person's
 *    own password), organizations, memberships and organization_agreements (an organisation is made by ORG's
 *    administrator definer from an invitation), and projects (made inside route 23's handler). The seeder also sets every
 *    seat's users."passwordHash" to the run's one password, and writes the eight further admin seats the way the builder
 *    writes a seat, because the builder makes one seat per role.
 *
 * Safety (NFR-SEC-17, K-10): every database url must name a loopback host, checked before anything is read or written;
 * the password is generated per run and written only to the --out manifest, created mode 600 and never overwritten; the
 * printed lines carry no password and no email, and no message carries a url's user or password.
 *
 * Only node: modules, bcryptjs and types are imported statically: testDb reads DATABASE_URL when its module loads
 * (__tests__/helpers/db.ts:5-7), so the builder and the @/lib modules are imported after the checks.
 */
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hash } from 'bcryptjs';
import type { Stage } from '../../types/record';
import type { FixtureManifest } from '../../e2e/fixtures/manifest';

export interface PerfScale { projects: number; stages: readonly Stage[]; versionsPerQuestion: number;
  findingsPerProject: number; evidenceFilesPerProject: number; sealsPerStage: number }
export const PERF_FIXTURE: PerfScale = { projects: 3, stages: ['pre-processing', 'in-processing', 'post-processing'],
  versionsPerQuestion: 5, findingsPerProject: 60, evidenceFilesPerProject: 40, sealsPerStage: 3 };   // SRS line 3208, read as above; the CLI always seeds this
export const PERF_REDUCED: PerfScale = { projects: 1, stages: ['pre-processing'], versionsPerQuestion: 5,
  findingsPerProject: 10, evidenceFilesPerProject: 5, sealsPerStage: 2 };      // the always-on test only (R17-15): one project, one stage
export const PERF_ORG_LABEL = 'perf-fixture';   // buildOrg's label: the slug starts 'fixture-org-perf-fixture-'
export class Refused extends Error {}           // the CLI prints its message and exits 2
/** A self-check of the seeder failed; its message is the seeder's own and holds no url, so the CLI prints it. */
export class SeedDefect extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const EXTRA_ADMINS = 8;

/** Refuses a url that does not name a loopback host, or whose query string could replace the host. Never echoes the user or the password. */
export function assertLoopbackDatabaseUrl(url: string, name?: string): void {
  const what = name ?? 'the database url';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Refused(`refused: ${what} must name a loopback host (localhost, 127.0.0.1 or ::1), not a url`);
  }
  // node-postgres reads host and hostaddr from the query string and lets them replace the url's host (R17-9).
  if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) {
    throw new Refused(`refused: ${what} must name a loopback host, and its query string must not set host or hostaddr`);
  }
  if (!LOOPBACK.has(u.hostname)) {
    // No part of the url is named: a password holding an unencoded '/', '?' or '#' shifts the parse, so what reads as the
    // host can be the user or a piece of the password.
    throw new Refused(`refused: ${what} must name a loopback host (localhost, 127.0.0.1 or ::1), and it does not`);
  }
}

/** `--database-url <url> --out <file>`, both required; any other flag is refused. */
export function parseArgs(argv: readonly string[]): { databaseUrl: string; out: string } {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag !== '--database-url' && flag !== '--out') {
      // Never echo the token: `--database-url=<url>` or a url given in place of a flag would print the password.
      const shown = flag.startsWith('--') ? `flag ${flag.split('=', 1)[0]}` : `argument ${i + 1}`;
      throw new Refused(`refused: unknown ${shown}; usage: --database-url <url> --out <file>`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Refused(`refused: ${flag} needs a value`);
    got[flag] = value;
  }
  if (!got['--database-url'] || !got['--out']) throw new Refused('refused: usage: --database-url <url> --out <file>');
  return { databaseUrl: got['--database-url'], out: got['--out'] };
}

// One organisation and its ten seats; no platform administrator seat (the e2e manifest's `platformAdmin`, which the
// load script does not read: scripts/load/save-decisions.mjs reads `orgs[0].slug` and the owner and admin users).
export type PerfManifest = Omit<FixtureManifest, 'orgs' | 'platformAdmin'> & { orgs: readonly [{ id: string; slug: string }] };
export interface PerfSeedResult {
  manifest: PerfManifest; projectIds: string[]; questionCount: number;
  loadQuestions: string[];        // the first 10 non-gate questions of 'pre-processing', the stage the load script saves in
  s11Path: string; s12Path: string; largestStage: Stage; largestStageQuestions: number;
  totals: { decisionVersions: number; findings: number; evidence: number; seals: number };
}

/** The same host, port and database for the three urls (each already checked as a loopback url). */
function sameDatabase(urls: readonly string[]): boolean {
  // node-postgres takes PGPORT, then 5432, for a url with no port.
  const key = (s: string) => { const u = new URL(s); return `${u.hostname}:${u.port || process.env.PGPORT || '5432'}${u.pathname}`; };
  return new Set(urls.map(key)).size === 1;
}

/** A write that reports a replay used a request id seen before; every request id here is fresh, so that is a defect. */
function fresh<T>(out: { replayed: boolean; value: T }, what: string): T {
  if (out.replayed) throw new SeedDefect(`${what} was answered as a replay, but its request id was new`);
  return out.value;
}

export async function seedPerfFixture(opts: { out: string; scale?: PerfScale }): Promise<PerfSeedResult> {
  const scale = opts.scale ?? PERF_FIXTURE;

  // 1. Every database url is on a loopback host, and the three name one database.
  const urls = (['DATABASE_URL', 'APP_DATABASE_URL', 'IDENTITY_DATABASE_URL'] as const).map((n) => {
    const v = process.env[n];
    if (v === undefined || v === '') throw new Refused(`refused: ${n} is not set; it must name a loopback database`);
    assertLoopbackDatabaseUrl(v, n);
    return v;
  });
  if (!sameDatabase(urls)) throw new Refused('refused: the three database urls must name one database');

  const { testDb } = await import('../../__tests__/helpers/db');

  // 2. One fixture per database.
  const existing = await testDb.$queryRawUnsafe<Array<{ slug: string }>>(
    `select slug from organizations where slug like 'fixture-org-perf-fixture-%' limit 1`);
  if (existing.length > 0) {
    throw new Refused(`refused: this database already holds the perf fixture (${existing[0].slug}); recreate the database to seed it again`);
  }

  // 3. The manifest file: outside every git repository (it holds the run's password), created here, mode 600, never an
  //    existing file; removed if a later step fails.
  assertOutsideRepository(opts.out);
  let fd: number;
  try {
    fd = openSync(opts.out, 'wx', 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Refused(code === 'EEXIST' ? `refused: ${opts.out} exists` : `refused: cannot create ${opts.out} (${code ?? 'unknown error'})`);
  }
  const progress = { wroteRows: false };
  let closed = false;
  try {
    const result = await seed(scale, opts.out, testDb, progress);
    writeFileSync(fd, JSON.stringify(result.manifest, null, 2) + '\n');   // writes until every byte is out
    closeSync(fd);
    closed = true;
    return result;
  } catch (e) {
    // The manifest holds the run's password once written, so removing it is what matters here; a failed close leaves the
    // descriptor's state unknown and must not stop the unlink, and a failed unlink is reported, never swallowed.
    if (!closed) { try { closeSync(fd); } catch { /* see above: the unlink below still runs */ } }
    try { unlinkSync(opts.out); } catch (u) {
      throw new SeedDefect(`the seed failed (${safeDetail(e)}) and ${opts.out} could not be removed (${safeDetail(u)}): remove it by hand`);
    }
    if (progress.wroteRows && !(e instanceof Refused)) {
      throw new SeedDefect(`the seed failed after writing to the database (${safeDetail(e)}); the database holds a partial fixture, recreate it`);
    }
    throw e;
  }
}

/**
 * Refuses an --out whose directory is inside a git work tree: the manifest holds the run's one password, and a file
 * there is one `git add` from a commit. `git -C <dir> rev-parse --show-toplevel` exits 128 outside a repository, which
 * is the one answer that lets the run go on; any other failure (no git, no such directory) is thrown as it is.
 */
function assertOutsideRepository(out: string): void {
  let top: string;
  try {
    top = execFileSync('git', ['-C', dirname(resolve(out)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    if ((e as { status?: unknown }).status === 128) return;
    throw e;
  }
  throw new Refused(`refused: --out is inside the git repository ${top}; the manifest holds the run's password, so write it outside every repository`);
}

/** What can be printed of an error: its name, a string `code` (ENOENT, P2002, ...), and the message only of the seeder's own errors. */
function safeDetail(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const parts = [e.name];
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string') parts.push(`code=${code}`);
  if (e instanceof SeedDefect || e instanceof Refused) parts.push(e.message);
  return parts.join(' ');
}

type TestDb = typeof import('../../__tests__/helpers/db')['testDb'];

async function seed(scale: PerfScale, out: string, testDb: TestDb, progress: { wroteRows: boolean }): Promise<PerfSeedResult> {
  const { STAGES } = await import('../../types/record');
  const { runningContent, questionsInStage } = await import('../../lib/content/loader');
  const { buildOrg, addProject, ctxFor } = await import('../../__tests__/helpers/recordFixture');
  const { requestDigest } = await import('../../lib/data/idempotency');
  const { saveDecision } = await import('../../lib/data/decisions');
  const { createFileEvidence } = await import('../../lib/data/evidence');
  const { openStageReview } = await import('../../lib/data/reviews');
  const { sealStageReview } = await import('../../lib/data/seals');

  // 4. The content: Q questions in the scale's stages, enough non-gate questions for the findings.
  const content = runningContent();
  const stages = STAGES.filter((s) => scale.stages.includes(s));
  const questions = stages.flatMap((s) => questionsInStage(content, s));
  const nonGate = questions.filter((q) => q.type !== 'gate');
  if (nonGate.length < scale.findingsPerProject) {
    throw new Refused(`refused: the running content has ${nonGate.length} non-gate questions; the fixture needs ${scale.findingsPerProject}`);
  }

  // 5. The organisation, its ten load seats, and the run's one password on every seat.
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await hash(password, 12);
  progress.wroteRows = true;   // from here on a failure leaves rows behind
  const fx = await buildOrg({ label: PERF_ORG_LABEL });
  const owner = fx.members.owner;
  const ownerAcceptances = await testDb.consentRecord.findMany({ where: { userId: owner.userId } });
  if (ownerAcceptances.length === 0) throw new SeedDefect('the owner seat holds no acceptances, so no seat could sign in');
  const admins: Array<{ userId: string; email: string }> = [{ userId: fx.members.admin.userId, email: fx.members.admin.email }];
  for (let n = 1; n <= EXTRA_ADMINS; n++) {
    const email = `perf-admin-${n}-${fx.org.slug}@fixture.test`.toLowerCase();
    const user = await testDb.user.create({ data: { email, name: `Perf admin ${n}`, passwordHash, role: 'assessor' } });
    await testDb.consentRecord.createMany({ data: ownerAcceptances.map(({ id: _id, userId: _u, ...rest }) => ({ ...rest, userId: user.id })) });
    await testDb.membership.create({ data: { orgId: fx.org.id, userId: user.id, role: 'admin' } });
    admins.push({ userId: user.id, email });
  }
  const seatIds = [...Object.values(fx.members).map((m) => m.userId), ...admins.slice(1).map((a) => a.userId)];
  await testDb.user.updateMany({ where: { id: { in: seatIds } }, data: { passwordHash } });
  const ctx = ctxFor(fx, 'owner');
  const actor = { userId: owner.userId, role: 'owner' as const };

  // 6. The record, in each project, through the app's data functions.
  const today = new Date().toISOString().slice(0, 10);
  const shortfallIds = new Set(nonGate.slice(0, scale.findingsPerProject).map((q) => q.id));
  const evidenceIndex = new Map(nonGate.slice(0, scale.evidenceFilesPerProject).map((q, k) => [q.id, k]));
  const totals = { decisionVersions: 0, findings: 0, evidence: 0, seals: 0 };
  const projectIds: string[] = [];
  for (let p = 1; p <= scale.projects; p++) {
    const { id: projectId } = await addProject(fx, { name: `Perf project ${p}` });
    projectIds.push(projectId);
    const files: string[] = [];
    for (let i = 1; i <= scale.evidenceFilesPerProject; i++) {
      const fileName = `perf-${p}-${i}.pdf`;
      const bytes = Buffer.from(`%PDF-1.4\n%perf fixture ${p}-${i}\n%%EOF\n`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const digest = requestDigest({ path: { id: projectId }, body: { kind: 'file', fileName, sha256 } });
      const item = fresh(await createFileEvidence(ctx, actor, { projectId, fileName, bytes, requestId: randomUUID() }, digest), `evidence ${fileName}`);
      files.push(item.id);
      totals.evidence++;
    }
    for (const q of questions) {
      const gate = q.type === 'gate';
      for (let v = 1; v <= scale.versionsPerQuestion; v++) {
        const last = v === scale.versionsPerQuestion;
        const k = evidenceIndex.get(q.id);
        const shortfall = last && shortfallIds.has(q.id);
        const body = {
          requestId: randomUUID(), stage: q.stage, questionId: q.id, baseVersionNumber: v === 1 ? null : v - 1,
          status: gate ? null : shortfall ? 'partly' as const : 'done' as const, scopeAnswer: gate ? 'yes' as const : null,
          optionsInPlace: [], reasonCode: null, reason: `Perf fixture version ${v}`,
          decidedBy: { kind: 'member' as const, userId: actor.userId }, declaredDate: today,
          evidenceIds: last && k !== undefined ? [files[k]] : [],
        };
        const digest = requestDigest({ path: { id: projectId }, body });
        fresh(await saveDecision(ctx, actor, { ...body, projectId }, digest), `decision ${q.id} version ${v}`);
        totals.decisionVersions++;
        if (shortfall) totals.findings++;
      }
    }
    for (const stage of stages) {
      const reviewBody = { requestId: randomUUID(), stage, preparedFor: null };
      const review = fresh(await openStageReview(ctx, actor, { ...reviewBody, projectId },
        requestDigest({ path: { id: projectId }, body: reviewBody })), `review ${stage}`);
      for (let s = 1; s <= scale.sealsPerStage; s++) {
        const sealBody = { requestId: randomUUID() };
        fresh(await sealStageReview(ctx, actor, { ...sealBody, projectId, reviewId: review.id },
          requestDigest({ path: { id: projectId, reviewId: review.id }, body: sealBody })), `seal ${s} of ${stage}`);
        totals.seals++;
      }
    }
  }

  // The rows the app's functions wrote, counted, against what was sent: a shortfall that raised no finding, or a write
  // that stored nothing, is a fixture that does not hold SRS line 3208's counts, so it is refused here, not printed.
  const n = async (sql: string) => Number((await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(sql, fx.org.id))[0].n);
  const counted = {
    decisionVersions: await n(`select count(*) n from decision_versions v join projects p on p.id = v."projectId" where p."orgId" = $1`),
    findings: await n(`select count(*) n from findings f join projects p on p.id = f."projectId" where p."orgId" = $1 and f.source = 'shortfall'`),
    evidence: await n(`select count(*) n from evidence e join projects p on p.id = e."projectId" where p."orgId" = $1 and e.kind = 'file'`),
    seals: await n(`select count(*) n from seals x join stage_reviews r on r.id = x."stageReviewId" join projects p on p.id = r."projectId" where p."orgId" = $1`),
  };
  const links = await n(`select count(*) n from decision_evidence d join decision_versions v on v.id = d."versionId" join projects p on p.id = v."projectId" where p."orgId" = $1`);
  const mismatch = (Object.keys(totals) as Array<keyof typeof totals>).filter((k) => counted[k] !== totals[k])
    .map((k) => `${k} sent ${totals[k]}, stored ${counted[k]}`);
  if (links !== totals.evidence) mismatch.push(`decision_evidence sent ${totals.evidence}, stored ${links}`);
  if (mismatch.length > 0) throw new SeedDefect(`the stored fixture differs from what was written: ${mismatch.join('; ')}`);

  // 7. The manifest: the owner seat and the nine admin seats, no other.
  const base = { password, orgSlug: fx.org.slug, index: 0 as const };
  const users = [
    { userId: owner.userId, email: owner.email, role: 'owner' as const, ...base, storageStatePath: join(dirname(out), 'perf-owner.storage.json') },
    ...admins.map((a, i) => ({ ...a, role: 'admin' as const, ...base, storageStatePath: join(dirname(out), `perf-admin-${i + 1}.storage.json`) })),
  ];
  const manifest: PerfManifest = { orgs: [{ id: fx.org.id, slug: fx.org.slug }], users };
  const largestStage = stages.reduce((a, s) => (questionsInStage(content, s).length > questionsInStage(content, a).length ? s : a));
  const largestQuestions = questionsInStage(content, largestStage);
  const s11Path = `/orgs/${fx.org.slug}/projects/${projectIds[0]}/stages/${largestStage}`;
  return {
    manifest, projectIds, questionCount: questions.length,
    loadQuestions: questionsInStage(content, 'pre-processing').filter((q) => q.type !== 'gate').slice(0, 10).map((q) => q.id),
    s11Path, s12Path: `${s11Path}/questions/${largestQuestions[0].id}`, largestStage, largestStageQuestions: largestQuestions.length,
    totals,
  };
}

export function summaryLines(r: PerfSeedResult): [string, string, string] {
  const { slug } = r.manifest.orgs[0];
  const t = r.totals;
  return [
    `perf-fixture: org=${slug} projects=${r.projectIds.length} questions=${r.questionCount} decision_versions=${t.decisionVersions}`
      + ` findings=${t.findings} evidence=${t.evidence} seals=${t.seals}`,
    `perf-paths: s11=${r.s11Path} s12=${r.s12Path} stage=${r.largestStage} stage_questions=${r.largestStageQuestions}`,
    `load-args: --org ${slug} --project ${r.projectIds[0]} --questions ${r.loadQuestions.join(',')}`,
  ];
}

async function main(): Promise<number> {
  const { databaseUrl, out } = parseArgs(process.argv.slice(2));
  assertLoopbackDatabaseUrl(databaseUrl, '--database-url');
  process.env.DATABASE_URL = databaseUrl;
  const result = await seedPerfFixture({ out });
  for (const line of summaryLines(result)) console.log(line);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      // A refusal is the operator's to read; any other error prints what safeDetail allows, since a database error's message can carry a url.
      if (e instanceof Refused) { console.error(`seed-perf-fixture: ${e.message}`); process.exit(2); }
      console.error(`seed-perf-fixture: failed: ${safeDetail(e)}`);
      process.exit(1);
    },
  );
}
