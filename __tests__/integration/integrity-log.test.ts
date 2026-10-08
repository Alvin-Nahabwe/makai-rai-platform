import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client, type Submittable } from 'pg';
import { entryHash } from '../../ops/host/integrity-hash.mjs';
import { resetDb, testDb } from '../helpers/db';

/**
 * The integrity log (ADR-0010): an append-only, hash-chained table that only the schema
 * owner can write, through `integrity_append`. The console break-glass hook
 * (`ops/host/makrai-break-glass-session`) writes one entry per console login, and the
 * daily reconcile recomputes the chain in Node with `entryHash`.
 *
 * Every check runs as the owner, the role the hook connects as, except the one that
 * shows the two application roles can neither see the table nor call the function.
 *
 * No test here can empty the table: that is the point of it. `resetDb()` leaves it out
 * of its TRUNCATE, so entries from earlier runs stay, and the chain checks below walk
 * the whole table rather than assuming it starts empty.
 */

const MIGRATION = 'prisma/migrations/20261008000200_integrity_log/migration.sql';
const HOOK = 'ops/host/makrai-break-glass-session';
const GENESIS = '0'.repeat(64);
/** The function's own rendering of `at`, read back the same way. */
const AT_UTC = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const COLUMNS = 'id, seq, at, kind, actor_ref, detail, prev_hash, hash';

async function connect(url: string | undefined): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

type Appended = { id: string; seq: string; hash: string };

async function append(su: Client, tty: string): Promise<Appended> {
  const { rows } = await su.query<Appended>(
    `SELECT id, seq, hash FROM integrity_append('break_glass.open', 'console:root',
       jsonb_build_object('channel', 'hetzner-console', 'tty', $1::text))`,
    [tty],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/**
 * COPY over the wire protocol, as psql does when it loads a pg_dump file: `TO STDOUT`
 * returns the data, `FROM STDIN` sends `input`. node-pg runs a COPY only through a
 * custom query object, so this is the smallest one that does. Test-only: no package
 * is added for it.
 */
type Wire = { query(text: string): void; sendCopyFromChunk(chunk: Buffer): void; endCopyFrom(): void };
function copy(client: Client, sql: string, input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const query = {
      submit: (wire: Wire) => wire.query(sql),
      handleCopyInResponse: (wire: Wire) => {
        wire.sendCopyFromChunk(Buffer.from(input, 'utf8'));
        wire.endCopyFrom();
      },
      // A copy: the chunk is a view into node-pg's read buffer, which it reuses, so a
      // kept view is overwritten by later rows once the dump spans enough messages.
      handleCopyData: (msg: { chunk: Buffer }) => void out.push(Buffer.from(msg.chunk)),
      handleReadyForQuery: () => resolve(Buffer.concat(out).toString('utf8')),
      // node-pg drops the active query on an error, so ReadyForQuery never reaches it.
      handleError: (err: Error) => reject(err),
      handleCommandComplete: () => {},
      handleRowDescription: () => {},
      handleDataRow: () => {},
      handleEmptyQuery: () => {},
      handlePortalSuspended: () => {},
    };
    client.query(query as unknown as Submittable);
  });
}

/**
 * The hook's own SQL, taken from its `<<'SQL'` heredoc, so these tests run what the hook
 * runs. psql fills `:'name'` from `\set`; here each is filled as a quoted literal, and
 * the `\gset` that keeps psql's output clean is dropped.
 */
