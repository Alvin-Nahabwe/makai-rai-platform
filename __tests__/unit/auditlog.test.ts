import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  allowedFrom,
  consoleLoginsFrom,
  countsLine,
  expiredNames,
  failed,
  joinContinued,
  parseExport,
  passwordChangesFrom,
  reconcile,
  shippedFrom,
  sshLoginsFrom,
  sudoFrom,
} from '../../ops/host/auditlog.mjs';
import { entryHash } from '../../ops/host/integrity-hash.mjs';

/**
 * ops/host/auditlog.mjs: the daily reconcile of the host's shipped audit log against the
 * integrity log (RL 7.13; Task 22). The reconcile script runs it inside the web image with
 * `--network none`, so it is built-ins only and is tested here as plain functions, then once
 * end to end through its command line.
 *
 * Every value here is synthetic: addresses from 203.0.113.0/24 and 192.0.2.0/24
 * (RFC 5737), fingerprints made of one repeated letter, and no real account.
 */

const FP_OPERATOR = `SHA256:${'A'.repeat(43)}`;
const FP_STRANGER = `SHA256:${'B'.repeat(43)}`;
const GENESIS = '0'.repeat(64);
const SWITCH = '2026-10-14T09:35:12Z';
/** When LogLevel VERBOSE went in (Task 22 install A): /etc/makrai/ssh-verbose-since. */
const VERBOSE = '2026-10-14T12:00:00Z';
const ALLOWED = [{ fingerprint: FP_OPERATOR, label: 'operator' }];

type Row = { seq: number; prevHash: string; hash: string; atUtc: string; kind: string; actorRef: string; detailText: string };
type SshLogin = { at: string; user: string; fingerprint: string | null; methods: string[] };
type Shipped = { entry: string; seq: number; hash: string; notice: string; at?: string };

/** A valid chain from the genesis, one break_glass.open entry per time given. */
function chain(times: string[], firstSeq = 1, firstPrev = GENESIS): Row[] {
  const rows: Row[] = [];
  let prev = firstPrev;
  times.forEach((atUtc, i) => {
    const r = {
      seq: firstSeq + i,
      prevHash: prev,
      atUtc,
      kind: 'break_glass.open',
      actorRef: 'console:root',
      detailText: '{"tty": "tty1", "channel": "hetzner-console"}',
    };
    const hash = entryHash(r);
    rows.push({ ...r, hash });
    prev = hash;
  });
  return rows;
}

/** The shipped journal line for each row, as the hook writes it 15 s later, with the notice sent. */
const shippedFor = (rows: Row[]): Shipped[] =>
  rows.map((r, i) => ({
    entry: `0000000${i}-0000-4000-8000-000000000000`,
    seq: r.seq,
    hash: r.hash,
    notice: 'sent',
    at: new Date(Date.parse(r.atUtc) + 15_000).toISOString(),
  }));

