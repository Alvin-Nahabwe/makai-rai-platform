import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client, type Submittable } from 'pg';
import { entryHash } from '../../ops/host/integrity-hash.mjs';

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
      handleCopyData: (msg: { chunk: Buffer }) => void out.push(msg.chunk),
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

describe('the integrity log (ADR-0010)', () => {
  it('chains entries and matches entryHash', async () => {
    const su = await connect(process.env.DATABASE_URL);
    try {
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
