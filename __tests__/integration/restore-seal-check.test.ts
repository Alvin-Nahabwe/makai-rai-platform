import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { sealStageReview } from '@/lib/data/seals';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { MARKER_PATTERN, markerText } from '../helpers/markers';
import { addDecision, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * ops/host/seal-check.mjs against the slot's own Postgres container (unit OPS-HOST, Task 1): the plan it
 * writes from REV-a's SEAL_SOURCE_SQL, run by psql 16 in a session of any time zone, and the check it makes
 * of the rows that come back. Seals are made by REV-a's sealStageReview over a fixture whose free texts are
 * markers. Nothing here touches a production host.
 */

/**
 * How psql reaches the test database. Locally the slot's env names its container (E2E_DB_CONTAINER) and psql
 * runs inside it by `docker exec`; CI's unit step sets it to the postgres:16-alpine service container's id, so
 * the client is psql 16 there too (the runner's own psql is 18). Without it, psql runs on the host against the
 * URL the suite itself uses (DATABASE_URL, which vitest.config.ts takes from TEST_DATABASE_URL). With neither,
 * the test throws: it never skips.
 */
const CONTAINER = process.env.E2E_DB_CONTAINER;
const PSQL_FLAGS = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];

/** The libpq environment of a postgresql:// URL, so that no password appears in an argument. */
function pgEnvOf(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
}

function runPsql(args: string[], input: string | undefined, env: Record<string, string>): string {
  if (CONTAINER) {
    // `-e` hands each variable to psql inside the container; the client there connects by its local socket.
    return execFileSync('docker', ['exec', '-i', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), CONTAINER, 'psql', '-U', 'makrai', '-d', 'makrai_test', ...args], { input }).toString();
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('restore-seal-check: neither E2E_DB_CONTAINER nor DATABASE_URL is set, so psql has no database to reach');
  }
  return execFileSync('psql', args, { input, env: { ...process.env, ...pgEnvOf(url), ...env } }).toString();
}

const psql = (sql: string, env: Record<string, string> = {}): string => runPsql([...PSQL_FLAGS, '-f', '-'], sql, env);
const seal = (mode: 'plan' | 'check', input: string) => spawnSync('node', ['ops/host/seal-check.mjs', mode], { input, encoding: 'utf8' });
const exportRows = (env: Record<string, string> = {}): string =>
  psql(seal('plan', psql('SELECT DISTINCT "orgId" FROM seals ORDER BY 1;')).stdout, env);

let fx: OrgFixture;
let p: { id: string };
let v1: string;
let fv: { contentVersionId: string };
let s1: { id: string };
let s2: { id: string };

async function sealOf(org: OrgFixture, projectId: string, reviewId: string, role: OrgRole = 'reviewer') {
  const out = await sealStageReview(ctxFor(org, role), { userId: org.members[role].userId, role },
    { requestId: randomUUID(), projectId, reviewId }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  return out.value;
}
async function withTriggersDisabled(table: string, fn: () => Promise<unknown>): Promise<void> {
  const triggers = await testDb.$queryRawUnsafe<{ name: string; mode: string }[]>(
    `SELECT tgname AS name, tgenabled::text AS mode FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, table);
  await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    for (const t of triggers) {
      const how = t.mode === 'A' ? 'ENABLE ALWAYS' : t.mode === 'R' ? 'ENABLE REPLICA' : t.mode === 'D' ? 'DISABLE' : 'ENABLE';
      await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" ${how} TRIGGER "${t.name}"`);
    }
  }
}
const asOperator = (sql: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
  await tx.$executeRawUnsafe(sql);
});

beforeEach(async () => {
  await resetDb();
  fv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
  v1 = (await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' })).id;
  await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-02', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' });
  const r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  const r2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  s1 = await sealOf(fx, p.id, r.id);
  s2 = await sealOf(fx, p.id, r2.id);
});

