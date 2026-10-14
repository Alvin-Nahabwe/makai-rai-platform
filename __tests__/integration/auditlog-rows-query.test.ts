import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { entryHash } from '../../ops/host/integrity-hash.mjs';

/**
 * The nightly audit reconcile's integrity_log query (ops/host/makrai-auditlog-reconcile.sh, Task
 * 22), run on a real Postgres exactly as the script hands it to psql, and the rows it returns
 * run through the real ops/host/auditlog.mjs.
 *
 * The query must read ONE contiguous seq range (L3-2): from the row after the stored seq, or from
 * the first row dated in the window's reach, whichever is lower. Read as "after the stored seq OR
 * in the window", a clock step leaves a hole between the two sets, and an intact chain reports a
 * break every night.
 *
 * The scenarios are the re-review's (task-22-rereview-3.json, L3-2, chain-repro):
 *   A  a break-glass row written while the clock ran 10 days ahead (row 4, stamped Oct 15 but
 *      written Oct 5), the clock then corrected;
 *   B  the clock stepped back 3 h between rows 2 and 3, after which seq 3 was stored.
 *
 * The rows live in a temporary table named integrity_log, which shadows the real one for this
 * session only: the real table is append-only and stamps `at` itself, and these scenarios need
 * rows whose `at` disagrees with their seq order.
 */

const SCRIPT = path.resolve('ops/host/makrai-auditlog-reconcile.sh');
const CLI = path.resolve('ops/host/auditlog.mjs');
const GENESIS = '0'.repeat(64);
const FP = `SHA256:${'A'.repeat(43)}`;
const TOL = 300;
const DETAIL = '{"tty": "tty1"}';

type Row = { seq: number; prevHash: string; hash: string; atUtc: string; kind: string; actorRef: string; detailText: string };

function chain(times: string[]): Row[] {
  const rows: Row[] = [];
  let prev = GENESIS;
  times.forEach((atUtc, i) => {
    const r = { seq: i + 1, prevHash: prev, atUtc, kind: 'break_glass.open', actorRef: 'console:root', detailText: DETAIL };
    const hash = entryHash(r);
    rows.push({ ...r, hash });
    prev = hash;
  });
  return rows;
}

/** The script's query text, with psql's :'name' variables as the quoted literals psql makes them. */
function scriptQuery(vars: Record<string, string>): string {
  const m = /\n(with w as \([\s\S]*?)\nSQL\n/.exec(readFileSync(SCRIPT, 'utf8'));
  expect(m, 'the reconcile script holds its integrity_log query').not.toBeNull();
  let sql = (m as RegExpExecArray)[1];
  for (const [k, v] of Object.entries(vars)) {
    expect(v).not.toContain("'");
    sql = sql.replaceAll(`:'${k}'`, `'${v}'`);
  }
  expect(sql, 'every psql variable is given').not.toContain(":'");
  return sql;
}

const usAt = (iso: string) => String(Date.parse(iso) * 1000);
const rec = (f: Record<string, string>) => `${Object.entries(f).map(([k, v]) => `${k}=${v}`).join('\n')}\n\n`;
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** Each row's console login 2 s before it and its shipped line 15 s after, by the clock that wrote it. */
function journalFor(rows: Row[]): string {
  return rows
    .flatMap((r) => [
      rec({ __REALTIME_TIMESTAMP: usAt(shift(r.atUtc, -2_000)), _PID: String(1000 + r.seq), _COMM: 'login', MESSAGE: 'pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)' }),
      rec({ __REALTIME_TIMESTAMP: usAt(shift(r.atUtc, 15_000)), _PID: String(2000 + r.seq), _COMM: 'logger', SYSLOG_IDENTIFIER: 'makrai-break-glass', MESSAGE: `entry=0f8fad5b-d9cb-469f-a165-70867728950e seq=${r.seq} hash=${r.hash} notice=sent` }),
    ])
    .join('');
}

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    `CREATE TEMP TABLE integrity_log (seq bigint PRIMARY KEY, prev_hash text NOT NULL, hash text NOT NULL,
       at timestamptz NOT NULL, kind text NOT NULL, actor_ref text NOT NULL, detail jsonb NOT NULL)`,
  );
});