const goodLogin = (at: string): SshLogin => ({ at, user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey', 'keyboard-interactive/pam'] });

/** One console break-glass login with its entry, and one two-factor SSH login: a clean day. */
function cleanDay() {
  const rows = chain(['2026-10-15T09:00:05.123Z']);
  return {
    sshLogins: [goodLogin('2026-10-15T10:00:00.000Z')],
    consoleLogins: [{ at: '2026-10-15T09:00:03.000Z', user: 'root' }],
    twoFactorSince: SWITCH as string | null,
    passwordChanges: [] as { at: string; user: string }[],
    sudo: [] as { at: string; user: string; target: string }[],
    shipped: shippedFor(rows),
    rows,
    allowed: ALLOWED,
    verboseSince: VERBOSE as string | null,
    // No flag band: every item counts. The window tests below set one.
    window: null as { from: string; to: string } | null,
    anchor: null as Row | null,
    state: null as { seq: number; hash: string } | null,
    stateRow: null as Row | null,
    maxSeq: 1 as number | null,
  };
}

describe('reconcile: console logins and break-glass entries', () => {
  it('passes a clean day, so every other test here changes one thing', () => {
    const r = reconcile(cleanDay());
    expect(r.matched).toBe(1);
    expect(failed(r)).toBe(false);
    expect(countsLine(r)).toBe(
      'matched=1 consoleLoginsWithoutEntry=0 entriesWithoutLogin=0 unknownKeyLogins=0 singleFactorLogins=0 ' +
        'chainBreaks=0 hashMismatches=0 noticeFailures=0 sudoToRoot=0 operatorSessions=1 rootPasswordChanges=0 ' +
        'rowsWithoutShipped=0 preVerboseLogins=0 backdatedRows=0 futureRows=0',
    );
  });

  it('matches a console break-glass login to its entry within 5 minutes', () => {
    // 4 min 47 s apart: inside the tolerance.
    const near = cleanDay();
    near.rows = chain(['2026-10-15T09:04:50.000Z']);
    near.shipped = shippedFor(near.rows);
    const r = reconcile(near);
    expect(r.matched).toBe(1);
    expect(r.consoleLoginsWithoutEntry).toEqual([]);
    expect(r.entriesWithoutLogin).toEqual([]);

    // 5 min 7 s apart: outside it, so neither side is matched.
    const far = cleanDay();
    far.rows = chain(['2026-10-15T09:05:10.000Z']);
    far.shipped = shippedFor(far.rows);
    const f = reconcile(far);
    expect(f.matched).toBe(0);
    expect(f.consoleLoginsWithoutEntry).toHaveLength(1);
    expect(f.entriesWithoutLogin).toHaveLength(1);
    expect(failed(f)).toBe(true);

    // The tolerance is a parameter: 600 s matches the far pair.
    expect(reconcile(far, 600).matched).toBe(1);
  });

  it('flags a console login with no entry, for any user', () => {
    for (const user of ['root', 'operator', 'nobody']) {
      const day = cleanDay();
      day.consoleLogins = [...day.consoleLogins, { at: '2026-10-15T15:30:00.000Z', user }];
      const r = reconcile(day);
      expect(r.matched).toBe(1);
      expect(r.consoleLoginsWithoutEntry).toEqual([{ at: '2026-10-15T15:30:00.000Z', user }]);
      expect(failed(r)).toBe(true);
    }
  });

  it('flags an entry with no console login', () => {
    // An entry appended by hand, as the schema owner, with no console session behind it.
    const day = cleanDay();
    day.consoleLogins = [];
    const r = reconcile(day);
    expect(r.matched).toBe(0);
    expect(r.entriesWithoutLogin).toEqual([{ seq: 1, at: '2026-10-15T09:00:05.123Z' }]);
    expect(failed(r)).toBe(true);
  });

  it('pairs one login with one entry, never one entry with two logins', () => {
    const day = cleanDay();
    day.consoleLogins = [...day.consoleLogins, { at: '2026-10-15T09:00:07.000Z', user: 'root' }];
    const r = reconcile(day);
    expect(r.matched).toBe(1);
    expect(r.consoleLoginsWithoutEntry).toHaveLength(1);
  });
});

describe('sshLoginsFrom', () => {
  // OpenSSH 9.6 at LogLevel VERBOSE, after the Task 23 switch: the key is a partial success,
  // then keyboard-interactive (the TOTP code) is accepted, on the same sshd pid.
  const PARTIAL = `Partial publickey for root from 203.0.113.7 port 50022 ssh2: ED25519 ${FP_OPERATOR}`;
  const ACCEPT_KI = 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2';

  it('pairs a partial publickey line with its keyboard-interactive acceptance by sshd pid', () => {
    const logins = sshLoginsFrom([
      { at: '2026-10-15T10:00:00.000Z', pid: 4242, message: 'Connection from 203.0.113.7 port 50022 on 192.0.2.10 port 22 rdomain ""' },
      { at: '2026-10-15T10:00:00.100Z', pid: 4242, message: PARTIAL },
      { at: '2026-10-15T10:00:00.200Z', pid: 4242, message: 'Postponed keyboard-interactive for root from 203.0.113.7 port 50022 ssh2 [preauth]' },
      // Another login, on another pid, lands between the two lines and stays separate.
      { at: '2026-10-15T10:00:01.000Z', pid: 5151, message: `Accepted publickey for root from 203.0.113.8 port 50100 ssh2: ED25519 ${FP_STRANGER}` },
      { at: '2026-10-15T10:00:09.000Z', pid: 4242, message: ACCEPT_KI },
    ]);
    expect(logins).toEqual([
      { at: '2026-10-15T10:00:01.000Z', user: 'root', fingerprint: FP_STRANGER, methods: ['publickey'] },
      { at: '2026-10-15T10:00:09.000Z', user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey', 'keyboard-interactive/pam'] },
    ]);
  });

  it('reads a pre-switch login from its single Accepted publickey line', () => {
    expect(
      sshLoginsFrom([{ at: '2026-10-13T08:00:00.000Z', pid: 77, message: `Accepted publickey for root from 203.0.113.7 port 40000 ssh2: ED25519 ${FP_OPERATOR}` }]),
    ).toEqual([{ at: '2026-10-13T08:00:00.000Z', user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey'] }]);
  });

  it('gives no fingerprint to a login whose lines carry none', () => {
    // LogLevel INFO after the switch: only the Accepted line, which names no key.
    expect(sshLoginsFrom([{ at: '2026-10-15T10:00:09.000Z', pid: 9, message: ACCEPT_KI }])).toEqual([
      { at: '2026-10-15T10:00:09.000Z', user: 'root', fingerprint: null, methods: ['keyboard-interactive/pam'] },
    ]);
  });

  it('ignores what it does not pair: bots, failures, and a partial success that never logged in', () => {
    const logins = sshLoginsFrom([
      { at: '2026-10-15T03:00:00.000Z', pid: 600, message: 'Connection from 203.0.113.99 port 1111 on 192.0.2.10 port 22 rdomain ""' },
      { at: '2026-10-15T03:00:00.100Z', pid: 600, message: 'Invalid user admin from 203.0.113.99 port 1111' },
      { at: '2026-10-15T03:00:00.200Z', pid: 600, message: `Failed publickey for root from 203.0.113.99 port 1111 ssh2: RSA ${FP_STRANGER}` },
      { at: '2026-10-15T03:00:00.300Z', pid: 600, message: 'Failed password for invalid user admin from 203.0.113.99 port 1111 ssh2' },
      { at: '2026-10-15T03:00:00.400Z', pid: 600, message: 'Connection closed by invalid user admin 203.0.113.99 port 1111 [preauth]' },
      { at: '2026-10-15T03:00:01.000Z', pid: 601, message: `Accepted key ED25519 ${FP_OPERATOR} found at .ssh/authorized_keys:1` },
      // A key that passed, then a code that did not: no login.
      { at: '2026-10-15T03:00:02.000Z', pid: 602, message: PARTIAL },
      { at: '2026-10-15T03:00:09.000Z', pid: 602, message: 'Failed keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' },
    ]);
    expect(logins).toEqual([]);
  });

  it('does not carry a partial success from an earlier connection on a reused pid', () => {
    const logins = sshLoginsFrom([
      { at: '2026-10-15T03:00:02.000Z', pid: 700, message: PARTIAL },
      { at: '2026-10-15T07:00:00.000Z', pid: 700, message: 'Connection from 203.0.113.7 port 50999 on 192.0.2.10 port 22 rdomain ""' },
      { at: '2026-10-15T07:00:05.000Z', pid: 700, message: ACCEPT_KI },
    ]);
    expect(logins).toEqual([{ at: '2026-10-15T07:00:05.000Z', user: 'root', fingerprint: null, methods: ['keyboard-interactive/pam'] }]);
  });
});

describe('consoleLoginsFrom', () => {
  it('reads the user from the pam_unix login session line, without its uid', () => {
    expect(
      consoleLoginsFrom([
        { at: '2026-10-15T09:00:03.000Z', message: 'pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)' },
        { at: '2026-10-15T09:10:00.000Z', message: 'pam_unix(login:session): session closed for user root' },
        { at: '2026-10-15T09:20:00.000Z', message: 'pam_unix(login:session): session opened for user operator by LOGIN(uid=0)' },
        { at: '2026-10-15T09:30:00.000Z', message: 'pam_unix(sshd:session): session opened for user root(uid=0) by root(uid=0)' },
        { at: '2026-10-15T09:40:00.000Z', message: 'FAILED LOGIN (1) on \'/dev/tty1\' FOR \'root\', Authentication failure' },
      ]),
    ).toEqual([
      { at: '2026-10-15T09:00:03.000Z', user: 'root' },
      { at: '2026-10-15T09:20:00.000Z', user: 'operator' },
    ]);
  });
});

describe('reconcile: SSH logins', () => {
  const single = (at: string): SshLogin => ({ at, user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey'] });

  it('flags a single-factor login after the switch, and not before it', () => {
    const after = cleanDay();
    after.sshLogins = [single('2026-10-15T10:00:00.000Z')];
    expect(reconcile(after).singleFactorLogins).toHaveLength(1);
    expect(failed(reconcile(after))).toBe(true);

    const before = cleanDay();
    before.sshLogins = [single('2026-10-14T09:00:00.000Z')];
    expect(reconcile(before).singleFactorLogins).toHaveLength(0);
    expect(failed(reconcile(before))).toBe(false);

    // At the switch's own second it counts, and with no switch recorded nothing does.
    const at = cleanDay();
    at.sshLogins = [single('2026-10-14T09:35:12.000Z')];
    expect(reconcile(at).singleFactorLogins).toHaveLength(1);
    const none = cleanDay();
    none.twoFactorSince = null;
    none.sshLogins = [single('2026-10-15T10:00:00.000Z')];
    expect(reconcile(none).singleFactorLogins).toHaveLength(0);
  });

  it('counts only publickey then keyboard-interactive/pam as two factors', () => {
    for (const methods of [['keyboard-interactive/pam'], ['keyboard-interactive/pam', 'publickey'], ['password'], ['publickey', 'password']]) {
      const day = cleanDay();
      day.sshLogins = [{ at: '2026-10-15T10:00:00.000Z', user: 'root', fingerprint: FP_OPERATOR, methods }];
      expect(reconcile(day).singleFactorLogins, methods.join(',')).toHaveLength(1);
    }
  });

  it('flags a login with a key not on the allowlist, for any user', () => {
    for (const user of ['root', 'operator']) {
      const day = cleanDay();
      day.sshLogins = [{ ...goodLogin('2026-10-15T11:00:00.000Z'), user, fingerprint: FP_STRANGER }];
      const r = reconcile(day);
      expect(r.unknownKeyLogins).toHaveLength(1);
      expect(failed(r)).toBe(true);
    }
    // A login that names no key cannot be shown to use an allowed one, so it is flagged too.
    const blind = cleanDay();
    blind.sshLogins = [{ ...goodLogin('2026-10-15T11:00:00.000Z'), fingerprint: null }];
    expect(reconcile(blind).unknownKeyLogins).toHaveLength(1);
  });

  it('counts operator sessions without failing', () => {
    const day = cleanDay();
    day.sshLogins = [goodLogin('2026-10-15T10:00:00.000Z'), goodLogin('2026-10-15T16:00:00.000Z'), goodLogin('2026-10-15T20:00:00.000Z')];
    const r = reconcile(day);
    expect(r.operatorSessions).toBe(3);
    expect(failed(r)).toBe(false);
  });
});

describe('reconcile: logins from before LogLevel VERBOSE (T22-4)', () => {
  // Before install A, sshd logged a two-factor login as one Accepted keyboard-interactive line
  // with no key. Those are reported, not failed; from the marker on, the same line is a login
  // that skipped the key.
  const kiOnly = (at: string): SshLogin => ({ at, user: 'root', fingerprint: null, methods: ['keyboard-interactive/pam'] });

  it('reports a keyboard-interactive-only login before the verbose marker, without failing', () => {
    const day = cleanDay();
    day.sshLogins = [kiOnly('2026-10-14T10:00:00.000Z')];
    const r = reconcile(day);
    expect(r.preVerboseLogins).toHaveLength(1);
    expect(r.singleFactorLogins).toEqual([]);
    expect(r.unknownKeyLogins).toEqual([]);
    expect(failed(r)).toBe(false);
  });

  it('reports it the same way while no marker exists', () => {
    const day = cleanDay();
    day.verboseSince = null;
    day.sshLogins = [kiOnly('2026-10-15T10:00:00.000Z')];
    const r = reconcile(day);
    expect(r.preVerboseLogins).toHaveLength(1);
    expect(failed(r)).toBe(false);
  });

  it('fails the same login from the marker on: single-factor, and an unknown key', () => {
    for (const at of [VERBOSE.replace('Z', '.000Z'), '2026-10-15T10:00:00.000Z']) {
      const day = cleanDay();
      day.sshLogins = [kiOnly(at)];
      const r = reconcile(day);
      expect(r.preVerboseLogins, at).toEqual([]);
      expect(r.singleFactorLogins, at).toHaveLength(1);
      expect(r.unknownKeyLogins, at).toHaveLength(1);
    }
  });

  it('always fails an Accepted publickey login after the switch, before the marker too', () => {
    const day = cleanDay();
    day.sshLogins = [{ at: '2026-10-14T10:00:00.000Z', user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey'] }];
    const r = reconcile(day);
    expect(r.singleFactorLogins).toHaveLength(1);
    expect(r.preVerboseLogins).toEqual([]);
  });
});

describe('reconcile: the flag band (T22-2, T22-SQ-3)', () => {
  // The window ends at the newest shipped file's time; only what is at least the tolerance
  // before it is flagged, and the tail is examined again the next night. Pairing still uses
  // everything fetched.
  const band = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:00:02Z' };

  it('does not flag a break-glass that straddles the last ship: row in the window, line after it', () => {
    const day = cleanDay();
    day.window = band;
    const rows = chain(['2026-10-15T09:00:05.123Z', '2026-10-16T01:04:59.500Z']);
    day.rows = rows;
    day.shipped = shippedFor([rows[0]]); // the second line was logged after the newest file was cut
    day.consoleLogins = [...day.consoleLogins, { at: '2026-10-16T01:04:58.000Z', user: 'root' }];
    const r = reconcile(day);
    expect(r.rowsWithoutShipped).toEqual([]);
    expect(r.consoleLoginsWithoutEntry).toEqual([]);
    expect(failed(r)).toBe(false);
  });

  it('pairs a login from before the band with its entry inside it', () => {
    const day = cleanDay();
    day.window = band;
    day.rows = chain(['2026-10-15T00:00:01.000Z']);
    day.shipped = shippedFor(day.rows);
    day.consoleLogins = [{ at: '2026-10-14T23:59:59.000Z', user: 'root' }];
    const r = reconcile(day);
    expect(r.entriesWithoutLogin).toEqual([]);
    expect(failed(r)).toBe(false);
  });

  it('flags inside the band, and only there', () => {
    const day = cleanDay();
    day.window = band;
    day.consoleLogins = [
      ...day.consoleLogins,
      { at: '2026-10-15T15:00:00.000Z', user: 'root' }, // inside, with no entry: flagged
      { at: '2026-10-16T01:03:00.000Z', user: 'root' }, // the tail: next night's
      { at: '2026-10-14T22:00:00.000Z', user: 'root' }, // before: last night's
    ];
    day.sudo = [
      { at: '2026-10-15T13:00:00.000Z', user: 'operator', target: 'root' },
      { at: '2026-10-16T01:02:00.000Z', user: 'operator', target: 'root' },
    ];
    const r = reconcile(day);
    expect(r.consoleLoginsWithoutEntry).toEqual([{ at: '2026-10-15T15:00:00.000Z', user: 'root' }]);
    expect(r.sudoToRoot).toHaveLength(1);
  });
});

describe('reconcile: the informational counts start where the last run stopped (T22R1A-6)', () => {
  it('counts sessions and root password changes only after the previous checked_until, while still flagging from the band start', () => {
    const day = cleanDay();
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:00:02Z', infoFrom: '2026-10-15T09:30:00Z' } as { from: string; to: string };
    day.sshLogins = [goodLogin('2026-10-15T08:00:00.000Z'), goodLogin('2026-10-15T10:00:00.000Z'), { ...goodLogin('2026-10-15T08:30:00.000Z'), fingerprint: FP_STRANGER }];
    day.passwordChanges = [
      { at: '2026-10-15T09:00:00.000Z', user: 'root' },
      { at: '2026-10-15T12:00:00.000Z', user: 'root' },
    ];
    const r = reconcile(day);
    expect(r.operatorSessions).toBe(1);
    expect(r.rootPasswordChanges).toBe(1);
    // The stranger's key, before infoFrom but inside the band, still fails.
    expect(r.unknownKeyLogins).toHaveLength(1);
  });
});

describe('reconcile: the chain anchor (T22-2, A.4)', () => {
  const before = chain(['2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z']);
  const anchor = before[1];
  /** A window whose one row follows the anchor. */
  function anchored() {
    const day = cleanDay();
    day.rows = chain(['2026-10-15T09:00:05.123Z'], 3, anchor.hash);
    day.shipped = shippedFor(day.rows);
    day.anchor = anchor;
    day.maxSeq = 3;
    return day;
  }

  it('links the window\'s first row to the row before it', () => {
    expect(reconcile(anchored()).chainBreaks).toEqual([]);
    const day = anchored();
    const unlinked = { ...day.rows[0], prevHash: 'f'.repeat(64) };
    day.rows = [{ ...unlinked, hash: entryHash(unlinked) }];
    day.shipped = shippedFor(day.rows);
    expect(reconcile(day).chainBreaks).toHaveLength(1);
  });

  it('reports a missing predecessor', () => {
    const day = anchored();
    day.anchor = null;
    expect(reconcile(day).chainBreaks).toHaveLength(1);
  });

  it('reports a changed anchor: the stored row no longer carries the stored hash', () => {
    const changed = anchored();
    changed.state = { seq: 2, hash: anchor.hash };
    changed.stateRow = { ...anchor, hash: 'a'.repeat(64) };
    expect(reconcile(changed).chainBreaks.length).toBeGreaterThanOrEqual(1);
    const gone = anchored();
    gone.state = { seq: 2, hash: anchor.hash };
    gone.stateRow = null;
    expect(reconcile(gone).chainBreaks).toHaveLength(1);
    const same = anchored();
    same.state = { seq: 2, hash: anchor.hash };
    same.stateRow = anchor;
    expect(reconcile(same).chainBreaks).toEqual([]);
  });

  it('reports a seq going down: max(seq) below the stored seq', () => {
    const day = anchored();
    day.state = { seq: 2, hash: anchor.hash };
    day.stateRow = anchor;
    day.maxSeq = 1;
    expect(reconcile(day).chainBreaks).toHaveLength(1);
    day.maxSeq = null;
    expect(reconcile(day).chainBreaks).toHaveLength(1);
  });

  it('reports an anchor above the stored seq: the rows between were never read (T22R1A-4)', () => {
    // Stored seq 2; row 3 was deleted; row 4 is the anchor and row 5 links to it.
    const all = chain(['2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z', '2026-10-14T10:00:00.000Z', '2026-10-14T11:00:00.000Z', '2026-10-15T09:00:05.123Z']);
    const day = cleanDay();
    day.rows = [all[4]];
    day.shipped = shippedFor(day.rows);
    day.anchor = all[3];
    day.state = { seq: 2, hash: all[1].hash };
    day.stateRow = all[1];
    day.maxSeq = 5;
    expect(reconcile(day).chainBreaks.length).toBeGreaterThanOrEqual(1);
    expect(failed(reconcile(day))).toBe(true);
  });

  it('holds a row read by seq to the evidence checks, whatever its time, and reports it back-dated (L-F4)', () => {
    // Stored seq 2. Row 3 was written while the clock ran behind: its `at` is before the band.
    const all = chain(['2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z', '2026-10-14T20:00:00.000Z']);
    const day = cleanDay();
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:00:02Z' };
    day.rows = [all[2]];
    day.shipped = [];
    day.consoleLogins = [];
    day.anchor = all[1];
    day.state = { seq: 2, hash: all[1].hash };
    day.stateRow = all[1];
    day.maxSeq = 3;
    const r = reconcile(day);
    expect(r.backdatedRows).toEqual([3]);
    expect(r.entriesWithoutLogin).toEqual([{ seq: 3, at: '2026-10-14T20:00:00.000Z' }]);
    expect(r.rowsWithoutShipped).toEqual([3]);
    expect(failed(r)).toBe(true);

    // The same row, back-dated but with its login and shipped line in the fetched records,
    // still fails as back-dated, and only as that.
    day.consoleLogins = [{ at: '2026-10-14T19:59:58.000Z', user: 'root' }];
    day.shipped = shippedFor([all[2]]);
    const paired = reconcile(day);
    expect(paired.entriesWithoutLogin).toEqual([]);
    expect(paired.rowsWithoutShipped).toEqual([]);
    expect(paired.backdatedRows).toEqual([3]);
    expect(failed(paired)).toBe(true);
  });

  it('keeps the tail margin for a row read by seq: a row after the band end is the next night\'s', () => {
    // The round-1 margin (SQ-3) still holds: a break-glass whose line missed the last ship.
    const all = chain(['2026-10-14T08:00:00.000Z', '2026-10-14T09:00:00.000Z', '2026-10-16T01:04:59.500Z']);
    const day = cleanDay();
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:00:02Z' };
    day.rows = [all[2]];
    day.shipped = [];
    day.consoleLogins = [{ at: '2026-10-16T01:04:58.000Z', user: 'root' }];
    day.anchor = all[1];
    day.state = { seq: 2, hash: all[1].hash };
    day.stateRow = all[1];
    day.maxSeq = 3;
    const r = reconcile(day);
    expect(r.rowsWithoutShipped).toEqual([]);
    expect(r.backdatedRows).toEqual([]);
    expect(failed(r)).toBe(false);
  });

  it('reads a shipped line for a row before the window against the anchor, not as a missing row', () => {
    const day = anchored();
    day.shipped = [...day.shipped, { entry: '0f8fad5b-d9cb-469f-a165-70867728950e', seq: 2, hash: anchor.hash, notice: 'sent' }];
    expect(reconcile(day).hashMismatches).toEqual([]);
    day.shipped = [...day.shipped, { entry: '0f8fad5b-d9cb-469f-a165-70867728950e', seq: 1, hash: before[0].hash, notice: 'sent' }];
    expect(reconcile(day).hashMismatches).toEqual([]);
    day.shipped[day.shipped.length - 1] = { ...day.shipped[day.shipped.length - 1], seq: 2, hash: 'b'.repeat(64) };
    expect(reconcile(day).hashMismatches).toEqual([2]);
  });
});

describe('reconcile: password changes and sudo', () => {
  it('reports root password changes without failing', () => {
    const day = cleanDay();
    day.passwordChanges = [
      { at: '2026-10-15T12:00:00.000Z', user: 'root' },
      { at: '2026-10-15T12:05:00.000Z', user: 'operator' },
    ];
    const r = reconcile(day);
    expect(r.rootPasswordChanges).toBe(1);
    expect(failed(r)).toBe(false);
  });

  it('flags sudo to root by a non-root user', () => {
    const day = cleanDay();
    day.sudo = [
      { at: '2026-10-15T13:00:00.000Z', user: 'operator', target: 'root' },
      { at: '2026-10-15T13:01:00.000Z', user: 'root', target: 'root' },
      { at: '2026-10-15T13:02:00.000Z', user: 'operator', target: 'postgres' },
    ];
    const r = reconcile(day);
    expect(r.sudoToRoot).toEqual([{ at: '2026-10-15T13:00:00.000Z', user: 'operator', target: 'root' }]);
    expect(failed(r)).toBe(true);
  });
});

describe('reconcile: the chain and its shipped hashes', () => {
  it('detects a rewritten entry', () => {
    // Edited in place, stored hash kept: the row no longer reproduces it, nor the shipped one.
    const edited = cleanDay();
    edited.rows = [{ ...edited.rows[0], actorRef: 'console:operator' }];
    expect(reconcile(edited).hashMismatches).toEqual([1]);
    expect(failed(reconcile(edited))).toBe(true);

    // Edited and re-hashed by a superuser: the row is self-consistent, but the hash shipped
    // off the host before the edit differs from entryHash(row).
    const rehashed = cleanDay();
    const changed = { ...rehashed.rows[0], detailText: '{"tty": "tty2", "channel": "hetzner-console"}' };
    rehashed.rows = [{ ...changed, hash: entryHash(changed) }];
    const r = reconcile(rehashed);
    expect(r.hashMismatches).toEqual([1]);
    expect(r.chainBreaks).toEqual([]);
  });

  it('flags a shipped line whose entry has no row, as a hash no row reproduces', () => {
    // The last row removed with the trigger disabled: only the shipped line remembers it.
    const day = cleanDay();
    const rows = chain(['2026-10-15T09:00:05.123Z', '2026-10-15T18:00:00.000Z']);
    day.shipped = shippedFor(rows);
    day.rows = [rows[0]];
    day.consoleLogins = [...day.consoleLogins, { at: '2026-10-15T17:59:58.000Z', user: 'root' }];
    const r = reconcile(day);
    expect(r.hashMismatches).toEqual([2]);
    expect(r.consoleLoginsWithoutEntry).toHaveLength(1);
  });

  it('detects a chain break', () => {
    const times = ['2026-10-15T09:00:05.123Z', '2026-10-15T11:00:00.000Z', '2026-10-15T13:00:00.000Z'];
    const logins = times.map((t) => ({ at: t, user: 'root' }));

    // The third row does not carry the second row's hash.
    const relinked = cleanDay();
    const rows = chain(times);
    const third = { ...rows[2], prevHash: 'f'.repeat(64) };
    relinked.rows = [rows[0], rows[1], { ...third, hash: entryHash(third) }];
    relinked.shipped = shippedFor(relinked.rows);
    relinked.consoleLogins = logins;
    expect(reconcile(relinked).chainBreaks).toEqual([3]);
    expect(failed(reconcile(relinked))).toBe(true);

    // A row missing from the middle: seq jumps from 1 to 3.
    const gap = cleanDay();
    gap.rows = [rows[0], rows[2]];
    gap.shipped = shippedFor(gap.rows);
    gap.consoleLogins = [logins[0], logins[2]];
    expect(reconcile(gap).chainBreaks).toEqual([3]);

    // Seq 1 must start from the genesis.
    const genesis = cleanDay();
    const first = { ...rows[0], prevHash: 'e'.repeat(64) };
    genesis.rows = [{ ...first, hash: entryHash(first) }];
    genesis.shipped = shippedFor(genesis.rows);
    expect(reconcile(genesis).chainBreaks).toEqual([1]);

    // A window that starts mid-chain is not a break, when it links to the row before it.
    const mid = cleanDay();
    const [anchor] = chain(['2026-10-14T09:00:00.000Z'], 40, 'd'.repeat(64));
    mid.rows = chain(['2026-10-15T09:00:05.123Z'], 41, anchor.hash);
    mid.shipped = shippedFor(mid.rows);
    mid.anchor = anchor;
    mid.maxSeq = 41;
    expect(reconcile(mid).chainBreaks).toEqual([]);
    expect(failed(reconcile(mid))).toBe(false);
    // Without that row it is a missing predecessor.
    mid.anchor = null;
    expect(reconcile(mid).chainBreaks).toEqual([41]);
  });

  it('flags an integrity row with no shipped line', () => {
    const day = cleanDay();
    day.shipped = [];
    const r = reconcile(day);
    expect(r.rowsWithoutShipped).toEqual([1]);
    expect(failed(r)).toBe(true);
  });

  it('flags notice=failed', () => {
    for (const notice of ['failed:recipients', 'failed:000', 'failed:config;truncated', 'malformed']) {
      const day = cleanDay();
      day.shipped = [{ ...day.shipped[0], notice }];
      const r = reconcile(day);
      expect(r.noticeFailures, notice).toBe(1);
      expect(failed(r)).toBe(true);
    }
  });
});

describe('shippedFrom: the hook\'s journal line, parsed strictly', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const HASH = 'a'.repeat(64);
  const parse = (message: string) => shippedFrom([{ at: '2026-10-15T09:00:06.000Z', message }]);

  it.each([
    ['sent', `entry=${ID} seq=12 hash=${HASH} notice=sent`, { entry: ID, seq: 12, hash: HASH, notice: 'sent' }],
    ['a refused send', `entry=${ID} seq=12 hash=${HASH} notice=failed:422`, { entry: ID, seq: 12, hash: HASH, notice: 'failed:422' }],
    ['a truncated list, with a refused file', `entry=${ID} seq=3 hash=${HASH} notice=failed:recipients;truncated env=owner text=missing`, { entry: ID, seq: 3, hash: HASH, notice: 'failed:recipients;truncated' }],
    ['no entry written', 'entry=FAILED notice=failed:config env=missing', { entry: 'FAILED', seq: 0, hash: '', notice: 'failed:config' }],
    ['an entry that may have landed', 'entry=UNCERTAIN notice=sent', { entry: 'UNCERTAIN', seq: 0, hash: '', notice: 'sent' }],
  ])('reads %s', (_name, message, want) => {
    expect(parse(message)).toEqual([want]);
  });

  it.each([
    ['an unknown notice', `entry=${ID} seq=12 hash=${HASH} notice=bogus`],
    ['a notice with junk after it', `entry=${ID} seq=12 hash=${HASH} notice=sent extra`],
    ['an unknown reason', `entry=${ID} seq=12 hash=${HASH} notice=sent env=elsewhere`],
    ['a short hash', `entry=${ID} seq=12 hash=${'a'.repeat(63)} notice=sent`],
    ['an upper-case hash', `entry=${ID} seq=12 hash=${'A'.repeat(64)} notice=sent`],
    ['no seq', `entry=${ID} hash=${HASH} notice=sent`],
    ['seq 0', `entry=${ID} seq=0 hash=${HASH} notice=sent`],
    ['an id that is not a uuid', `entry=root seq=12 hash=${HASH} notice=sent`],
    ['an empty line', ''],
  ])('counts %s as a malformed line, which fails the notice check', (_name, message) => {
    const got = parse(message);
    expect(got).toEqual([{ entry: 'MALFORMED', seq: 0, hash: '', notice: 'malformed' }]);
    expect(reconcile({ ...cleanDay(), shipped: [...cleanDay().shipped, ...got] }).noticeFailures).toBe(1);
  });
});

describe('sudoFrom and passwordChangesFrom', () => {
  it('reads who ran sudo and as whom', () => {
    expect(
      sudoFrom([
        { at: 't1', message: '    operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/usr/bin/id' },
        { at: 't2', message: 'root : TTY=pts/1 ; PWD=/root ; USER=postgres ; COMMAND=/usr/bin/psql' },
        { at: 't3', message: 'operator : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/bin/bash' },
        { at: 't4', message: 'pam_unix(sudo:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't5', message: 'pam_unix(sudo:session): session closed for user root' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root' },
      { at: 't2', user: 'root', target: 'postgres' },
      { at: 't3', user: 'operator', target: 'root' },
      { at: 't4', user: 'operator', target: 'root', uid: 1000 },
    ]);
  });

  it('cannot be talked out of a root target by a working directory or a command that names another user', () => {
    // PWD and COMMAND are the caller's text. Any USER=root field makes the target root.
    expect(
      sudoFrom([{ at: 't', message: 'operator : TTY=pts/0 ; PWD=/tmp/x ; USER=postgres ; y ; USER=root ; COMMAND=/usr/bin/id' }]),
    ).toEqual([{ at: 't', user: 'operator', target: 'root' }]);
  });

  // T22-R-A1: sudo splits a line longer than 980 bytes into `(command continued)` pieces, at a
  // space. Joined again by pid, either cut position reads as sudo to root.
  const PWD = `/tmp/${'d'.repeat(200)}/${'e'.repeat(200)}`;
  it.each([
    ['before COMMAND', `operator : TTY=pts/0 ; PWD=${PWD} ; USER=root`, 'operator : (command continued) ; COMMAND=/usr/bin/bash'],
    ['before USER', `operator : TTY=pts/0 ; PWD=${PWD} ;`, 'operator : (command continued) USER=root ; COMMAND=/usr/bin/bash'],
  ])('joins a line split %s and reads it as sudo to root', (_cut, first, second) => {
    const joined = joinContinued([
      { at: 't1', pid: 7001, message: first },
      { at: 't1b', pid: 7002, message: 'root : TTY=pts/1 ; PWD=/root ; USER=postgres ; COMMAND=/usr/bin/psql' },
      { at: 't2', pid: 7001, message: second },
    ]);
    expect(joined).toHaveLength(2);
    expect(sudoFrom(joined)).toEqual([
      { at: 't1', user: 'operator', target: 'root' },
      { at: 't1b', user: 'root', target: 'postgres' },
    ]);
  });

  it('counts USER=root from a non-root user even with no COMMAND on the line', () => {
    expect(sudoFrom([{ at: 't', message: `operator : TTY=pts/0 ; PWD=${PWD} ; USER=root` }])).toEqual([{ at: 't', user: 'operator', target: 'root' }]);
  });

  it('counts every root session opened through sudo, sudo -i, su and su -l, deciding root by uid, with no dedupe', () => {
    expect(
      sudoFrom([
        { at: 't1', pid: 81, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by operator(uid=1000)' },
        // One sudo process logs both its command line and its session: both count (T22R1A-1).
        { at: 't2', pid: 82, message: 'operator : TTY=pts/0 ; PWD=/srv ; USER=root ; COMMAND=/usr/bin/id' },
        { at: 't2', pid: 82, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't3', pid: 83, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by root(uid=0)' },
        { at: 't4', pid: 84, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by (uid=1000)' },
        // sudo -i opens its session under the PAM service sudo-i (T22R1A-5); su and su -l too.
        { at: 't5', pid: 85, message: 'pam_unix(sudo-i:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't6', pid: 86, message: 'pam_unix(su:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't7', pid: 87, message: 'pam_unix(su-l:session): session opened for user root(uid=0) by operator(uid=1000)' },
        // The name is the caller's to choose; the uid is not.
        { at: 't8', pid: 88, message: 'pam_unix(su:session): session opened for user root(uid=0) by root(uid=1000)' },
        { at: 't9', pid: 89, message: 'pam_unix(su:session): session opened for user operator(uid=1000) by root(uid=0)' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root', uid: 1000 },
      { at: 't2', user: 'operator', target: 'root' },
      { at: 't2', user: 'operator', target: 'root', uid: 1000 },
      { at: 't3', user: 'root', target: 'root', uid: 0 },
      { at: 't4', user: 'uid=1000', target: 'root', uid: 1000 },
      { at: 't5', user: 'operator', target: 'root', uid: 1000 },
      { at: 't6', user: 'operator', target: 'root', uid: 1000 },
      { at: 't7', user: 'operator', target: 'root', uid: 1000 },
      { at: 't8', user: 'root', target: 'root', uid: 1000 },
      { at: 't9', user: 'root', target: 'operator', uid: 0 },
    ]);
  });

  it('flags elevation to root by uid, so a non-root caller named root still counts', () => {
    const day = cleanDay();
    day.sudo = [
      { at: '2026-10-15T13:00:00.000Z', user: 'root', target: 'root', uid: 1000 },
      { at: '2026-10-15T13:01:00.000Z', user: 'root', target: 'root', uid: 0 },
      { at: '2026-10-15T13:02:00.000Z', user: 'root', target: 'root' },
    ] as { at: string; user: string; target: string; uid?: number }[];
    expect(reconcile(day).sudoToRoot).toHaveLength(1);
  });

  it('reads password changes by passwd and chpasswd, for any user', () => {
    expect(
      passwordChangesFrom([
        { at: 't1', message: 'pam_unix(passwd:chauthtok): password changed for root' },
        { at: 't2', message: 'pam_unix(chpasswd:chauthtok): password changed for root' },
        { at: 't3', message: 'pam_unix(passwd:chauthtok): password changed for operator' },
        { at: 't4', message: 'pam_unix(passwd:chauthtok): authentication failure; logname= uid=0' },
      ]),
    ).toEqual([
      { at: 't1', user: 'root' },
      { at: 't2', user: 'root' },
      { at: 't3', user: 'operator' },
    ]);
  });
});

describe('caller text cannot hide a line behind U+2028 or U+2029 (L-F2)', () => {
  it('reads a sudo line whose PWD holds U+2028, and joins a continued one that does', () => {
    expect(sudoFrom([{ at: 't', message: 'operator : user NOT in sudoers ; TTY=pts/0 ; PWD=/tmp/\u2028 ; USER=root ; COMMAND=/bin/bash' }])).toEqual([
      { at: 't', user: 'operator', target: 'root' },
    ]);
    const joined = joinContinued([
      { at: 't1', pid: 9, message: 'operator : TTY=pts/0 ; PWD=/tmp/\u2029 ;' },
      { at: 't2', pid: 9, message: 'operator : (command continued) USER=root\u2028 ; COMMAND=/bin/bash' },
    ]);
    expect(joined).toHaveLength(1);
    expect(sudoFrom(joined)).toEqual([{ at: 't1', user: 'operator', target: 'root' }]);
  });

  it('reads an Accepted line whose trailing text holds U+2028', () => {
    expect(sshLoginsFrom([{ at: 't', pid: 1, message: `Accepted publickey for root from 203.0.113.7 port 1 ssh2: ED25519 ${FP_OPERATOR} ID a\u2028b` }])).toEqual([
      { at: 't', user: 'root', fingerprint: FP_OPERATOR, methods: ['publickey'] },
    ]);
  });

  it('reads a console login line whose trailing text holds U+2029', () => {
    expect(consoleLoginsFrom([{ at: 't', message: 'pam_unix(login:session): session opened for user root(uid=0) by x\u2029(uid=0)' }])).toEqual([{ at: 't', user: 'root' }]);
  });
});

describe('sudoFrom: failed attempts and pkexec (A-1)', () => {
  it('counts a failed su to root by a non-root uid, and not by uid 0', () => {
    expect(
      sudoFrom([
        { at: 't1', message: 'pam_unix(su:auth): authentication failure; logname=operator uid=1000 euid=0 tty=/dev/pts/0 ruser=operator rhost=  user=root' },
        { at: 't2', message: 'pam_unix(su-l:auth): authentication failure; logname= uid=1000 euid=0 tty=/dev/pts/0 ruser=operator rhost=  user=root' },
        { at: 't3', message: 'pam_unix(su:auth): authentication failure; logname=root uid=0 euid=0 tty=/dev/pts/0 ruser=root rhost=  user=root' },
        { at: 't4', message: 'pam_unix(su:auth): authentication failure; logname=operator uid=1000 euid=0 tty=/dev/pts/0 ruser=operator rhost=  user=postgres' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root', uid: 1000 },
      { at: 't2', user: 'operator', target: 'root', uid: 1000 },
      { at: 't3', user: 'root', target: 'root', uid: 0 },
      { at: 't4', user: 'operator', target: 'postgres', uid: 1000 },
    ]);
  });

  it('counts FAILED SU to root', () => {
    expect(sudoFrom([{ at: 't', message: 'FAILED SU (to root) operator on pts/0' }])).toEqual([{ at: 't', user: 'operator', target: 'root' }]);
  });

  it('counts pkexec running a command as root, and its refusal', () => {
    expect(
      sudoFrom([
        { at: 't1', message: 'operator: Executing command [USER=root] [TTY=/dev/pts/0] [CWD=/home/operator] [COMMAND=/usr/bin/bash]' },
        { at: 't2', message: 'operator: Error executing command as another user: Not authorized [USER=root] [TTY=/dev/pts/0] [CWD=/home/operator] [COMMAND=/usr/bin/id]' },
        // A caller-chosen value naming another user first cannot hide the real one.
        { at: 't3', message: 'operator: The value for environment variable X[USER=postgres] contains suspicious content [USER=root] [TTY=/dev/pts/0] [CWD=/x] [COMMAND=/bin/sh]' },
        { at: 't4', message: 'operator: Executing command [USER=postgres] [TTY=/dev/pts/0] [CWD=/home/operator] [COMMAND=/usr/bin/psql]' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root' },
      { at: 't2', user: 'operator', target: 'root' },
      { at: 't3', user: 'operator', target: 'root' },
      { at: 't4', user: 'operator', target: 'postgres' },
    ]);
  });
});

describe('sudoFrom: polkit (L3-1)', () => {
  it("counts pkexec's polkit-1 session opened for root, by uid", () => {
    expect(
      sudoFrom([
        { at: 't1', message: 'pam_unix(polkit-1:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't2', message: 'pam_unix(polkit-1:session): session opened for user root(uid=0) by (uid=1000)' },
        { at: 't3', message: 'pam_unix(polkit-1:session): session opened for user root(uid=0) by root(uid=0)' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root', uid: 1000 },
      { at: 't2', user: 'uid=1000', target: 'root', uid: 1000 },
      { at: 't3', user: 'root', target: 'root', uid: 0 },
    ]);
  });

  it('counts every polkit authentication failure as an attempt, whoever it names', () => {
    const lines = [
      { at: '2026-10-15T13:00:00.000Z', message: 'pam_unix(polkit-1:auth): authentication failure; logname= uid=1000 euid=0 tty= ruser=operator rhost=  user=admin' },
      { at: '2026-10-15T13:01:00.000Z', message: 'pam_unix(polkit-1:auth): authentication failure; logname=root uid=0 euid=0 tty= ruser=root rhost=  user=root' },
      // Cut short, or reworded after the prefix: still a polkit authentication failure.
      { at: '2026-10-15T13:02:00.000Z', message: 'pam_unix(polkit-1:auth): authentication failure' },
    ];
    const read = sudoFrom(lines);
    expect(read).toHaveLength(3);
    for (const s of read) expect(s).toMatchObject({ target: 'root', anyCaller: true });
    const day = cleanDay();
    day.sudo = read;
    const r = reconcile(day);
    expect(r.sudoToRoot).toHaveLength(3);
    expect(failed(r)).toBe(true);
  });
});

describe("sudoFrom: polkitd's authentication as root (L4-1)", () => {
  const ok = (owner: string, as = 'unix-user:root') =>
    `Operator of unix-session:3 successfully authenticated as ${as} to gain ONE-SHOT authorization for action org.freedesktop.policykit.exec for unix-process:4242:1234567 [/usr/bin/bash] (owned by ${owner})`;

  it('counts it when the requesting subject is not root, or cannot be read, and not when it is root', () => {
    const read = sudoFrom([
      { at: 't1', message: ok('unix-user:operator') },
      { at: 't2', message: ok('unix-user:1000') },
      { at: 't3', message: ok('unix-user:root') },
      { at: 't4', message: ok('unix-user:0') },
      // The bracketed command line is the caller's: a fake owner inside it cannot hide the real one.
      { at: 't5', message: 'Operator of unix-session:3 successfully authenticated as unix-user:root to gain TEMPORARY authorization for action x for unix-process:1:2 [sh (owned by unix-user:root)] (owned by unix-user:operator)' },
      // As the ruling words it, with no subject to read: counted anyway.
      { at: 't6', message: 'Operator of unix-session:3 successfully authenticated as unix-user root to gain ONE-SHOT authorization for action x' },
      // Authenticated as another user, or by uid 0.
      { at: 't7', message: ok('unix-user:operator', 'unix-user:operator') },
      { at: 't8', message: ok('unix-user:operator', 'unix-user:0') },
    ]);
    const day = cleanDay();
    day.sudo = read;
    expect(reconcile(day).sudoToRoot.map((s) => s.at)).toEqual(['t1', 't2', 't5', 't6', 't8']);
  });
});

describe('reconcile: rows read as one contiguous seq range (L3-2)', () => {
  /** Each row's console login 2 s before it and its shipped line 15 s after, by the same clock. */
  function evidenceFor(rows: Row[]) {
    return {
      consoleLogins: rows.map((r) => ({ at: new Date(Date.parse(r.atUtc) - 2_000).toISOString(), user: 'root' })),
      shipped: shippedFor(rows),
    };
  }

  it('finds no chain break when a future-dated row below the stored seq comes back by time', () => {
    // Row 4 was written while the clock ran 10 days ahead; the stored seq (22) has passed it.
    // When the real date reaches its time the band holds it, so the range starts at 4.
    const times = ['2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z', '2026-10-03T10:00:00.000Z', '2026-10-15T10:00:00.000Z'];
    for (let d = 6; d <= 14; d += 1) times.push(`2026-10-${String(d).padStart(2, '0')}T08:00:00.000Z`, `2026-10-${String(d).padStart(2, '0')}T09:00:00.000Z`);
    times.push('2026-10-15T12:00:00.000Z');
    const all = chain(times);
    const day = { ...cleanDay(), ...evidenceFor([all[3], all[22]]) };
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:50:00Z' };
    day.rows = all.slice(3);
    day.anchor = all[2];
    day.state = { seq: 22, hash: all[21].hash };
    day.stateRow = all[21];
    day.maxSeq = 23;
    day.sshLogins = [];
    const r = reconcile({ ...day, now: '2026-10-16T02:00:00Z' });
    expect(r.chainBreaks).toEqual([]);
    // Rows 5 to 22, at or below the stored seq and outside the band, count for nothing.
    expect(r.rowsWithoutShipped).toEqual([]);
    expect(r.entriesWithoutLogin).toEqual([]);
    expect(r.backdatedRows).toEqual([]);
    expect(r.futureRows).toEqual([]);
    expect(failed(r)).toBe(false);
    // The two-part read it replaces, rows 4 and 23 with nothing between, broke the chain.
    expect(reconcile({ ...day, rows: [all[3], all[22]], now: '2026-10-16T02:00:00Z' }).chainBreaks).not.toEqual([]);
  });

  it('counts a stored row that is back-dated for nothing, and finds no chain break', () => {
    // The clock stepped back 3 h between rows 2 and 3; the last good run stored seq 3. The query
    // reaches row 2 by its time (from the tolerance before the band), so the range starts at 2;
    // rows 2 and 3 are outside the band.
    const all = chain(['2026-10-14T10:00:00.000Z', '2026-10-14T23:58:00.000Z', '2026-10-14T21:00:00.000Z', '2026-10-15T12:00:00.000Z']);
    const day = { ...cleanDay(), ...evidenceFor([all[1], all[3]]) };
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:50:00Z' };
    day.rows = all.slice(1);
    day.anchor = all[0];
    day.state = { seq: 3, hash: all[2].hash };
    day.stateRow = all[2];
    day.maxSeq = 4;
    day.sshLogins = [];
    const r = reconcile({ ...day, now: '2026-10-16T02:00:00Z' });
    expect(r.chainBreaks).toEqual([]);
    expect(r.backdatedRows).toEqual([]);
    expect(r.rowsWithoutShipped).toEqual([]);
    expect(failed(r)).toBe(false);
  });

  it('reports a row read by seq and dated after now in futureRows, which fails; one at or below the stored seq is not read by seq', () => {
    const all = chain(['2026-10-14T08:00:00.000Z', '2026-10-15T09:00:05.123Z', '2026-10-16T09:00:00.000Z']);
    const day = { ...cleanDay(), ...evidenceFor([all[1]]) };
    day.window = { from: '2026-10-15T00:00:00Z', to: '2026-10-16T01:00:02Z' };
    day.rows = all.slice(1);
    day.anchor = all[0];
    day.state = { seq: 1, hash: all[0].hash };
    day.stateRow = all[0];
    day.maxSeq = 3;
    const r = reconcile({ ...day, now: '2026-10-16T02:00:00Z' });
    expect(r.futureRows).toEqual([3]);
    expect(failed(r)).toBe(true);
    // Exactly at now is not after it.
    expect(reconcile({ ...day, now: '2026-10-16T09:00:00Z' }).futureRows).toEqual([]);
    // With no stored state every row is read by seq from 1, as the query reads them.
    expect(reconcile({ ...day, state: null, stateRow: null, now: '2026-10-16T02:00:00Z' }).futureRows).toEqual([3]);
  });
});

describe('allowedFrom', () => {
  it('reads one "SHA256:<fp> <label>" per line', () => {
    expect(allowedFrom(`${FP_OPERATOR} operator\n${FP_STRANGER} spare-key\n`)).toEqual([
      { fingerprint: FP_OPERATOR, label: 'operator' },
      { fingerprint: FP_STRANGER, label: 'spare-key' },
    ]);
  });

  it.each([
    ['an empty list', ''],
    ['a line with no label', `${FP_OPERATOR}\n`],
    ['a short fingerprint', `SHA256:${'A'.repeat(42)} operator\n`],
    ['an MD5 fingerprint', 'MD5:00:11:22 operator\n'],
    ['a blank line', `${FP_OPERATOR} operator\n\n`],
  ])('refuses %s', (_name, text) => {
    expect(() => allowedFrom(text)).toThrow();
  });
});

describe('expiredNames', () => {
  it('expires files older than 90 days by name date', () => {
    const names = [
      'auditlog-2026-07-16T000500Z.journal.gz', // 91 days before 2026-10-15
      'auditlog-2026-07-17T230500Z.journal.gz', // 90 days: kept
      'auditlog-2026-10-15T010500Z.journal.gz',
      'pre-fix-2026-07-01.json.gz',
      'pre-fix-2026-07-17.json.gz',
      // Never touched, however old they look: not a name the ship or the export writes.
      'auditlog-2026-02-30T000000Z.journal.gz',
      'auditlog-2026-01-01T000000Z.journal.gz.part',
      'notes-2026-01-01.txt',
      '../auditlog-2026-01-01T000000Z.journal.gz',
      'pre-fix-2026-01-01.json.gz extra',
    ];
    expect(expiredNames(names, '2026-10-15')).toEqual(['auditlog-2026-07-16T000500Z.journal.gz', 'pre-fix-2026-07-01.json.gz']);
    expect(expiredNames(names, '2026-10-15', 120)).toEqual([]);
  });

  it('refuses a today that is not a date', () => {
    expect(() => expiredNames([], '2026-13-01')).toThrow();
    expect(() => expiredNames([], 'yesterday')).toThrow();
  });
});

describe('parseExport: journalctl -o export', () => {
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };

  it('reads text and binary fields, record by record', () => {
    const binary = Buffer.from('line one\nline two', 'utf8');
    const buf = Buffer.concat([
      Buffer.from('__REALTIME_TIMESTAMP=1760518800000000\n_PID=42\n_COMM=sshd\nMESSAGE=hello world\n\n'),
      Buffer.from('__REALTIME_TIMESTAMP=1760518801000000\n_PID=43\nMESSAGE\n'),
      u64(binary.length),
      binary,
      Buffer.from('\n_COMM=sudo\n\n'),
    ]);
    expect(parseExport(buf)).toEqual([
      { __REALTIME_TIMESTAMP: '1760518800000000', _PID: '42', _COMM: 'sshd', MESSAGE: 'hello world' },
      { __REALTIME_TIMESTAMP: '1760518801000000', _PID: '43', MESSAGE: 'line one\nline two', _COMM: 'sudo' },
    ]);
    expect(parseExport(Buffer.alloc(0))).toEqual([]);
  });

  it('refuses a stream cut short, rather than read part of it', () => {
    expect(() => parseExport(Buffer.from('__REALTIME_TIMESTAMP=1\nMESSAGE=x\n'))).toThrow();
    expect(() => parseExport(Buffer.concat([Buffer.from('MESSAGE\n'), u64(10), Buffer.from('abc')]))).toThrow();
  });
});

/*
 * The command line, as the reconcile script runs it: JSON on stdin; on stdout one counts line,
 * then the state line the script stores after a pass; exit 0 for a pass, 1 for a finding, 2 for
 * input it refuses.
 */
const CLI = path.resolve('ops/host/auditlog.mjs');

function exportRecord(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n';
}
const usAt = (iso: string) => String(Date.parse(iso) * 1000);
const b64 = (text: string) => Buffer.from(text).toString('base64');

type CliOver = Record<string, unknown> & { db?: Record<string, unknown>; extra?: Record<string, string>[] };

function cliInput(over: CliOver = {}) {
  const rows = chain(['2026-10-15T09:00:05.123Z']);
  const { db, extra, ...top } = over;
  const journal = [
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-15T09:00:03Z'), _PID: '900', _COMM: 'login', SYSLOG_IDENTIFIER: 'login', MESSAGE: 'pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)' }),
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-15T09:00:20Z'), _PID: '901', _COMM: 'logger', SYSLOG_IDENTIFIER: 'makrai-break-glass', MESSAGE: `entry=0f8fad5b-d9cb-469f-a165-70867728950e seq=1 hash=${rows[0].hash} notice=sent` }),
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-15T10:00:00Z'), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: `Partial publickey for root from 203.0.113.7 port 50022 ssh2: ED25519 ${FP_OPERATOR}` }),
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-15T10:00:09Z'), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' }),
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-15T12:00:00Z'), _PID: '950', _COMM: 'passwd', SYSLOG_IDENTIFIER: 'passwd', MESSAGE: 'pam_unix(passwd:chauthtok): password changed for root' }),
    // Outside the window: a stranger's single-factor login a day earlier must not count.
    exportRecord({ __REALTIME_TIMESTAMP: usAt('2026-10-14T20:00:00Z'), _PID: '77', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: `Accepted publickey for root from 203.0.113.66 port 1 ssh2: ED25519 ${FP_STRANGER}` }),
    ...(extra ?? []).map(exportRecord),
  ].join('');
  return {
    since: '2026-10-15T00:00:00Z',
    until: '2026-10-16T01:05:02Z',
    toleranceSec: 300,
    twoFactorSinceB64: b64(`${SWITCH}\n`),
    verboseSinceB64: b64(`${VERBOSE}\n`),
    allowedKeysB64: b64(`${FP_OPERATOR} operator\n`),
    state: null,
    checkedUntil: null,
    futureNamedFiles: 0,
    // The script's clock, read after the rows were.
    now: '2026-10-16T02:00:00Z',
    db: { rows, anchor: null, stateRow: null, maxSeq: 1, ...db },
    journalB64: b64(journal),
    ...top,
  };
}

function cli(args: string[], input: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('auditlog.mjs reconcile, from the command line', () => {
  it('prints the counts line, then the state to store, and exits 0 on a clean window', () => {
    const r = cli(['reconcile'], JSON.stringify(cliInput()));
    expect(r.stderr).toBe('');
    const hash = chain(['2026-10-15T09:00:05.123Z'])[0].hash;
    expect(r.stdout).toBe(
      'records=5 rows=1 matched=1 consoleLoginsWithoutEntry=0 entriesWithoutLogin=0 unknownKeyLogins=0 singleFactorLogins=0 ' +
        'chainBreaks=0 hashMismatches=0 noticeFailures=0 sudoToRoot=0 operatorSessions=1 rootPasswordChanges=1 rowsWithoutShipped=0 ' +
        'preVerboseLogins=0 backdatedRows=0 futureRows=0 futureNamedFiles=0\n' +
        // The band ends the tolerance before the newest file; the last row checked is seq 1.
        `checked_until=2026-10-16T01:00:02Z seq=1 hash=${hash}\n`,
    );
    expect(r.status).toBe(0);
  });

  it('keeps the stored seq and hash when the window holds no row', () => {
    const anchor = chain(['2026-10-14T09:00:00.000Z'])[0];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ db: { rows: [], anchor, stateRow: anchor, maxSeq: 1 }, state: { seq: 1, hash: anchor.hash }, extra: [] })));
    // The console login now has no entry and the shipped line names seq 1, the anchor: one finding.
    expect(r.stdout.split('\n')[1]).toBe(`checked_until=2026-10-16T01:00:02Z seq=1 hash=${anchor.hash}`);
  });

  it('exits 1 on a finding, still with the counts and nothing else', () => {
    const r = cli(['reconcile'], JSON.stringify(cliInput({ db: { rows: [] } })));
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')[0]).toMatch(/^records=5 rows=0 matched=0 consoleLoginsWithoutEntry=1 .* hashMismatches=1 .*$/);
    expect(r.stdout).not.toContain('203.0.113');
  });

  it('reads the switch as absent when its file is', () => {
    // Before the switch, the single Accepted publickey line is how every login looks.
    const r = cli(['reconcile'], JSON.stringify(cliInput({ twoFactorSinceB64: null, since: '2026-10-14T00:00:00Z' })));
    expect(r.stdout).toContain(' singleFactorLogins=0 ');
    expect(r.stdout).toContain(' unknownKeyLogins=1 ');
  });

  it('reads sshd-session lines too: a stranger key that passed, then the code, is an unknown key (T22-SQ-1)', () => {
    // OpenSSH 9.8 and later log authentication from sshd-session (F-25).
    const extra = [
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T14:00:00Z'), _PID: '5300', _COMM: 'sshd-session', SYSLOG_IDENTIFIER: 'sshd-session', MESSAGE: `Partial publickey for root from 203.0.113.70 port 40100 ssh2: ED25519 ${FP_STRANGER}` },
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T14:00:07Z'), _PID: '5300', _COMM: 'sshd-session', SYSLOG_IDENTIFIER: 'sshd-session', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.70 port 40100 ssh2' },
    ];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' unknownKeyLogins=1 ');
    expect(r.stdout).toContain(' operatorSessions=2 ');
    expect(r.status).toBe(1);
  });

  it('reads sudo lines: the operator to root is a finding (T22-SQ-1)', () => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6100', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/usr/bin/id' }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  it.each([
    ['before USER', ' ;', 'USER=root ; COMMAND=/usr/bin/bash'],
    ['before COMMAND', ' ; USER=root', '; COMMAND=/usr/bin/bash'],
  ])('reads a sudo line that sudo split %s as sudo to root (T22-R-A1)', (_cut, end1, rest) => {
    // The CLI joins the pieces by pid (joinContinued, pinned above); the USER=root token is
    // also read from either piece alone, so neither cut can hide it.
    const pwd = `/tmp/${'d'.repeat(200)}/${'e'.repeat(200)}`;
    const extra = [
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6101', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: `operator : TTY=pts/0 ; PWD=${pwd}${end1}` },
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00.001Z'), _PID: '6101', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: `operator : (command continued) ${rest}` },
    ];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
  });

  it('never lets a forged root line hide a real operator line on the same pid (T22R1A-1)', () => {
    const extra = [
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6200', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'root : TTY=pts/0 ; PWD=/root ; USER=root ; COMMAND=/bin/true' },
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:01Z'), _PID: '6200', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/bin/bash' },
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:01Z'), _PID: '6200', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'pam_unix(sudo-i:session): session opened for user root(uid=0) by operator(uid=1000)' },
    ];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toMatch(/ sudoToRoot=[1-9]/);
    expect(r.status).toBe(1);
  });

  it.each([
    ['sudoedit', { _COMM: 'sudoedit', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=sudoedit /etc/cron.d/x' }],
    ['su', { _COMM: 'su', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'pam_unix(su:session): session opened for user root(uid=0) by operator(uid=1000)' }],
    ['su -l', { _COMM: 'su', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'pam_unix(su-l:session): session opened for user root(uid=0) by operator(uid=1000)' }],
    ['sudo -i', { _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'pam_unix(sudo-i:session): session opened for user root(uid=0) by operator(uid=1000)' }],
  ])('counts elevation to root through %s (T22R1A-2)', (_how, fields) => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6300', ...fields }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  it.each([
    ['su', { _COMM: 'y', _EXE: '/usr/bin/su', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'pam_unix(su-l:session): session opened for user root(uid=0) by operator(uid=1000)' }],
    ['sudo', { _COMM: 'x', _EXE: '/usr/bin/sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/bin/bash' }],
    ['pkexec', { _COMM: 'z', _EXE: '/usr/bin/pkexec', SYSLOG_IDENTIFIER: 'pkexec', MESSAGE: 'operator: Executing command [USER=root] [TTY=/dev/pts/0] [CWD=/home/operator] [COMMAND=/usr/bin/bash]' }],
    // pkexec's own PAM session line: short, so it is logged even when the Executing line, which
    // carries the whole command line, is too large to send (L3-1).
    ['pkexec, by its polkit-1 session', { _COMM: 'z', _EXE: '/usr/bin/pkexec', SYSLOG_IDENTIFIER: 'pkexec', MESSAGE: 'pam_unix(polkit-1:session): session opened for user root(uid=0) by operator(uid=1000)' }],
  ])('reads %s run through a renamed symlink, by its executable (L-F1)', (_how, fields) => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6400', ...fields }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  it('reads pkexec by its name too, and a refused su', () => {
    const extra = [
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6500', _COMM: 'pkexec', SYSLOG_IDENTIFIER: 'pkexec', MESSAGE: 'operator: Error executing command as another user: Not authorized [USER=root] [TTY=/dev/pts/0] [CWD=/home/operator] [COMMAND=/usr/bin/id]' },
      { __REALTIME_TIMESTAMP: usAt('2026-10-15T15:01:00Z'), _PID: '6501', _COMM: 'su', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'FAILED SU (to root) operator on pts/0' },
    ];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=2 ');
  });

  it.each([
    ['naming another admin', 'pam_unix(polkit-1:auth): authentication failure; logname= uid=1000 euid=0 tty= ruser=operator rhost=  user=admin'],
    ['naming root, by uid 0', 'pam_unix(polkit-1:auth): authentication failure; logname=root uid=0 euid=0 tty= ruser=root rhost=  user=root'],
  ])('counts a polkit authentication failure from the agent helper, %s: none should ever happen here (L3-1)', (_name, message) => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6700', _COMM: 'polkit-agent-he', _EXE: '/usr/lib/polkit-1/polkit-agent-helper-1', SYSLOG_IDENTIFIER: 'polkit-agent-helper-1', MESSAGE: message }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  // Elevation is read by content (L4-1): journald credits a line to whatever the process is when
  // it reads it, and pkexec (or su, or sudo) may already have become the program it ran.
  it.each([
    ["pkexec's polkit-1 session, credited to the program pkexec ran", { _COMM: 'bash', _EXE: '/usr/bin/bash', SYSLOG_IDENTIFIER: 'bash', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(polkit-1:session): session opened for user root(uid=0) by operator(uid=1000)' }],
    ['su -l, credited to its shell', { _COMM: 'bash', _EXE: '/usr/bin/bash', SYSLOG_IDENTIFIER: 'su', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(su-l:session): session opened for user root(uid=0) by operator(uid=1000)' }],
    ['a failed su, from a process already gone', { SYSLOG_IDENTIFIER: 'su', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(su:auth): authentication failure; logname=operator uid=1000 euid=0 tty=/dev/pts/0 ruser=operator rhost=  user=root' }],
    ['FAILED SU, from any process', { _COMM: 'x', _EXE: '/usr/bin/x', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'FAILED SU (to root) operator on pts/0' }],
    ['a polkit authentication failure, from any process', { _COMM: 'x', _EXE: '/usr/bin/x', SYSLOG_IDENTIFIER: 'x', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(polkit-1:auth): authentication failure; logname= uid=1000 euid=0 tty= ruser=operator rhost=  user=admin' }],
    ["polkitd's authentication as root, for the operator's process", { _COMM: 'polkitd', _EXE: '/usr/lib/polkit-1/polkitd', SYSLOG_IDENTIFIER: 'polkitd', SYSLOG_FACILITY: '10', MESSAGE: 'Operator of unix-session:3 successfully authenticated as unix-user:root to gain ONE-SHOT authorization for action org.freedesktop.policykit.exec for unix-process:4242:1234567 [/usr/bin/bash] (owned by unix-user:operator)' }],
    ["sudo's command line, by its identity, credited to the command sudo ran", { _COMM: 'bash', _EXE: '/usr/bin/bash', SYSLOG_IDENTIFIER: 'sudo', SYSLOG_FACILITY: '10', MESSAGE: 'operator : TTY=pts/0 ; PWD=/srv/makrai ; USER=root ; COMMAND=/bin/bash' }],
  ])('counts %s, by its content (L4-1)', (_name, fields) => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6800', ...fields }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  it.each([
    ["cron's root session (cron runs as root)", { _COMM: 'cron', _EXE: '/usr/sbin/cron', SYSLOG_IDENTIFIER: 'CRON', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)' }],
    ["systemd's user manager for root", { _COMM: '(sd-pam)', _EXE: '/usr/lib/systemd/systemd', SYSLOG_IDENTIFIER: '(sd-pam)', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(systemd-user:session): session opened for user root(uid=0) by (uid=0)' }],
    ["sshd's session for root (the login is checked as an SSH login)", { _COMM: 'sshd', _EXE: '/usr/sbin/sshd', SYSLOG_IDENTIFIER: 'sshd', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(sshd:session): session opened for user root(uid=0) by (uid=0)' }],
    ['root becoming root through su', { _COMM: 'bash', _EXE: '/usr/bin/bash', SYSLOG_IDENTIFIER: 'su', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(su:session): session opened for user root(uid=0) by root(uid=0)' }],
    ['a session closing', { _COMM: 'sudo', _EXE: '/usr/bin/sudo', SYSLOG_IDENTIFIER: 'sudo', SYSLOG_FACILITY: '10', MESSAGE: 'pam_unix(sudo:session): session closed for user root' }],
    ["a line shaped like sudo's from another identity", { _COMM: 'myapp', _EXE: '/usr/bin/myapp', SYSLOG_IDENTIFIER: 'myapp', SYSLOG_FACILITY: '10', MESSAGE: 'operator : TTY=pts/0 ; PWD=/x ; USER=root ; COMMAND=/bin/true' }],
    ["polkitd's authentication as root for root's own process", { _COMM: 'polkitd', _EXE: '/usr/lib/polkit-1/polkitd', SYSLOG_IDENTIFIER: 'polkitd', SYSLOG_FACILITY: '10', MESSAGE: 'Operator of unix-session:3 successfully authenticated as unix-user:root to gain ONE-SHOT authorization for action x for unix-process:1:2 [/usr/bin/x] (owned by unix-user:root)' }],
  ])('does not count %s (L4-1)', (_name, fields) => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6900', ...fields }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=0 ');
    expect(r.status).toBe(0);
  });

  it('fails on a row read by seq and dated after now: futureRows=1 (L3-2)', () => {
    // The last good run stored seq 1. Row 2 is read because its seq is above that, and is dated
    // three hours after the script's clock: a clock that ran ahead wrote it.
    const [row1, row2] = chain(['2026-10-15T09:00:05.123Z', '2026-10-16T05:00:00.000Z']);
    const input = cliInput({ state: { seq: 1, hash: row1.hash }, db: { rows: [row1, row2], anchor: null, stateRow: row1, maxSeq: 2 } });
    const r = cli(['reconcile'], JSON.stringify(input));
    expect(r.stdout).toContain(' chainBreaks=0 ');
    expect(r.stdout).toContain(' rowsWithoutShipped=0 ');
    expect(r.stdout).toContain(' futureRows=1 ');
    expect(r.status).toBe(1);
    // At its own time it is not in the future: it is the next night's tail, and this one passes.
    const atIt = cli(['reconcile'], JSON.stringify({ ...input, now: '2026-10-16T05:00:00Z' }));
    expect(atIt.stdout).toContain(' futureRows=0 ');
    expect(atIt.status).toBe(0);
  });

  it('reads a refused sudo whose PWD holds U+2028 (L-F2)', () => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6600', _COMM: 'sudo', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'operator : user NOT in sudoers ; TTY=pts/0 ; PWD=/tmp/\u2028 ; USER=root ; COMMAND=/bin/bash' }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=1 ');
    expect(r.status).toBe(1);
  });

  it('reports futureNamedFiles in the counts without failing (L-F3)', () => {
    const r = cli(['reconcile'], JSON.stringify(cliInput({ futureNamedFiles: 2 })));
    expect(r.stdout.split('\n')[0]).toMatch(/ futureNamedFiles=2$/);
    expect(r.status).toBe(0);
  });

  it('does not count su to root by root', () => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T15:00:00Z'), _PID: '6301', _COMM: 'su', SYSLOG_IDENTIFIER: 'su', MESSAGE: 'pam_unix(su:session): session opened for user root(uid=0) by root(uid=0)' }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(r.stdout).toContain(' sudoToRoot=0 ');
    expect(r.status).toBe(0);
  });

  it('counts the informational fields only after checkedUntil', () => {
    const r = cli(['reconcile'], JSON.stringify(cliInput({ checkedUntil: '2026-10-15T11:00:00Z' })));
    // The password change at 12:00 is after it; the login at 10:00 is not.
    expect(r.stdout).toContain(' operatorSessions=0 rootPasswordChanges=1 ');
    const later = cli(['reconcile'], JSON.stringify(cliInput({ checkedUntil: '2026-10-15T13:00:00Z' })));
    expect(later.stdout).toContain(' operatorSessions=0 rootPasswordChanges=0 ');
  });

  it('reports a keyboard-interactive-only login before the verbose marker without failing', () => {
    const extra = [{ __REALTIME_TIMESTAMP: usAt('2026-10-15T14:00:07Z'), _PID: '5400', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.70 port 40100 ssh2' }];
    const r = cli(['reconcile'], JSON.stringify(cliInput({ extra, verboseSinceB64: null })));
    expect(r.stdout).toContain(' preVerboseLogins=1');
    expect(r.status).toBe(0);
    const after = cli(['reconcile'], JSON.stringify(cliInput({ extra })));
    expect(after.stdout).toContain(' singleFactorLogins=1 ');
    expect(after.status).toBe(1);
  });

  it.each([
    ['not JSON', 'nope'],
    ['no rows', JSON.stringify(cliInput({ db: { rows: undefined } }))],
    ['a row with a bad hash', JSON.stringify(cliInput({ db: { rows: [{ ...chain(['2026-10-15T09:00:05.123Z'])[0], hash: 'x' }] } }))],
    ['an anchor that is not a row', JSON.stringify(cliInput({ db: { anchor: { seq: 1 } } }))],
    ['a stored state that is not a seq and a hash', JSON.stringify(cliInput({ state: { seq: -1, hash: 'x' } }))],
    ['a max seq that is not a number', JSON.stringify(cliInput({ db: { maxSeq: 'ten' } }))],
    ['a switch time that is not a time', JSON.stringify(cliInput({ twoFactorSinceB64: b64('soon\n') }))],
    ['a verbose time that is not a time', JSON.stringify(cliInput({ verboseSinceB64: b64('later\n') }))],
    ['an empty allowlist', JSON.stringify(cliInput({ allowedKeysB64: '' }))],
    ['a window that ends before it starts', JSON.stringify(cliInput({ since: '2026-10-16T00:00:00Z', until: '2026-10-15T00:00:00Z' }))],
    ['a tolerance that is not a number of seconds', JSON.stringify(cliInput({ toleranceSec: 'five' }))],
    ['a checkedUntil that is not a time', JSON.stringify(cliInput({ checkedUntil: 'last night' }))],
    ['a futureNamedFiles that is not a count', JSON.stringify(cliInput({ futureNamedFiles: -1 }))],
    ['no now', JSON.stringify(cliInput({ now: undefined }))],
    ['a now that is not a time', JSON.stringify(cliInput({ now: 'soon' }))],
    ['a truncated journal', JSON.stringify(cliInput({ journalB64: b64('MESSAGE=x\n') }))],
  ])('refuses %s with exit 2, no counts and no data', (_name, input) => {
    const r = cli(['reconcile'], input);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^auditlog: /);
    expect(r.stderr).not.toContain(FP_OPERATOR);
    expect(r.stderr).not.toContain('203.0.113');
  });

  it('lists expired names from stdin', () => {
    const r = cli(['expired', '2026-10-15'], 'auditlog-2026-07-16T000500Z.journal.gz\nauditlog-2026-10-15T010500Z.journal.gz\n');
    expect(r).toEqual({ status: 0, stdout: 'auditlog-2026-07-16T000500Z.journal.gz\n', stderr: '' });
    expect(cli(['expired', 'later'], '').status).toBe(2);
    expect(cli(['bogus'], '').status).toBe(2);
  });
});