describe('ops/host/seal-check.mjs on the slot database', () => {
  it('NFR-INT-07: the psql the test drives is version 16, which has \\bind', () => {
    // \bind arrived in PostgreSQL 16: another client must fail here, loudly, and not in a later test.
    expect(runPsql(['--version'], undefined, {})).toMatch(/\b16\.\d+/);
  });

  it('NFR-INT-07: every intact seal checks valid', () => {
    const r = seal('check', exportRows());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('seals=2 valid=2 mismatched=0 erased_fields=0 erased_files=0');
  });

  it('NFR-INT-07: one tampered seal makes the check fail and names the first difference', async () => {
    await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET reason = 'changed' WHERE id = ${v1}`);
    const r = seal('check', exportRows());
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^seals=2 valid=0 mismatched=2 /m); // both seals name the one changed version
    expect(r.stdout).toMatch(/^seal=[0-9a-f-]+ result=mismatch first_difference=decisions\[Q-PP-01\]\.reason$/m);
  });

  it('NFR-INT-07: an altered seal row reads fingerprint_mismatch and the other seal is still checked', async () => {
    await withTriggersDisabled('seals', () => testDb.$executeRaw`UPDATE seals SET manifest = manifest || '\x20'::bytea WHERE id = ${s1.id}`);
    const r = seal('check', exportRows());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('seals=2 valid=1 mismatched=1 ');
    expect(r.stdout).toContain(`seal=${s1.id} result=fingerprint_mismatch`);
  });

  it("NFR-INT-07 FR-REV-06 (RE-3): bytes copied from another seal read mismatch at seal.id, against the row's own id", async () => {
    await withTriggersDisabled('seals', () => testDb.$executeRaw`
      UPDATE seals SET manifest = (SELECT manifest FROM seals WHERE id = ${s1.id}), fingerprint = (SELECT fingerprint FROM seals WHERE id = ${s1.id}) WHERE id = ${s2.id}`);
    const r = seal('check', exportRows());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`seal=${s2.id} result=mismatch first_difference=seal.id`);
  });

  it('NFR-INT-07: an erased field is reported and the run still passes', async () => {
    await asOperator(`SELECT erase_text_field('${fx.org.id}','decision_versions','${v1}','reason','ER-1','INSTR-1')`);
    const r = seal('check', exportRows());
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/erased_fields=[1-9]/);
  });

  it('NFR-INT-07 NFR-PRIV-03: the seal check prints no record text', async () => {
    const markers = (t: string) => t.match(MARKER_PATTERN);
    expect(markers(exportRows()), 'the export holds the markers, so the scan below can fail').not.toBeNull();
    const ok = seal('check', exportRows());
    await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET reason = 'changed' WHERE id = ${v1}`);
    const bad = seal('check', exportRows());
    for (const r of [ok, bad]) expect(markers(r.stdout + r.stderr)).toBeNull();
  });

  it('NFR-INT-05 NFR-INT-07: a session whose zone is not UTC still checks valid', () => {
    for (const tz of ['America/Los_Angeles', 'Africa/Nairobi']) {
      const r = seal('check', exportRows({ PGTZ: tz }));
      expect(r.status, `${tz}: ${r.stdout}`).toBe(0);
    }
  });

  it("NFR-MNT-05 NFR-INT-07: the plan runs exactly the shared module's statements, in UTC, with ids bound", async () => {
    const { SEAL_SOURCE_TABLES, SEAL_SOURCE_SQL } = await import('../../lib/integrity/sealCheck.mjs');
    const keys = [...SEAL_SOURCE_TABLES, 'tombstones'] as const;
    const out = seal('plan', 'o1\no2\n').stdout;
    expect(out.split('\n').slice(0, 2)).toEqual(['BEGIN;', "SET LOCAL TIME ZONE 'UTC';"]);
    expect(out.trimEnd().split('\n').at(-1)).toBe('COMMIT;');
    expect(out.split('\n').filter((l) => l.startsWith('\\echo'))).toEqual(['o1', 'o2'].flatMap((o) => keys.map((k) => `\\echo '#rows ${k} ${o}'`)));
    for (const k of keys) expect(out.split(`${SEAL_SOURCE_SQL[k]} \\bind 'o1' \\g`)).toHaveLength(2);
    expect(readdirSync('ops/host').filter((f) => readFileSync(join('ops/host', f), 'utf8').includes('row_to_json'))).toEqual([]);
  });

  it('NFR-INT-07: the plan refuses an organisation id that is not an id and binds ids as parameters', () => {
    for (const bad of ["o1'; DROP TABLE seals; --", 'o1 \\g', 'x'.repeat(65)]) expect(seal('plan', `${bad}\n`)).toMatchObject({ status: 2, stdout: '' });
  });

  it('NFR-INT-07: with no organisation the plan is empty and the check passes on empty input', () => {
    const plan = seal('plan', '');
    expect(plan.status).toBe(0);
    expect(plan.stdout).toBe("BEGIN;\nSET LOCAL TIME ZONE 'UTC';\nCOMMIT;\n");
    expect(seal('check', '')).toMatchObject({ status: 0, stdout: 'seals=0 valid=0 mismatched=0 erased_fields=0 erased_files=0\n' });
  });

  it('NFR-INT-07: a seal that makes the check throw fails that seal only, and the other seals are still checked', () => {
    const lines = exportRows().split('\n');
    // Damage one seals row so that its manifest cannot be decoded (not `\x` hex text); the other row is intact.
    const at = lines.findIndex((l) => l.startsWith('{') && l.includes(`"id":"${s1.id}"`));
    expect(at).toBeGreaterThan(-1);
    lines[at] = lines[at].replace(/"manifest":"[^"]*"/, '"manifest":"not hex"');
    const r = seal('check', lines.join('\n'));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('seals=2 valid=1 mismatched=1 ');
    expect(r.stdout).toContain(`seal=${s1.id} result=error error=TypeError`);
    expect(r.stdout, 'the message of the error is not printed').not.toMatch(/hex|bytea/i);
  });

  it('NFR-INT-07: a line the check cannot parse exits 2 and prints neither the line nor a count', () => {
    const r = seal('check', '#rows seals o1\n{this is not json ZZMARK-x-1-QX\n');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stdout + r.stderr).not.toContain('ZZMARK');
  });
});
