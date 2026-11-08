import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { buildLoadedContent } from '@/lib/content/loader';
import { signOffHash, signOffItems, signOffPayload, type SignOffBatch } from '@/lib/content/signoffs';
import { validateContentVersion } from '@/lib/content/validate';
import { buildRegistryMigration } from '../../scripts/content/registry-release';

// It reads the real bundle (contract "Content bundle"): the running version, its sign-offs and its migration.
vi.unmock('@/lib/content/root');

/**
 * The one command that writes a content version's registry migration (NFR-MNT-07, SRS line 3344) and CI's check
 * that every committed content migration is what the command writes today. The command and the function run on
 * temporary repositories holding a copy of H0's fixture bundle, the 4.0.0 baseline and the real migrations; only
 * the last three cases read the real content.
 */

const FIXTURES = join(process.cwd(), '__tests__', 'fixtures', 'content');
const BATCHES: readonly SignOffBatch[] = ['pre-processing', 'in-processing', 'post-processing', 'help-and-reason-codes',
  'question-set:pre-processing', 'question-set:in-processing', 'question-set:post-processing'];
/**
 * A content migration folder, `<stamp>_content_<semver with _>`. Not a bare `_content_` match: the 3.0.1 folder
 * `20260818120000_framework_3_0_1_content_corrections` holds that string too.
 */
const CONTENT_DIR = /^\d{14}_content_/;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- the files are edited as plain JSON
const json = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const running = (): string => json('data/content/index.json').running;
const signoffs = (v: string): { records: unknown[] } => json(`data/content/${v}/signoffs.json`) as { records: unknown[] };
const enforce = process.env.RELEASE_CANDIDATE === '1' || signoffs(running()).records.length > 0;

/** `<stamp>_content_<semver with _>` back to its stamp and semver, the semver found among the versions index.json lists. */
function parseContentDir(d: string): [string, string] {
  const m = /^(\d{14})_content_(.+)$/.exec(d);
  const semver = (json('data/content/index.json').versions as string[]).find((v) => v.replace(/[.-]/g, '_') === m?.[2]);
  if (m === null || semver === undefined) throw new Error(`${d} is not the folder of a listed content version`);
  return [m[1], semver];
}

/**
 * A temporary repository: data/ with the 4.0.0 baseline, data/content with one fixture version (its follow-up help
 * texts rewritten for QC-06, and with `signed`, every batch signed at `at`), and a copy of prisma/migrations.
 */
function tempRepo(semver: string, o: { signed: boolean; at?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'cnt-release-')); roots.push(root);
  const dir = join(root, 'data', 'content', semver);
  mkdirSync(dir, { recursive: true });
  for (const f of ['questionBank.json', 'assessmentAreas.json']) cpSync(join('data', f), join(root, 'data', f));
  cpSync(join(FIXTURES, semver), dir, { recursive: true });
  write(join(root, 'data', 'content', 'index.json'), { running: semver, versions: [semver] });
  cpSync('prisma/migrations', join(root, 'prisma', 'migrations'), { recursive: true });
  const bank = json(join(dir, 'questionBank.json'));
  for (const s of Object.values(bank.stages as Json)) for (const m of (s as Json).modules) for (const q of m.questions)
    if (q.id.includes('-EXTRA-') && /^When /.test(q.helpText ?? '')) q.helpText = 'Guidance for every team that answers this question.';
  write(join(dir, 'questionBank.json'), bank);
  const areas = json(join(dir, 'assessmentAreas.json'));   // and 4.0.0's http source link (PP-03), which a release refuses
  for (const a of areas.areas) for (const r of a.references ?? []) if (typeof r.url === 'string') r.url = r.url.replace(/^http:/, 'https:');
  write(join(dir, 'assessmentAreas.json'), areas);
  if (o.signed) sign(dir, o.at ?? '2026-10-31T20:30:00.000Z');
  return root;
}
/**
 * The deprecation list a fixture generation in `root` must carry: 3.0.0, 3.0.1 and 4.0.0 (the three hand-written registry
 * migrations), then the semver each content migration the repository holds registers, in folder order. Read from the
 * copied migrations, so it holds before and after C-TXT commits content 5.0.0's migration.
 */