function hookSql(client: Client, vars: Record<string, string>): { deadline: string; append: string; recipients: string } {
  const body = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(readFileSync(HOOK, 'utf8'))?.[1];
  expect(body, "no <<'SQL' heredoc in the hook").toBeDefined();
  const fill = (line: string) =>
    line.replace(/\s*\\gset$/, '').replace(/:'(\w+)'/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`the hook's SQL needs :'${name}'`);
      return client.escapeLiteral(vars[name]);
    });
  const lines = (body as string).split('\n').map((l) => l.trim()).filter(Boolean);
  const one = (re: RegExp) => {
    const hits = [...new Set(lines.filter((l) => re.test(l)))];
    expect(hits, String(re)).toHaveLength(1);
    return fill(hits[0]);
  };
  return {
    deadline: one(/set_config\('statement_timeout'/),
    append: one(/integrity_append\(/),
    recipients: one(/u\.email/),
  };
}

const deadlineIn = (ms: number) => ({ deadline_ms: String(Date.now() + ms), user: 'root', tty: 'tty1' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the integrity log (ADR-0010)', () => {
  it('chains entries and matches entryHash', async () => {
    const su = await connect(process.env.DATABASE_URL);
    try {
      // A session zone 5 h 45 min off UTC, so the function's `AT TIME ZONE 'UTC'` is
      // what makes its rendering of `at` agree with the one read back below.
      await su.query("SET TIME ZONE 'Asia/Kathmandu'");
      const first = await append(su, 'tty1');
      // Non-ASCII on purpose: the database hashes convert_to(..., 'UTF8') and Node hashes
      // UTF-8, and only a character outside ASCII shows the two encodings agree.
      const second = await append(su, 'tty-é');

      const { rows } = await su.query<{
        id: string; seq: string; prev_hash: string; hash: string;
        at_utc: string; kind: string; actor_ref: string; detail_text: string;
      }>(
        `SELECT id, seq, prev_hash, hash, ${AT_UTC} AS at_utc, kind, actor_ref, detail::text AS detail_text
         FROM integrity_log ORDER BY seq`,
      );

      // The second entry is the next one, and it carries the first one's hash.
      expect(Number(second.seq)).toBe(Number(first.seq) + 1);
      const secondRow = rows.find((r) => r.id === second.id);
      expect(secondRow?.prev_hash).toBe(first.hash);
      expect(rows.find((r) => r.id === first.id)?.hash).toBe(first.hash);
      expect(secondRow?.hash).toBe(second.hash);
      expect(secondRow).toMatchObject({ kind: 'break_glass.open', actor_ref: 'console:root' });
      expect(JSON.parse(secondRow!.detail_text)).toEqual({ channel: 'hetzner-console', tty: 'tty-é' });

      // `at` holds no digit below the millisecond, which the hash does not cover.
      const subMs = await su.query<{ n: string }>(
        'SELECT count(*) AS n FROM integrity_log WHERE extract(microseconds FROM at)::bigint % 1000 <> 0',
      );
      expect(subMs.rows[0].n).toBe('0');

      // The whole table is one chain from the genesis, and every stored hash is the
      // one Node computes from the row.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      rows.forEach((r, i) => {
        const where = `seq ${r.seq}`;
        expect(Number(r.seq), where).toBe(i + 1);
        expect(r.prev_hash, where).toBe(i === 0 ? GENESIS : rows[i - 1].hash);
        expect(r.hash, where).toMatch(/^[0-9a-f]{64}$/);
        expect(
          entryHash({
            prevHash: r.prev_hash, seq: Number(r.seq), atUtc: r.at_utc,
            kind: r.kind, actorRef: r.actor_ref, detailText: r.detail_text,
          }),
          where,
        ).toBe(r.hash);
      });
    } finally {
      await su.end();
    }
  });

  it('serialises concurrent appends into one gapless chain', async () => {
    // Each append reads the last entry and writes the next. Without the table lock, two
    // that overlap read the same last entry and the second fails on the unique seq.
    const clients = await Promise.all(Array.from({ length: 12 }, () => connect(process.env.DATABASE_URL)));
    try {
      const last = async () =>
        Number((await clients[0].query<{ n: string }>('SELECT coalesce(max(seq), 0) AS n FROM integrity_log')).rows[0].n);
      for (let round = 0; round < 3; round += 1) {
        const before = await last();
        const appended = await Promise.all(clients.map((c, i) => append(c, `tty${i}`)));
        expect(appended.map((a) => Number(a.seq)).sort((a, b) => a - b))
          .toEqual(clients.map((_, i) => before + 1 + i));
        const { rows } = await clients[0].query<{ seq: string; prev_hash: string; hash: string }>(
          'SELECT seq, prev_hash, hash FROM integrity_log WHERE seq >= $1 ORDER BY seq', [Math.max(before, 1)],
        );
        for (let i = 1; i < rows.length; i += 1) expect(rows[i].prev_hash, `seq ${rows[i].seq}`).toBe(rows[i - 1].hash);
      }
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('refuses update, delete and truncate', async () => {
    const su = await connect(process.env.DATABASE_URL);
    try {
      await append(su, 'tty1');
      const count = async () => (await su.query<{ n: string }>('SELECT count(*) AS n FROM integrity_log')).rows[0].n;
      const before = await count();
      // The owner is a superuser, which grants cannot stop. The trigger does. It is
      // statement-level, so a statement that would touch no row is refused too.
      for (const stmt of [
        'UPDATE integrity_log SET kind = kind',
        "UPDATE integrity_log SET hash = repeat('0', 64) WHERE seq = (SELECT max(seq) FROM integrity_log)",
        'DELETE FROM integrity_log',
        'DELETE FROM integrity_log WHERE false',
        'TRUNCATE integrity_log',
      ]) {
        await expect(su.query(stmt), stmt).rejects.toThrow(/integrity_log is append-only/);
      }
      expect(await count()).toBe(before);
    } finally {
      await su.end();
    }
  });

  it('refuses them under session_replication_role = replica too', async () => {
    // A superuser can silence ordinary triggers with this setting alone, no DDL. The
    // trigger is ENABLE ALWAYS, so it fires anyway. Inside a transaction that is rolled
    // back, so a regression here cannot empty the table for the tests after it.
    const su = await connect(process.env.DATABASE_URL);
    try {
      await append(su, 'tty1');
      await su.query('BEGIN');
      await su.query("SET LOCAL session_replication_role = 'replica'");
      for (const stmt of ['UPDATE integrity_log SET kind = kind', 'DELETE FROM integrity_log', 'TRUNCATE integrity_log']) {
        await su.query('SAVEPOINT probe');
        await expect(su.query(stmt), stmt).rejects.toThrow(/integrity_log is append-only/);
        await su.query('ROLLBACK TO SAVEPOINT probe');
      }
    } finally {
      await su.query('ROLLBACK');
      await su.end();
    }
  });

  it('is invisible to the application roles', async () => {
    for (const [lane, url] of [
      ['APP', process.env.APP_DATABASE_URL],
      ['IDENTITY', process.env.IDENTITY_DATABASE_URL],
    ] as const) {
      const c = await connect(url);
      try {
        for (const stmt of [
          'SELECT count(*) FROM integrity_log',
          `INSERT INTO integrity_log (seq, kind, actor_ref, detail, prev_hash, hash)
             VALUES (999999, 'x', 'x', '{}', repeat('0', 64), repeat('0', 64))`,
          'UPDATE integrity_log SET kind = kind',
          'DELETE FROM integrity_log',
          'TRUNCATE integrity_log',
        ]) {
          await expect(c.query(stmt), `${lane}: ${stmt}`).rejects.toThrow(/permission denied for table integrity_log/);
        }
        await expect(
          c.query(`SELECT * FROM integrity_append('break_glass.open', 'console:root', '{}'::jsonb)`),
          `${lane}: integrity_append`,
        ).rejects.toThrow(/permission denied for function/);
      } finally {
        await c.end();
      }
    }
  });

  /**
   * Task 6's restore test loads a plain pg_dump into a fresh cluster with psql. pg_dump
   * writes each table's rows as `COPY ... FROM stdin` and creates triggers afterwards,
   * in its post-data section, so during a real restore the table has no trigger yet.
   * This is stricter: the migration runs first, into an empty scratch schema, so the
   * trigger is already in place when the rows arrive. COPY inserts; the trigger refuses
   * only UPDATE, DELETE and TRUNCATE, so the load succeeds and the restored table is
   * append-only from then on.
   */
  it('restores by COPY into an empty integrity_log, which then refuses update, delete and truncate', async () => {
    const su = await connect(process.env.DATABASE_URL);
    try {
      await append(su, 'tty1');
      await append(su, 'ttyS0');
      await su.query('DROP SCHEMA IF EXISTS zz_restore_probe CASCADE');
      await su.query('CREATE SCHEMA zz_restore_probe');
      await su.query('SET search_path TO zz_restore_probe');
      await su.query(readFileSync(MIGRATION, 'utf8'));
      await su.query('SET search_path TO public');

      const empty = await su.query('SELECT 1 FROM zz_restore_probe.integrity_log');
      expect(empty.rowCount, 'the scratch table must start empty').toBe(0);
      const triggers = await su.query(
        `SELECT 1 FROM pg_trigger WHERE tgrelid = 'zz_restore_probe.integrity_log'::regclass AND NOT tgisinternal`,
      );
      expect(triggers.rowCount, 'the scratch table must already carry the trigger').toBe(1);

      // pg_dump's own statements, against the live table and then the scratch one.
      const dump = await copy(su, `COPY public.integrity_log (${COLUMNS}) TO STDOUT`);
      expect(dump.trim().split('\n').length).toBeGreaterThanOrEqual(2);
      await copy(su, `COPY zz_restore_probe.integrity_log (${COLUMNS}) FROM STDIN`, dump);

      const asText = (schema: string) =>
        `SELECT id::text, seq::text, at::text, kind, actor_ref, detail::text, prev_hash, hash
         FROM ${schema}.integrity_log ORDER BY seq`;
      const restored = (await su.query(asText('zz_restore_probe'))).rows;
      expect(restored.length).toBeGreaterThanOrEqual(2);
      expect(restored).toEqual((await su.query(asText('public'))).rows);

      for (const stmt of [
        'UPDATE zz_restore_probe.integrity_log SET kind = kind',
        'DELETE FROM zz_restore_probe.integrity_log',
        'TRUNCATE zz_restore_probe.integrity_log',
      ]) {
        await expect(su.query(stmt), stmt).rejects.toThrow(/integrity_log is append-only/);
      }
    } finally {
      // DROP is not one of the refused statements, so the probe can always be removed.
      await su.query('DROP SCHEMA IF EXISTS zz_restore_probe CASCADE');
      await su.end();
    }
  });
});

describe("the hook's SQL, run against the schema", () => {
  it('notifies the active owners and admins of live organisations, and no one else', async () => {
    await resetDb();
    const org = (slug: string, deletedAt: Date | null = null) =>
      testDb.organization.create({ data: { name: slug, slug, deletedAt } });
    const user = (email: string, isActive = true) =>
      testDb.user.create({ data: { email, name: email, passwordHash: 'x', isActive } });
    const member = (orgId: string, userId: string, role: 'owner' | 'admin' | 'assessor' | 'reviewer' | 'viewer',
      status: 'active' | 'suspended' = 'active') => testDb.membership.create({ data: { orgId, userId, role, status } });

    const live = await org('bg-live');
    const live2 = await org('bg-live-2');
    const gone = await org('bg-gone', new Date());

    const ownerLive = await user('owner-live@bg.invalid');
    const adminLive = await user('admin-live@bg.invalid');
    const both = await user('owner-gone-admin-live@bg.invalid');
    const ownerGone = await user('owner-gone@bg.invalid');
    const adminGone = await user('admin-gone@bg.invalid');
    const suspended = await user('suspended-admin@bg.invalid');
    const inactive = await user('inactive-owner@bg.invalid', false);
    const others = await Promise.all(['assessor', 'reviewer', 'viewer'].map((r) => user(`${r}@bg.invalid`)));

    await member(live.id, ownerLive.id, 'owner');
    await member(live2.id, ownerLive.id, 'owner'); // owner of two: listed once
    await member(live.id, adminLive.id, 'admin');
    await member(gone.id, both.id, 'owner');
    await member(live2.id, both.id, 'admin'); // still admin of a live one: listed
    await member(gone.id, ownerGone.id, 'owner');
    await member(gone.id, adminGone.id, 'admin');
    await member(live.id, suspended.id, 'admin', 'suspended');
    await member(live.id, inactive.id, 'owner');
    await member(live.id, others[0].id, 'assessor');
    await member(live.id, others[1].id, 'reviewer');
    await member(live.id, others[2].id, 'viewer');

    const su = await connect(process.env.DATABASE_URL);
    try {
      const { rows } = await su.query<{ email: string }>(hookSql(su, deadlineIn(10_000)).recipients);
      expect(rows.map((r) => r.email).sort()).toEqual(
        ['admin-live@bg.invalid', 'owner-gone-admin-live@bg.invalid', 'owner-live@bg.invalid'],
      );
    } finally {
      await su.end();
      await resetDb();
    }
  });

  it("cancels an append that misses the hook's deadline, so nothing lands after the hook gives up", async () => {
    const blocker = await connect(process.env.DATABASE_URL);
    const su = await connect(process.env.DATABASE_URL);
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE integrity_log IN ACCESS EXCLUSIVE MODE');
      const before = (await blocker.query<{ n: string }>('SELECT count(*) AS n FROM integrity_log')).rows[0].n;

      const sql = hookSql(su, deadlineIn(1000));
      await su.query(sql.deadline);
      const t0 = Date.now();
      await expect(su.query(sql.append)).rejects.toThrow(/canceling statement due to statement timeout/);
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThan(500);
      expect(waited).toBeLessThan(2000);

      await blocker.query('ROLLBACK');
      await sleep(300);
      const after = (await su.query<{ n: string }>('SELECT count(*) AS n FROM integrity_log')).rows[0].n;
      expect(after, 'the cancelled append landed after all').toBe(before);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
      await su.end();
    }
  });

  it('an application role cannot stall an append', async () => {
    const su = await connect(process.env.DATABASE_URL);
    try {
      for (const [lane, url] of [
        ['APP', process.env.APP_DATABASE_URL],
        ['IDENTITY', process.env.IDENTITY_DATABASE_URL],
      ] as const) {
        const c = await connect(url);
        try {
          // The append serialises on a table lock, and no lock mode on the table is
          // open to a role with no privilege on it.
          await c.query('BEGIN');
          await expect(c.query('LOCK TABLE integrity_log IN ACCESS SHARE MODE'), lane)
            .rejects.toThrow(/permission denied for table integrity_log/);
          await c.query('ROLLBACK');

          // An advisory lock is open to every role. Holding the key once used for this
          // serialisation stalls nothing now.
          await c.query("SELECT pg_advisory_lock(hashtext('integrity_log'))");
          const sql = hookSql(su, deadlineIn(2000));
          await su.query(sql.deadline);
          const { rows } = await su.query(sql.append);
          expect(rows, lane).toHaveLength(1);
        } finally {
          await c.query('SELECT pg_advisory_unlock_all()').catch(() => {});
          await c.end();
        }
      }
    } finally {
      await su.end();
    }
  });

  it('an application lane can cost the notice its owner list, never the entry', async () => {
    // makrai_app holds UPDATE and DELETE on memberships, and makrai_identity UPDATE on
    // users (ADR-0009), so each can lock a table the recipients query reads. The append
    // runs first and reads neither, so it lands; only the owner list is lost, and the
    // hook then logs notice=failed:recipients and still mails ADMIN_EMAIL.
    const su = await connect(process.env.DATABASE_URL);
    try {
      for (const [lane, url, table] of [
        ['APP', process.env.APP_DATABASE_URL, 'memberships'],
        ['IDENTITY', process.env.IDENTITY_DATABASE_URL, 'users'],
      ] as const) {
        const c = await connect(url);
        try {
          await c.query('BEGIN');
          await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
          const sql = hookSql(su, deadlineIn(1500));
          await su.query(sql.deadline);
          const appended = await su.query<{ id: string }>(sql.append);
          expect(appended.rows, lane).toHaveLength(1);
          await su.query(sql.deadline);
          await expect(su.query(sql.recipients), lane).rejects.toThrow(/canceling statement due to statement timeout/);
          await c.query('ROLLBACK');

          await su.query('RESET statement_timeout');
          const landed = await su.query('SELECT 1 FROM integrity_log WHERE id = $1', [appended.rows[0].id]);
          expect(landed.rowCount, lane).toBe(1);
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          await c.end();
        }
      }
    } finally {
      await su.end();
    }
  });
});
