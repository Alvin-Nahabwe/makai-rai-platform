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
        'rowsWithoutShipped=0 preVerboseLogins=0',
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
      { at: 't4', user: 'operator', target: 'root' },
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

  it('counts the pam session opened for root by a non-root user, once per sudo process', () => {
    expect(
      sudoFrom([
        { at: 't1', pid: 81, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't2', pid: 82, message: 'operator : TTY=pts/0 ; PWD=/srv ; USER=root ; COMMAND=/usr/bin/id' },
        { at: 't2', pid: 82, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by operator(uid=1000)' },
        { at: 't3', pid: 83, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by root(uid=0)' },
        { at: 't4', pid: 84, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by (uid=1000)' },
      ]),
    ).toEqual([
      { at: 't1', user: 'operator', target: 'root' },
      { at: 't2', user: 'operator', target: 'root' },
      { at: 't3', user: 'root', target: 'root' },
      { at: 't4', user: 'uid=1000', target: 'root' },
    ]);
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
        'preVerboseLogins=0\n' +
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