function expectedDeprecations(root: string): string {
  const content = readdirSync(join(root, 'prisma', 'migrations')).filter((d) => CONTENT_DIR.test(d)).sort()
    .map((d) => /VALUES \('[^']+', '([^']+)'/.exec(readFileSync(join(root, 'prisma', 'migrations', d, 'migration.sql'), 'utf8'))?.[1] ?? `unreadable:${d}`);
  return ['3.0.0', '3.0.1', '4.0.0', ...content].map((v) => `'${v}'`).join(', ');
}
function sign(dir: string, at: string): void {
  const c = buildLoadedContent(basename(dir), (f) => readFileSync(join(dir, f)));
  write(join(dir, 'signoffs.json'), { records: BATCHES.map((batch) => {
    const p = signOffPayload(c, batch);
    return { batch, approver: 'Owner', at, sha256: signOffHash(p), items: signOffItems(p) };
  }) });
}
/** The command as C-TXT runs it, its output colourless (NO_COLOR, no FORCE_COLOR) and stripped of escapes before it is matched. */
function command(args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const r = spawnSync('npx', ['tsx', 'scripts/content/release-version.ts', ...args], { encoding: 'utf8', env, timeout: 60_000 });
  return { status: r.status, out: stripVTControlCharacters(`${r.stdout}${r.stderr}`) };
}

describe('the content registry migration command', () => {
  it('NFR-MNT-07: running the command twice on the same content gives the same file', () => {
    const root = tempRepo('0.0.1-fixture', { signed: true });   // temp root: data/ baseline, data/content/<fixture>, prisma/migrations copied
    const a = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000'), b = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000');
    expect(a.problems).toEqual([]); expect(a.sql).toBe(b.sql);
    expect(a.sql).toContain(`'${computeVersionBundleHash(join(root, 'data/content/0.0.1-fixture'))}'`);
    expect(a.sql).toContain(`"semver" IN (${expectedDeprecations(root)})`);
    expect(expectedDeprecations(root)).toMatch(/^'3\.0\.0', '3\.0\.1', '4\.0\.0'/);
    expect(a.dir).toBe('prisma/migrations/29991231000000_content_0_0_1_fixture');
    expect(a.sql).toContain("VALUES ('fv_0_0_1_fixture', '0.0.1-fixture', ");
    expect(a.sql).toContain("'2026-10-31T20:30:00.000Z', 'published');");   // publishedAt: the latest sign-off time
    // The list follows the copied migrations: whatever content migrations the repository holds (C-TXT's 5.0.0 once it
    // is committed) are read above, and a later one is added here under a name the repository can never hold (9.9.9,
    // stamped just before the fixture's), so the case passes before and after C-TXT's commit.
    const withLater = tempRepo('0.0.1-fixture', { signed: true });
    mkdirSync(join(withLater, 'prisma/migrations/29991230000000_content_9_9_9'));
    writeFileSync(join(withLater, 'prisma/migrations/29991230000000_content_9_9_9/migration.sql'),
      `INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt", "status") VALUES ('fv_9_9_9', '9.9.9', '${'d'.repeat(64)}', '2026-10-31T20:30:00.000Z', 'published');\n`);
    const c = buildRegistryMigration(withLater, '0.0.1-fixture', '29991231000000');
    expect(c.problems).toEqual([]);
    expect(c.sql).toContain(`"semver" IN (${expectedDeprecations(withLater)})`);
    expect(expectedDeprecations(withLater)).toBe(`${expectedDeprecations(root)}, '9.9.9'`);
  });

  it('NFR-MNT-07: the command refuses unsigned content and an early stamp, and writes nothing', () => {
    const root = tempRepo('0.0.1-fixture', { signed: false });
    const before = readdirSync(join(root, 'prisma/migrations')).sort();
    const r = command(['0.0.1-fixture', '20200101000000', '--root', root]);
    expect(r.status).toBe(1); expect(r.out).toMatch(/signoff|sign-off/i); expect(r.out).toMatch(/stamp/);
    // Nothing written: the copied migrations (C-TXT's among them once committed) are as they were, and no folder of
    // the version given exists.
    expect(readdirSync(join(root, 'prisma/migrations')).sort()).toEqual(before);
    expect(before.some((d) => d.endsWith('_content_0_0_1_fixture'))).toBe(false);
  }, 90_000);

  it('NFR-MNT-07: the command writes the migration and its hash, a second run leaves the file as it is, and a changed content is refused instead of overwritten', () => {
    const root = tempRepo('0.0.1-fixture', { signed: true });
    const first = command(['0.0.1-fixture', '29991231000000', '--root', root]);
    expect(first.status, first.out).toBe(0);
    const file = join(root, 'prisma/migrations/29991231000000_content_0_0_1_fixture/migration.sql');
    const hash = computeVersionBundleHash(join(root, 'data/content/0.0.1-fixture'));
    expect(first.out).toContain('prisma/migrations/29991231000000_content_0_0_1_fixture/migration.sql');
    expect(first.out).toContain(hash);
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).toBe(buildRegistryMigration(root, '0.0.1-fixture', '29991231000000').sql);
    expect(command(['0.0.1-fixture', '29991231000000', '--root', root]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    // a later sign-off moves publishedAt, so the generation differs from the file already written
    sign(join(root, 'data/content/0.0.1-fixture'), '2026-11-01T08:00:00.000Z');
    const third = command(['0.0.1-fixture', '29991231000000', '--root', root]);
    expect(third.status).toBe(1);
    expect(third.out).toMatch(/already exists and differs/);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  }, 180_000);

  it('NFR-MNT-07: a committed content migration still equals a fresh generation after later migrations land', () => {
    const root = tempRepo('0.0.1-fixture', { signed: true });
    const own = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000');
    mkdirSync(join(root, own.dir)); writeFileSync(join(root, own.dir, 'migration.sql'), own.sql);
    // another unit's migration with a later stamp, and a later content version registered after this one
    mkdirSync(join(root, 'prisma/migrations/29991231000100_org_step')); writeFileSync(join(root, 'prisma/migrations/29991231000100_org_step/migration.sql'), 'SELECT 1;\n');
    mkdirSync(join(root, 'prisma/migrations/29991231000200_content_9_9_9'));
    writeFileSync(join(root, 'prisma/migrations/29991231000200_content_9_9_9/migration.sql'),
      `INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt", "status") VALUES ('fv_9_9_9', '9.9.9', '${'b'.repeat(64)}', '2027-01-01T00:00:00.000Z', 'published');\n`);
    const again = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000');
    expect(again.problems).toEqual([]);
    expect(again.sql).toBe(own.sql);
    // a new generation, by contrast, must sort after every migration
    rmSync(join(root, own.dir), { recursive: true });
    expect(buildRegistryMigration(root, '0.0.1-fixture', '29991231000000').problems.join('\n')).toMatch(/stamp 29991231000000 does not sort after/);
  });

  it('NFR-MNT-07 NFR-SEC-11: a semver or stamp outside its pattern, an unlisted version and a second folder for the version are refused before anything is read or written', () => {
    const root = tempRepo('0.0.1-fixture', { signed: true });
    for (const semver of ['../0.0.1-fixture', "5.0.0'; --", '0.0.1-fixture/..', '']) {
      const r = buildRegistryMigration(root, semver, '29991231000000');
      expect(r, semver).toEqual({ dir: '', sql: '', problems: [expect.stringMatching(/not a content version/)] });
    }
    for (const stamp of ['2999123100000', '2999-12-31', '29991231000000x']) expect(buildRegistryMigration(root, '0.0.1-fixture', stamp).problems.join('\n')).toMatch(/stamp/);
    expect(buildRegistryMigration(root, '0.0.2-fixture', '29991231000000').problems.join('\n')).toMatch(/0\.0\.2-fixture.*index\.json/);
    mkdirSync(join(root, 'prisma/migrations/29991230000000_content_0_0_1_fixture'));
    writeFileSync(join(root, 'prisma/migrations/29991230000000_content_0_0_1_fixture/migration.sql'), 'SELECT 1;\n');
    const r = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000');
    expect(r.sql).toBe(''); expect(r.problems.join('\n')).toMatch(/29991230000000_content_0_0_1_fixture/);
  });

  it('NFR-MNT-07: an earlier registration the command cannot read, or one of the same version, is a problem, not a version left published', () => {
    const later = (root: string, name: string, sql: string) => { mkdirSync(join(root, 'prisma/migrations', name)); writeFileSync(join(root, 'prisma/migrations', name, 'migration.sql'), sql); };
    const h = 'c'.repeat(64);
    const forms: Array<[string, RegExp]> = [
      [`insert into framework_versions (id, semver, "contentHash", "publishedAt") values ('fv_4_1_0', '4.1.0', '${h}', '2026-09-01T00:00:00Z');\n`, /29991230000000_hand.*cannot be read/],
      [`INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt") VALUES ('fv_4_1_0', '4.1.0', '${h}', now()), ('fv_4_2_0', '4.2.0', '${h}', now());\n`, /29991230000000_hand.*cannot be read/],
      [`INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt") VALUES ('fv_0_0_1_fixture', '0.0.1-fixture', '${h}', now());\n`, /29991230000000_hand already registers 0\.0\.1-fixture/],
    ];
    for (const [sql, pattern] of forms) {
      const root = tempRepo('0.0.1-fixture', { signed: true });
      later(root, '29991230000000_hand', sql);
      const r = buildRegistryMigration(root, '0.0.1-fixture', '29991231000000');
      expect(r.sql, sql).toBe(''); expect(r.problems.join('\n'), sql).toMatch(pattern);
    }
    // a folder a crashed run left without its migration.sql does not exempt the stamp from the order rule
    const root = tempRepo('0.0.1-fixture', { signed: true });
    mkdirSync(join(root, 'prisma/migrations/29991231000000_content_0_0_1_fixture'));
    later(root, '29991231000100_org_step', 'SELECT 1;\n');
    expect(buildRegistryMigration(root, '0.0.1-fixture', '29991231000000').problems.join('\n')).toMatch(/stamp 29991231000000 does not sort after/);
  });

  it('NFR-MNT-07: the command refuses a --root without a directory, an empty one and a repeated one', () => {
    for (const [args, pattern] of [
      [['0.0.1-fixture', '29991231000000', '--root'], /--root needs a directory/],
      [['0.0.1-fixture', '29991231000000', '--root', ''], /--root needs a directory/],
      [['0.0.1-fixture', '29991231000000', '--root', '/a', '--root', '/b'], /--root given twice/],
    ] as const) {
      const r = command([...args]);
      expect(r.status, args.join(' ')).toBe(1); expect(r.out).toMatch(pattern);
    }
    // the usage says what to do when a sign-off changes after the migration was written (it is never overwritten)
    const usage = command([]);
    expect(usage.status).toBe(1);
    expect(usage.out).toMatch(/after a sign-off edit, remove the unmerged migration folder or make a new content version/);
  }, 180_000);

  it('NFR-MNT-07: every content migration equals a fresh generation and its hash equals the computed bundle hash', () => {
    for (const d of readdirSync('prisma/migrations').filter((d) => CONTENT_DIR.test(d))) {
      const [stamp, semver] = parseContentDir(d);
      const fresh = buildRegistryMigration(process.cwd(), semver, stamp);
      expect(fresh.problems, d).toEqual([]);
      expect(readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8')).toBe(fresh.sql);
      expect(fresh.sql).toContain(`'${computeVersionBundleHash(`data/content/${semver}`)}'`);
    }
  });

  it.runIf(enforce)('FR-CNT-02 NFR-MNT-07: the running content is complete, signed and registered', () => {
    const proposal = `docs/content/question-set-${running()}/proposal.json`;
    expect(validateContentVersion(`data/content/${running()}`, { baselineDir: 'data', proposalFile: existsSync(proposal) ? proposal : null, completeness: true })).toEqual([]);
    expect(readdirSync('prisma/migrations').some((d) => d.endsWith(`_content_${running().replace(/[.-]/g, '_')}`))).toBe(true);
  });

  it('FR-CNT-02 NFR-MNT-07: completeness is enforced once any sign-off exists or on the release candidate', () => {
    expect(enforce).toBe(process.env.RELEASE_CANDIDATE === '1' || signoffs(running()).records.length > 0);
    if (!enforce) expect(readdirSync('prisma/migrations').filter((d) => CONTENT_DIR.test(d))).toEqual([]);   // no hash before sign-off
  });
});