afterAll(async () => {
  await client?.end();
});

type Night = { rows: Row[]; written: number; since: string; until: string; now: string; stateSeq: number | null; checkedUntil: string | null };

/**
 * One night: the table holds the first `written` rows (rows are appended in seq order), the
 * script's query selects from it, and the CLI reconciles what it selected.
 */
async function night(n: Night) {
  const table = n.rows.slice(0, n.written);
  await client.query('TRUNCATE integrity_log');
  for (const r of table) {
    await client.query('INSERT INTO integrity_log VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)', [r.seq, r.prevHash, r.hash, r.atUtc, r.kind, r.actorRef, r.detailText]);
  }
  const rowsFrom = new Date(Date.parse(n.since) - TOL * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const res = await client.query(scriptQuery({ rows_from: rowsFrom, until: n.until, state_seq: String(n.stateSeq ?? 0) }));
  const db = Object.values(res.rows[0])[0] as { rows: Row[]; anchor: Row | null; stateRow: Row | null; maxSeq: number };
  const stateRow = n.stateSeq === null ? null : table[n.stateSeq - 1];
  const input = {
    since: n.since,
    until: n.until,
    toleranceSec: TOL,
    twoFactorSinceB64: null,
    verboseSinceB64: null,
    allowedKeysB64: Buffer.from(`${FP} operator\n`).toString('base64'),
    state: stateRow === null ? null : { seq: stateRow.seq, hash: stateRow.hash },
    checkedUntil: n.checkedUntil,
    futureNamedFiles: 0,
    now: n.now,
    db,
    journalB64: Buffer.from(journalFor(table)).toString('base64'),
  };
  const r = spawnSync(process.execPath, [CLI, 'reconcile'], { input: JSON.stringify(input), encoding: 'utf8' });
  expect(r.stderr).toBe('');
  const counts = Object.fromEntries(
    r.stdout
      .split('\n')[0]
      .split(' ')
      .map((p) => p.split('='))
      .map(([k, v]) => [k, Number(v)]),
  ) as Record<string, number>;
  return { status: r.status, counts, selected: db.rows.map((x) => x.seq), anchor: db.anchor?.seq ?? null };
}

const FAILURE_FIELDS = ['consoleLoginsWithoutEntry', 'entriesWithoutLogin', 'unknownKeyLogins', 'singleFactorLogins', 'chainBreaks', 'hashMismatches', 'noticeFailures', 'sudoToRoot', 'rowsWithoutShipped', 'backdatedRows', 'futureRows'];
const zeros = Object.fromEntries(FAILURE_FIELDS.map((f) => [f, 0]));
const failures = (counts: Record<string, number>) => Object.fromEntries(FAILURE_FIELDS.map((f) => [f, counts[f]]));

describe('the reconcile reads integrity_log as one contiguous seq range (L3-2)', () => {
  // A: rows 1-3 on Oct 1-3; row 4 written Oct 5 with the clock 10 days ahead; then the clock
  // corrected, rows 5-22 two a day from Oct 6 to Oct 14, and row 23 on Oct 15 at noon.
  const timesA = ['2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z', '2026-10-03T10:00:00.000Z', '2026-10-15T10:00:00.000Z'];
  for (let d = 6; d <= 14; d += 1) timesA.push(`2026-10-${String(d).padStart(2, '0')}T08:00:00.000Z`, `2026-10-${String(d).padStart(2, '0')}T09:00:00.000Z`);
  timesA.push('2026-10-15T12:00:00.000Z');
  const allA = chain(timesA);

  it('fails the night after the jump on futureRows, not on a chain break', async () => {
    const r = await night({ rows: allA, written: 4, since: '2026-10-05T00:00:00Z', until: '2026-10-06T01:05:00Z', now: '2026-10-06T02:00:01Z', stateSeq: 3, checkedUntil: '2026-10-05T01:00:00Z' });
    expect(r.selected).toEqual([4]);
    expect(r.anchor).toBe(3);
    expect(failures(r.counts)).toEqual({ ...zeros, futureRows: 1 });
    expect(r.status).toBe(1);
  });

  it.each([
    ['A0, the night of Oct 15, before row 4 comes back', { written: 22, since: '2026-10-14T00:00:00Z', until: '2026-10-15T01:55:00Z', now: '2026-10-15T02:00:01Z', stateSeq: 20, checkedUntil: '2026-10-14T01:50:00Z' }, [21, 22]],
    ['A1, the night of Oct 16, when row 4 comes back by time below the stored seq', { written: 23, since: '2026-10-15T00:00:00Z', until: '2026-10-16T01:55:00Z', now: '2026-10-16T02:00:01Z', stateSeq: 22, checkedUntil: '2026-10-15T01:50:00Z' }, null],
    ['A2, the night of Oct 17', { written: 23, since: '2026-10-15T01:45:00Z', until: '2026-10-17T01:55:00Z', now: '2026-10-17T02:00:01Z', stateSeq: 22, checkedUntil: '2026-10-15T01:50:00Z' }, null],
    ['A3, the night of Oct 22', { written: 23, since: '2026-10-15T01:45:00Z', until: '2026-10-22T01:55:00Z', now: '2026-10-22T02:00:01Z', stateSeq: 22, checkedUntil: '2026-10-15T01:50:00Z' }, null],
    ['A4, a --since at the stored checked_until', { written: 23, since: '2026-10-15T01:50:00Z', until: '2026-10-22T01:55:00Z', now: '2026-10-22T02:00:01Z', stateSeq: 22, checkedUntil: '2026-10-15T01:50:00Z' }, null],
  ])('passes %s, with no chain break', async (_name, n, selected) => {
    const r = await night({ rows: allA, ...n });
    // From row 4 on, the range is unbroken: rows 5 to 22, below the stored seq and outside the
    // band, are read for the chain and count for nothing else.
    expect(r.selected).toEqual(selected ?? Array.from({ length: 20 }, (_, i) => 4 + i));
    expect(failures(r.counts)).toEqual(zeros);
    expect(r.status).toBe(0);
  });

  // B: the clock stepped back 3 h between rows 2 and 3 (row 3 is stamped before row 2).
  const allB = chain(['2026-10-14T10:00:00.000Z', '2026-10-14T23:58:00.000Z', '2026-10-14T21:00:00.000Z', '2026-10-15T12:00:00.000Z']);

  it.each([
    ['B0, the night that stores seq 3', { written: 3, since: '2026-10-14T00:00:00Z', until: '2026-10-15T01:55:00Z', now: '2026-10-15T02:00:01Z', stateSeq: 1, checkedUntil: '2026-10-14T01:50:00Z' }, [1, 2, 3], null],
    ['B1, the next night, with the stored row back-dated', { written: 4, since: '2026-10-15T00:00:00Z', until: '2026-10-16T01:55:00Z', now: '2026-10-16T02:00:01Z', stateSeq: 3, checkedUntil: '2026-10-15T01:50:00Z' }, [2, 3, 4], 1],
  ])('passes %s, with no chain break', async (_name, n, selected, anchor) => {
    const r = await night({ rows: allB, ...n });
    expect(r.selected).toEqual(selected);
    expect(r.anchor).toBe(anchor);
    expect(failures(r.counts)).toEqual(zeros);
    expect(r.status).toBe(0);
  });

  it('still reads every row when no state is stored', async () => {
    const r = await night({ rows: allB, written: 4, since: '2026-10-15T00:00:00Z', until: '2026-10-16T01:55:00Z', now: '2026-10-16T02:00:01Z', stateSeq: null, checkedUntil: null });
    expect(r.selected).toEqual([1, 2, 3, 4]);
    expect(r.anchor).toBeNull();
  });
});
