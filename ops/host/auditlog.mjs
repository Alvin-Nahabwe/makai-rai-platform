// The daily reconcile of the host's shipped audit log against the integrity log, and the
// retention rule for what is shipped (RL 7.13; G2-22; Task 22).
//
// makrai-auditlog-reconcile.sh runs it inside the web image, offline, from ROOT'S installed
// copy (/usr/local/lib/makrai, staged and hash-checked; never the operator's checkout: T22-3),
// mounted read-only:
//
//   docker run --rm -i --pull never --network none -v /usr/local/lib/makrai:/ops:ro \
//     --entrypoint node "$WEB_IMAGE" /ops/auditlog.mjs reconcile < input.json
//
// and makrai-auditlog-ship.sh runs `... /ops/auditlog.mjs expired <YYYY-MM-DD>` with the
// Storage Box's file names on stdin, one per line, to choose what to delete.
//
// Built-ins only: nothing else is installed for it in that image.
//
// WHAT IT PRINTS. `reconcile` prints two lines. The first is the counts, and nothing else:
//
//   records=<n> rows=<n> matched=<n> consoleLoginsWithoutEntry=<n> entriesWithoutLogin=<n>
//   unknownKeyLogins=<n> singleFactorLogins=<n> chainBreaks=<n> hashMismatches=<n>
//   noticeFailures=<n> sudoToRoot=<n> operatorSessions=<n> rootPasswordChanges=<n>
//   rowsWithoutShipped=<n> preVerboseLogins=<n> backdatedRows=<n> futureRows=<n>
//   futureNamedFiles=<n>
//
// (one line, wrapped here). The second is the state the script stores after a pass:
//
//   checked_until=<until - tolerance> seq=<n> hash=<64 hex>
//
// No address, user, key or log text. Exit 0: every failure count is zero. Exit 1: one is not.
// Exit 2: the input was refused (stderr names which part, never its value).
//
// THE INPUT, on stdin, is one JSON object the reconcile script builds:
//
//   since, until         the window, ISO 8601 UTC. Items are FLAGGED when they fall in
//                        [since, until - tolerance]; journal records and rows from
//                        since - tolerance up to until are read, so a login or row just
//                        outside that band can still pair with one inside it (T22-2)
//   toleranceSec         how far apart a console login and its entry may be, and the margin
//   twoFactorSinceB64    /etc/makrai/ssh-two-factor-since, base64, or null when the file
//                        does not exist (before Task 23's switch)
//   verboseSinceB64      /etc/makrai/ssh-verbose-since (when LogLevel VERBOSE went in), base64,
//                        or null
//   allowedKeysB64       /etc/makrai/allowed-keys.fp, base64: `SHA256:<fp> <label>` lines
//   state                { seq, hash } from the last good run, or null
//   checkedUntil         that run's checked_until, or null: operatorSessions and
//                        rootPasswordChanges count only what is after it (T22R1A-6)
//   futureNamedFiles     how many shipped files are named after now + 5 min: left out of the
//                        window, and reported at the end of the counts line (L-F3)
//   now                  the script's clock, read after the rows were (ISO 8601 UTC, rounded
//                        up to the second): a row read by seq and dated after it counts in
//                        futureRows (L3-2)
//   db                   { rows, anchor, stateRow, maxSeq }: the integrity_log rows as ONE
//                        contiguous seq range, from the row after the stored seq or from the
//                        first row dated in the window's reach, whichever is lower, to the
//                        last (L3-2), as { seq, prevHash, hash, atUtc, kind, actorRef,
//                        detailText } read with the renderings entryHash needs; the row just
//                        before the first of them; the row at the stored seq; and max(seq). The
//                        last three may be null.
//   journalB64           the shipped files, decompressed and concatenated, base64: the
//                        output of `journalctl -o export`
//
// The text files travel as base64 so that nothing in them has to be quoted by a shell.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { entryHash } from './integrity-hash.mjs';

const GENESIS = '0'.repeat(64);
const TWO_FACTOR = ['publickey', 'keyboard-interactive/pam'];

/** @typedef {{ at: string; pid: number; message: string }} PidLine */
/** @typedef {{ at: string; message: string }} Line */
/** @typedef {{ at: string; user: string; fingerprint: string | null; methods: string[] }} SshLogin */
/** @typedef {{ at: string; user: string }} UserAt */
/** @typedef {{ at: string; user: string; target: string; uid?: number; anyCaller?: boolean }} Sudo */
/** @typedef {{ entry: string; seq: number; hash: string; notice: string }} Shipped */
/** @typedef {{ seq: number; prevHash: string; hash: string; atUtc: string; kind: string; actorRef: string; detailText: string }} Row */
/** @typedef {{ fingerprint: string; label: string }} Allowed */

/** A refusal: the message names what was wrong, never the value. */
class InputError extends Error {}

const ms = (/** @type {string} */ iso) => Date.parse(iso);

// --- journalctl -o export ---------------------------------------------------------------
//
// systemd's Journal Export Format: each record is a run of fields ended by an empty line. A
// text field is `NAME=value\n`. A field whose value is binary or holds a newline is `NAME\n`,
// then its length as a little-endian 64-bit integer, then the bytes, then `\n`.

/**
 * @param {Buffer} buf
 * @returns {Record<string, string>[]}
 */
export function parseExport(buf) {
  /** @type {Record<string, string>[]} */
  const records = [];
  /** @type {Record<string, string>} */
  let record = {};
  let fields = 0;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) throw new InputError('the journal export ends inside a field');
    if (nl === i) {
      if (fields > 0) records.push(record);
      record = {};
      fields = 0;
      i = nl + 1;
      continue;
    }
    const line = buf.subarray(i, nl);
    const eq = line.indexOf(0x3d);
    if (eq > 0) {
      record[line.subarray(0, eq).toString('utf8')] = line.subarray(eq + 1).toString('utf8');
      i = nl + 1;
    } else {
      const name = line.toString('utf8');
      if (nl + 9 > buf.length) throw new InputError('the journal export ends inside a binary field');
      const len = Number(buf.readBigUInt64LE(nl + 1));
      const start = nl + 9;
      if (start + len + 1 > buf.length || buf[start + len] !== 0x0a) {
        throw new InputError('the journal export ends inside a binary field');
      }
      record[name] = buf.subarray(start, start + len).toString('utf8');
      i = start + len + 1;
    }
    fields += 1;
  }
  if (fields > 0) throw new InputError('the journal export ends inside a record');
  return records;
}

// --- The lines the reconcile reads ------------------------------------------------------
//
// Every expression that runs over text a caller controls uses [\s\S], never `.`: in JavaScript
// `.` stops at U+2028 and U+2029, and a line that fails its expression is a line not counted
// (L-F2).

const ACCEPTED_OR_PARTIAL = /^(Accepted|Partial) (\S+) for (\S+) from \S+ port \d+ ssh2(?:: ([\s\S]*?))?(?: \[preauth\])?$/;
const FINGERPRINT = /(?:^|\s)(SHA256:[A-Za-z0-9+/]{43})(?=$|\s)/;

/**
 * One login per `Accepted <method> for <user>` line. Its methods are the same sshd pid's
 * `Partial <method>` lines since that connection began, in order, then the accepted method;
 * its fingerprint is the first SHA256 fingerprint any of those lines carries. A `Connection
 * from` line starts a new connection on its pid. Everything else is ignored: bots' failures,
 * and a partial success that never ends in an acceptance, are not logins.
 *
 * @param {PidLine[]} lines
 * @returns {SshLogin[]}
 */
export function sshLoginsFrom(lines) {
  /** @type {Map<number, { methods: string[]; fingerprint: string | null }>} */
  const pending = new Map();
  /** @type {SshLogin[]} */
  const logins = [];
  for (const { at, pid, message } of lines) {
    if (message.startsWith('Connection from ')) {
      pending.delete(pid);
      continue;
    }
    const m = ACCEPTED_OR_PARTIAL.exec(message);
    if (!m) continue;
    const [, kind, method, user, extra] = m;
    const fp = extra ? FINGERPRINT.exec(extra)?.[1] ?? null : null;
    const so_far = pending.get(pid) ?? { methods: [], fingerprint: null };
    so_far.methods.push(method);
    so_far.fingerprint ??= fp;
    if (kind === 'Partial') {
      pending.set(pid, so_far);
    } else {
      pending.delete(pid);
      logins.push({ at, user, fingerprint: so_far.fingerprint, methods: so_far.methods });
    }
  }
  return logins;
}

const CONSOLE_LOGIN = /^pam_unix\(login:session\): session opened for user ([^\s(]+)(?:\(uid=\d+\))?(?: by [\s\S]*)?$/;

/**
 * Console logins: login(1)'s `pam_unix(login:session): session opened for user <user>` lines.
 * The Task 21 drill recorded the user as `root(uid=0)`; the uid is not part of the name.
 *
 * @param {Line[]} lines
 * @returns {UserAt[]}
 */
export function consoleLoginsFrom(lines) {
  return lines.flatMap(({ at, message }) => {
    const m = CONSOLE_LOGIN.exec(message);
    return m ? [{ at, user: m[1] }] : [];
  });
}

const PASSWORD_CHANGED = /^pam_unix\((?:passwd|chpasswd):chauthtok\): password changed for (\S+)$/;

/**
 * @param {Line[]} lines
 * @returns {UserAt[]}
 */
export function passwordChangesFrom(lines) {
  return lines.flatMap(({ at, message }) => {
    const m = PASSWORD_CHANGED.exec(message);
    return m ? [{ at, user: m[1] }] : [];
  });
}

/**
 * sudo splits a log line longer than its syslog limit (980 bytes) into pieces, each after the
 * first logged as `<user> : (command continued) <rest>`, cut at a space where it can be. Joined
 * back to the previous line of the same sudo process with that space, the line reads as it was
 * written (T22-R-A1). A piece with no earlier line on its pid stands alone, marker removed.
 *
 * @param {{ at: string; pid?: number; message: string }[]} lines
 * @returns {{ at: string; pid?: number; message: string }[]}
 */
export function joinContinued(lines) {
  /** @type {{ at: string; pid?: number; message: string }[]} */
  const out = [];
  for (const line of lines) {
    const m = /^(\s*[^\s:]* : )\(command continued\) ?([\s\S]*)$/.exec(line.message);
    if (m) {
      let prev = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].pid === line.pid) {
          prev = i;
          break;
        }
      }
      if (prev >= 0 && line.pid !== undefined) {
        out[prev] = { ...out[prev], message: `${out[prev].message} ${m[2]}` };
        continue;
      }
      out.push({ ...line, message: m[1] + m[2] });
      continue;
    }
    out.push(line);
  }
  return out;
}

const ROOT_SESSION = /^pam_unix\((?:sudo|sudo-i|su|su-l|polkit-1):session\): session opened for user ([^\s(]+)(?:\(uid=\d+\))? by ([^\s(]*)\(uid=(\d+)\)/;
const SU_AUTH_FAILURE = /^pam_unix\((?:su|su-l):auth\): authentication failure;([\s\S]*)$/;
const POLKIT_AUTH_FAILURE = /^pam_unix\(polkit-1:auth\): authentication failure([\s\S]*)$/;
// polkitd: `Operator of <session> successfully authenticated as unix-user:<name or uid> to gain
// ONE-SHOT|TEMPORARY authorization for action <id> for <subject> [<its command line>] (owned by
// unix-user:<name or uid>)`. The command line is the caller's text, so the owner is read only
// at the end of the line, where polkitd puts it.
const POLKITD_AS_ROOT = / successfully authenticated as unix-user[: ](?:root|0)(?=\s|$)/;
const POLKITD_OWNER = /\(owned by unix-user:([^\s()]*)\)\s*$/;
const FAILED_SU = /^FAILED SU \(to ([^\s)]+)\) (\S+)(?: on [\s\S]*)?$/;
const PKEXEC = /^([^\s:]+): ([\s\S]*\[USER=[\s\S]*)$/;

/**
 * Elevation to root, or an attempt at it, by a non-root user, via sudo, sudoedit, su or pkexec:
 *   - sudo's (and sudoedit's) command line,
 *     `<user> : [<problem> ; ]TTY=... ; PWD=... ; USER=<target> ; COMMAND=...`, a refused
 *     attempt included;
 *   - `pam_unix(<service>:session): session opened for user root(uid=0) by <user>(uid=N)` for
 *     the PAM services sudo, sudo-i (`sudo -i`), su, su-l (`su -l`) and polkit-1 (pkexec's own
 *     session, short enough to be logged when its Executing line, which carries the whole
 *     command line, is too large to send: L3-1). sudo never splits it.
 *   - su's refused attempts: `pam_unix(su[-l]:auth): authentication failure; ... uid=N ...
 *     ruser=<name> ... user=<target>`, and `FAILED SU (to <target>) <user> on <tty>` (A-1);
 *   - pkexec's lines, `<user>: Executing command [USER=<target>] ...` and its refusals and
 *     warnings, `<user>: <message> [USER=<target>] ...` (A-1);
 *   - every `pam_unix(polkit-1:auth): authentication failure` line, from polkit's agent helper,
 *     whoever it names (anyCaller): nothing on this headless host should ever authenticate
 *     through polkit, so any failure is an attempt (L3-1). It names the admin who
 *     authenticated, not a target; polkit authenticates for root's authority, so the target is
 *     root;
 *   - polkitd's `... successfully authenticated as unix-user:root ...`, which grants an admin
 *     authorisation, when the subject that asked is not root by the `(owned by ...)` at the end
 *     of the line, or when no owner can be read there (L4-1).
 *
 * With contentOnly, only the lines that say what they are whoever logged them are read: the
 * PAM sessions and failures, FAILED SU and polkitd. sudo's and pkexec's own command lines,
 * `<user> : ... USER=` and `<user>: ... [USER=`, need sudo's or pkexec's identity, which the
 * caller of sudoFrom checks (L4-1).
 * The caller is root only when its uid is 0, where the line gives a uid (the name is the
 * caller's to choose, the uid is not); elsewhere when its name is root. An empty name is
 * reported as `uid=N`.
 *
 * PWD, COMMAND, CWD and an environment variable's name are the caller's own text and can hold
 * ` ; USER=postgres ; ` or `[USER=postgres]`, and a line cut short may lack COMMAND. So the
 * target is root when ANY USER=root token is present, and otherwise the first: a forged token
 * can add a false alarm, never hide a real root target. Every line counts on its own: no line, a
 * root one included, can suppress another (T22R1A-1), and one elevation that logs several lines
 * counts several times, which fails the same way.
 *
 * @param {{ at: string; pid?: number; message: string }[]} lines
 * @param {{ contentOnly?: boolean }} [options]
 * @returns {Sudo[]}
 */
export function sudoFrom(lines, { contentOnly = false } = {}) {
  /** @type {Sudo[]} */
  const out = [];
  const named = (/** @type {string} */ name, /** @type {number} */ uid) => (name === '' ? `uid=${uid}` : name);
  for (const { at, message } of lines) {
    const session = ROOT_SESSION.exec(message);
    if (session) {
      const uid = Number(session[3]);
      out.push({ at, user: named(session[2], uid), target: session[1], uid });
      continue;
    }
    const polkit = POLKIT_AUTH_FAILURE.exec(message);
    if (polkit) {
      const ruser = /(?:^|\s)ruser=(\S*)/.exec(polkit[1])?.[1];
      out.push({ at, user: ruser || 'unknown', target: 'root', anyCaller: true });
      continue;
    }
    if (POLKITD_AS_ROOT.test(message)) {
      const owner = POLKITD_OWNER.exec(message)?.[1] ?? '';
      if (/^\d+$/.test(owner)) out.push({ at, user: named('', Number(owner)), target: 'root', uid: Number(owner) });
      else out.push({ at, user: owner || 'unknown', target: 'root' });
      continue;
    }
    const auth = SU_AUTH_FAILURE.exec(message);
    if (auth) {
      const field = (/** @type {string} */ name) => new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(auth[1])?.[1];
      const target = /(?:^|\s)user=(\S*)\s*$/.exec(auth[1])?.[1] ?? '';
      const uidText = field('ruid') ?? field('uid');
      const uid = uidText !== undefined && /^\d+$/.test(uidText) ? Number(uidText) : undefined;
      const name = field('ruser') || field('logname') || '';
      // With no uid on the line, the name decides; an empty one is not root.
      out.push(uid === undefined ? { at, user: name || 'unknown', target } : { at, user: named(name, uid), target, uid });
      continue;
    }
    const failedSu = FAILED_SU.exec(message);
    if (failedSu) {
      out.push({ at, user: failedSu[2], target: failedSu[1] });
      continue;
    }
    if (contentOnly) continue;
    const m = /^\s*([^\s:]+) : ([\s\S]*)$/.exec(message);
    const targets = m ? [...m[2].matchAll(/(?:^|[\s;])USER=([^\s;]+)/g)].map((t) => t[1]) : [];
    if (m && targets.length > 0) {
      out.push({ at, user: m[1], target: targets.includes('root') ? 'root' : targets[0] });
      continue;
    }
    const pk = PKEXEC.exec(message);
    const pkTargets = pk ? [...pk[2].matchAll(/\[USER=([^\]\s]*)\]/g)].map((t) => t[1]) : [];
    if (pk && pkTargets.length > 0) out.push({ at, user: pk[1], target: pkTargets.includes('root') ? 'root' : pkTargets[0] });
  }
  return out;
}

// The grammar of makrai-break-glass-session's journal line, from its header comment. Anything
// else is malformed, and a malformed line counts as a notice failure.
const STATUS = '(sent|failed:(?:\\d{3}|alert|recipients|config|template))((?:;truncated)?)';
const WHY = '(?:missing|symlink|type|owner|read)';
const EXTRAS = `(?: env=${WHY})?(?: text=${WHY})?`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ENTRY_LINE = new RegExp(`^entry=(${UUID}) seq=([1-9]\\d*) hash=([0-9a-f]{64}) notice=${STATUS}${EXTRAS}$`);
const NO_ENTRY_LINE = new RegExp(`^entry=(FAILED|UNCERTAIN) notice=${STATUS}${EXTRAS}$`);

/**
 * The hook's `makrai-break-glass` lines. FAILED and UNCERTAIN carry no seq or hash (0 and '').
 *
 * @param {Line[]} lines
 * @returns {Shipped[]}
 */
export function shippedFrom(lines) {
  return lines.map(({ message }) => {
    const m = ENTRY_LINE.exec(message);
    if (m && Number.isSafeInteger(Number(m[2]))) return { entry: m[1], seq: Number(m[2]), hash: m[3], notice: m[4] + m[5] };
    const n = NO_ENTRY_LINE.exec(message);
    if (n) return { entry: n[1], seq: 0, hash: '', notice: n[2] + n[3] };
    return { entry: 'MALFORMED', seq: 0, hash: '', notice: 'malformed' };
  });
}

/**
 * /etc/makrai/allowed-keys.fp: one `SHA256:<fp> <label>` per line. An empty list is refused:
 * it would make every login an unknown key, or, on a day without logins, pass on nothing.
 *
 * @param {string} text
 * @returns {Allowed[]}
 */
export function allowedFrom(text) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (text === '' || lines.length === 0) throw new InputError('the allowed-keys list is empty');
  return lines.map((line, i) => {
    const m = /^(SHA256:[A-Za-z0-9+/]{43}) ([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new InputError(`allowed-keys line ${i + 1} is not "SHA256:<fp> <label>"`);
    return { fingerprint: m[1], label: m[2] };
  });
}

// --- The reconcile ----------------------------------------------------------------------

/**
 * @param {{
 *   sshLogins: SshLogin[];
 *   consoleLogins: UserAt[];
 *   twoFactorSince: string | null;
 *   verboseSince: string | null;
 *   passwordChanges: UserAt[];
 *   sudo: Sudo[];
 *   shipped: Shipped[];
 *   rows: Row[];
 *   allowed: Allowed[];
 *   window: { from: string; to: string; infoFrom?: string } | null;
 *   anchor: Row | null;
 *   state: { seq: number; hash: string } | null;
 *   stateRow: Row | null;
 *   maxSeq: number | null;
 *   now?: string | null;
 * }} input
 *   window    the flag band: only items whose time is within it (both ends included) are
 *             flagged or counted; everything given is still used for pairing. null flags all.
 *             infoFrom, when given, is the last run's checked_until: operatorSessions and
 *             rootPasswordChanges count only what is after it, so two nights never count the
 *             same event (T22R1A-6); the failure fields still start at `from`.
 *   anchor    the integrity row just before the rows given (null: there is none)
 *   state     the seq and hash the last good reconcile stored (null: first run); stateRow is
 *             the row now at that seq (null: gone), maxSeq the table's max(seq)
 *   now       the script's clock after the rows were read: a row read by seq (above the stored
 *             seq, or above 0 with none stored) and dated after it is clock-step evidence, and
 *             counts in futureRows, which fails (L3-2). null: not checked.
 * @param {number} [toleranceSec] how far apart a console login and its entry may be
 */
export function reconcile(input, toleranceSec = 300) {
  const { sshLogins, consoleLogins, twoFactorSince, verboseSince, passwordChanges, sudo, shipped, rows, allowed } = input;
  const { window = null, anchor = null, state = null, stateRow = null, maxSeq = null, now = null } = input;
  const inBand = (/** @type {string | undefined} */ at) =>
    window === null || at === undefined || (ms(at) >= ms(window.from) && ms(at) <= ms(window.to));
  // A row read because its seq is above the stored one is evidence whatever its time: a clock
  // that ran behind when it was written must not move it out of the band (L-F4). It is held to
  // the evidence checks up to the band's end (the tail stays the next night's, SQ-3), and one
  // dated before the band's start is reported as back-dated, which fails. A row at or below the
  // stored seq, read only because the range is contiguous, counts for nothing outside the band
  // but the chain (L3-2).
  const seqRead = (/** @type {number} */ seq) => state !== null && seq > state.seq;
  const inEvidence = (/** @type {number} */ seq, /** @type {string} */ at) =>
    inBand(at) || (seqRead(seq) && (window === null || ms(at) <= ms(window.to)));
  const inInfo = (/** @type {string} */ at) => inBand(at) && (window === null || window.infoFrom === undefined || ms(at) > ms(window.infoFrom));

  // Console logins and break_glass.open entries, paired one to one across everything given:
  // each login takes the nearest unpaired entry within the tolerance. Only what is left over
  // inside the band is flagged.
  const entries = rows.filter((r) => r.kind === 'break_glass.open').map((r) => ({ seq: r.seq, at: r.atUtc, paired: false }));
  /** @type {UserAt[]} */
  const consoleLoginsWithoutEntry = [];
  let matched = 0;
  for (const login of [...consoleLogins].sort((a, b) => ms(a.at) - ms(b.at))) {
    let best = null;
    for (const e of entries) {
      if (e.paired) continue;
      const d = Math.abs(ms(e.at) - ms(login.at));
      if (d <= toleranceSec * 1000 && (best === null || d < best.d)) best = { e, d };
    }
    if (best) {
      best.e.paired = true;
      if (inBand(login.at)) matched += 1;
    } else if (inBand(login.at)) {
      consoleLoginsWithoutEntry.push(login);
    }
  }
  const entriesWithoutLogin = entries.filter((e) => !e.paired && inEvidence(e.seq, e.at)).map(({ seq, at }) => ({ seq, at }));

  // SSH: a key on the allowlist, and from the switch on, the key and then the code. A login
  // with only keyboard-interactive, from the switch until LogLevel VERBOSE went in, is how a
  // two-factor login was logged then (no Partial line): reported, not failed (T22-4).
  const keys = new Set(allowed.map((a) => a.fingerprint));
  const switched = twoFactorSince === null ? null : ms(twoFactorSince);
  const verbose = verboseSince === null ? null : ms(verboseSince);
  const banded = sshLogins.filter((l) => inBand(l.at));
  const kiOnly = (/** @type {SshLogin} */ l) => l.methods.length === 1 && l.methods[0] === 'keyboard-interactive/pam';
  const preVerbose = (/** @type {SshLogin} */ l) => switched !== null && ms(l.at) >= switched && (verbose === null || ms(l.at) < verbose) && kiOnly(l);
  const preVerboseLogins = banded.filter(preVerbose);
  const unknownKeyLogins = banded.filter((l) => !preVerbose(l) && (l.fingerprint === null || !keys.has(l.fingerprint)));
  const singleFactorLogins = banded.filter(
    (l) => !preVerbose(l) && switched !== null && ms(l.at) >= switched && !(l.methods.length === 2 && l.methods.every((m, i) => m === TWO_FACTOR[i])),
  );

  // The chain, in seq order: linked to the row before the window, and to what the last good
  // run stored. The rows are one contiguous seq range (L3-2), so neighbours here are neighbours
  // in the table, and a gap is a row that is gone.
  const bySeq = [...rows].sort((a, b) => a.seq - b.seq);
  /** @type {number[]} */
  const chainBreaks = [];
  bySeq.forEach((r, i) => {
    if (i === 0) {
      if (anchor !== null) {
        if (r.seq !== anchor.seq + 1 || r.prevHash !== anchor.hash) chainBreaks.push(r.seq);
      } else if (r.seq !== 1 || r.prevHash !== GENESIS) {
        // No row before it, so it must be the genesis entry: anything else lost its predecessor.
        chainBreaks.push(r.seq);
      }
      return;
    }
    const p = bySeq[i - 1];
    if (r.seq !== p.seq + 1 || r.prevHash !== p.hash) chainBreaks.push(r.seq);
  });
  if (state !== null && state.seq > 0) {
    if (stateRow === null || stateRow.seq !== state.seq || stateRow.hash !== state.hash) chainBreaks.push(state.seq);
    if (maxSeq === null || maxSeq < state.seq) chainBreaks.push(state.seq);
    // The rows are read from the stored seq on, so the row before them is the stored one. An
    // anchor above it means rows between the two were never read: nothing vouches for them.
    if (anchor !== null && anchor.seq > state.seq) chainBreaks.push(anchor.seq);
  }

  // A row that no longer reproduces its own hash, or the hash shipped for it, was rewritten. A
  // shipped entry after the anchor with no row is a hash no row reproduces: the row was
  // removed. One at or before the anchor is checked against the rows read for it, if any.
  const known = new Map([...[anchor, stateRow].filter((r) => r !== null), ...rows].map((r) => [/** @type {Row} */ (r).seq, /** @type {Row} */ (r)]));
  const anchorSeq = anchor === null ? 0 : anchor.seq;
  /** @type {Set<number>} */
  const mismatched = new Set();
  for (const r of known.values()) if (entryHash(r) !== r.hash) mismatched.add(r.seq);
  for (const s of shipped) {
    if (s.seq === 0) continue;
    const r = known.get(s.seq);
    if (r ? entryHash(r) !== s.hash : s.seq > anchorSeq) mismatched.add(s.seq);
  }
  const hashMismatches = [...mismatched].sort((a, b) => a - b);

  const shippedHashes = new Set(shipped.map((s) => s.hash).filter(Boolean));
  const rowsWithoutShipped = bySeq.filter((r) => inEvidence(r.seq, r.atUtc) && !shippedHashes.has(r.hash)).map((r) => r.seq);
  const backdatedRows = bySeq.filter((r) => window !== null && seqRead(r.seq) && ms(r.atUtc) < ms(window.from)).map((r) => r.seq);
  // The query reads from the stored seq + 1, or from seq 1 with none stored: no row it reads that
  // way may be dated after now (L3-2).
  const futureRows = bySeq.filter((r) => now !== null && r.seq > (state === null ? 0 : state.seq) && ms(r.atUtc) > ms(now)).map((r) => r.seq);

  return {
    matched,
    consoleLoginsWithoutEntry,
    entriesWithoutLogin,
    unknownKeyLogins,
    singleFactorLogins,
    chainBreaks,
    hashMismatches,
    noticeFailures: shipped.filter((s) => inBand(s.at) && s.notice !== 'sent').length,
    // Elevation to root or an attempt at it, by a non-root user, via sudo, sudoedit, su or
    // pkexec (by uid where the line gives one); and any polkit authentication failure.
    sudoToRoot: sudo.filter(
      (s) => inBand(s.at) && s.target === 'root' && (s.anyCaller === true || (s.uid !== undefined ? s.uid !== 0 : s.user !== 'root')),
    ),
    operatorSessions: banded.filter((l) => inInfo(l.at)).length,
    rootPasswordChanges: passwordChanges.filter((p) => inInfo(p.at) && p.user === 'root').length,
    rowsWithoutShipped,
    preVerboseLogins,
    backdatedRows,
    futureRows,
  };
}

/**
 * What the next run starts from: the band's end, and the last row this run could vouch for:
 * the highest seq at or before the band's end among the rows, the anchor and the stored row.
 * With none, the stored state is kept, or the genesis (seq 0) on a first run over an empty log.
 *
 * @param {{ rows: Row[]; anchor: Row | null; stateRow: Row | null; state: { seq: number; hash: string } | null; to: string }} input
 * @returns {{ checkedUntil: string; seq: number; hash: string }}
 */
export function nextState({ rows, anchor, stateRow, state, to }) {
  const candidates = [...rows.filter((r) => ms(r.atUtc) <= ms(to)), anchor, stateRow].filter((r) => r !== null);
  const last = candidates.reduce((a, r) => (a === null || /** @type {Row} */ (r).seq > a.seq ? /** @type {Row} */ (r) : a), /** @type {Row | null} */ (null));
  const kept = last ?? state ?? { seq: 0, hash: GENESIS };
  return { checkedUntil: to, seq: kept.seq, hash: kept.hash };
}

/** @typedef {ReturnType<typeof reconcile>} Result */

const FIELDS = /** @type {const} */ ([
  'matched',
  'consoleLoginsWithoutEntry',
  'entriesWithoutLogin',
  'unknownKeyLogins',
  'singleFactorLogins',
  'chainBreaks',
  'hashMismatches',
  'noticeFailures',
  'sudoToRoot',
  'operatorSessions',
  'rootPasswordChanges',
  'rowsWithoutShipped',
  'preVerboseLogins',
  'backdatedRows',
  'futureRows',
]);
/** Reported, never failing. */
const INFORMATIONAL = new Set(['matched', 'operatorSessions', 'rootPasswordChanges', 'preVerboseLogins']);

/** @param {unknown} v */
const count = (v) => (Array.isArray(v) ? v.length : Number(v));

/**
 * True when any field other than matched, operatorSessions, rootPasswordChanges and
 * preVerboseLogins is non-empty or non-zero.
 *
 * @param {Result} result
 */
export function failed(result) {
  return FIELDS.some((f) => !INFORMATIONAL.has(f) && count(result[f]) !== 0);
}

/**
 * The result as `name=<count>` pairs, in a fixed order.
 *
 * @param {Result} result
 */
export function countsLine(result) {
  return FIELDS.map((f) => `${f}=${count(result[f])}`).join(' ');
}

// --- Retention --------------------------------------------------------------------------

const DATED_NAME = [/^auditlog-(\d{4}-\d{2}-\d{2})T\d{6}Z\.journal\.gz$/, /^pre-fix-(\d{4}-\d{2}-\d{2})\.json\.gz$/];

/** A real calendar date, as epoch ms, or NaN. */
function dayMs(/** @type {string} */ ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return NaN;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== ymd ? NaN : t;
}

/**
 * The names whose date is more than `days` days before todayUtc (G2-22: logs are kept 90
 * days). Only the two names the ship and the pre-fix export write are ever selected; any
 * other file on the box is never touched, however old its name looks.
 *
 * @param {string[]} names
 * @param {string} todayUtc YYYY-MM-DD
 * @param {number} [days]
 * @returns {string[]}
 */
export function expiredNames(names, todayUtc, days = 90) {
  const today = dayMs(todayUtc);
  if (Number.isNaN(today)) throw new InputError('today is not a YYYY-MM-DD date');
  return names.filter((name) => {
    const ymd = DATED_NAME.map((re) => re.exec(name)?.[1]).find(Boolean);
    if (!ymd) return false;
    const t = dayMs(ymd);
    return !Number.isNaN(t) && (today - t) / 86_400_000 > days;
  });
}

// --- The command line -------------------------------------------------------------------

const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** @param {unknown} v @param {string} what */
function isoInstant(v, what) {
  if (typeof v !== 'string' || !ISO_SECOND.test(v) || Number.isNaN(ms(v))) throw new InputError(`${what} is not a UTC time`);
  return v;
}

/** @param {unknown} v @param {string} what */
function base64Text(v, what) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new InputError(`${what} is not base64`);
  return Buffer.from(v, 'base64');
}

const AT_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** @param {any} r @param {string} what @returns {Row} */
function rowFrom(r, what) {
  const ok =
    r !== null &&
    typeof r === 'object' &&
    Number.isSafeInteger(r.seq) &&
    r.seq > 0 &&
    HEX64.test(r.prevHash) &&
    HEX64.test(r.hash) &&
    typeof r.atUtc === 'string' &&
    AT_MS.test(r.atUtc) &&
    typeof r.kind === 'string' &&
    typeof r.actorRef === 'string' &&
    typeof r.detailText === 'string';
  if (!ok) throw new InputError(`${what} is not a well-formed integrity_log row`);
  return { seq: r.seq, prevHash: r.prevHash, hash: r.hash, atUtc: r.atUtc, kind: r.kind, actorRef: r.actorRef, detailText: r.detailText };
}

/** @param {unknown} v @returns {Row[]} */
function rowsFrom(v) {
  if (!Array.isArray(v)) throw new InputError('db.rows is not an array');
  return v.map((r, i) => rowFrom(r, `row ${i + 1}`));
}

/** @param {unknown} v @param {string} what @returns {string | null} */
function optionalInstant(v, what) {
  if (v === null) return null;
  const raw = base64Text(v, what).toString('utf8');
  return isoInstant(raw.endsWith('\n') ? raw.slice(0, -1) : raw, what);
}

/**
 * The CLI's reconcile: parse, keep what the window needs, extract, reconcile, and return the
 * counts and the state to store.
 *
 * The flag band is [since, until - tolerance]. Records and rows are read from since - tolerance
 * up to until, so a login or row just outside the band can still pair with one inside it.
 *
 * @param {string} text the JSON on stdin
 * @returns {{ line: string; state: string; failed: boolean }}
 */
function reconcileInput(text) {
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new InputError('stdin is not JSON');
  }
  if (input === null || typeof input !== 'object') throw new InputError('stdin is not a JSON object');
  const since = ms(isoInstant(input.since, 'since'));
  const until = ms(isoInstant(input.until, 'until'));
  if (!(since < until)) throw new InputError('the window ends before it starts');
  const tol = input.toleranceSec;
  if (!Number.isSafeInteger(tol) || tol < 0 || tol > 3600) throw new InputError('toleranceSec is not a number of seconds');
  const from = since - tol * 1000;
  const to = new Date(until - tol * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const checkedUntil = input.checkedUntil === null ? null : isoInstant(input.checkedUntil, 'checkedUntil');
  const futureNamedFiles = input.futureNamedFiles;
  if (!Number.isSafeInteger(futureNamedFiles) || futureNamedFiles < 0) throw new InputError('futureNamedFiles is not a count');
  const now = isoInstant(input.now, 'now');
  const twoFactorSince = optionalInstant(input.twoFactorSinceB64, 'the two-factor switch time');
  const verboseSince = optionalInstant(input.verboseSinceB64, 'the verbose marker time');
  const allowed = allowedFrom(base64Text(input.allowedKeysB64, 'allowedKeysB64').toString('utf8'));

  let state = null;
  if (input.state !== null) {
    const st = input.state;
    if (st === null || typeof st !== 'object' || !Number.isSafeInteger(st.seq) || st.seq < 0 || !HEX64.test(st.hash)) {
      throw new InputError('state is not a seq and a hash');
    }
    state = { seq: st.seq, hash: st.hash };
  }
  const db = input.db;
  if (db === null || typeof db !== 'object') throw new InputError('db is not an object');
  const rows = rowsFrom(db.rows);
  const anchor = db.anchor === null ? null : rowFrom(db.anchor, 'db.anchor');
  const stateRow = db.stateRow === null ? null : rowFrom(db.stateRow, 'db.stateRow');
  if (!(db.maxSeq === null || (Number.isSafeInteger(db.maxSeq) && db.maxSeq >= 0))) throw new InputError('db.maxSeq is not a number');

  // The shipped records from the window's reach, each once: a ship that died after its copy
  // and before moving its cursor ships the same records again, under the same cursor.
  const seen = new Set();
  const records = parseExport(base64Text(input.journalB64, 'journalB64')).filter((r) => {
    const t = Number(r.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(t)) throw new InputError('a journal record has no time');
    if (t < from || t >= until) return false;
    if (r.__CURSOR !== undefined) {
      if (seen.has(r.__CURSOR)) return false;
      seen.add(r.__CURSOR);
    }
    return true;
  });
  records.sort((a, b) => Number(a.__REALTIME_TIMESTAMP) - Number(b.__REALTIME_TIMESTAMP));

  const lines = records.map((r) => ({
    at: new Date(Number(r.__REALTIME_TIMESTAMP) / 1000).toISOString(),
    pid: Number(r._PID),
    comm: r._COMM ?? '',
    exe: r._EXE ?? '',
    ident: r.SYSLOG_IDENTIFIER ?? '',
    message: r.MESSAGE ?? '',
  }));
  const fromComm = (/** @type {string[]} */ comms) => lines.filter((l) => comms.includes(l.comm));
  // Elevation by executable OR by name: _COMM is the name the caller ran the binary under, so a
  // symlink called anything else would hide it; _EXE is the binary itself (L-F1). polkit's agent
  // helper is read by executable only, as the ship exports it (L3-1). sudo's command lines are
  // also read by sudo's own identity, SYSLOG_IDENTIFIER, which the line carries itself.
  //
  // Both _EXE and _COMM are filled by journald when it reads the line, from what the process is
  // by then: one that execs right after logging, as pkexec does, is credited with the program it
  // ran (L4-1). So every other shipped line is read by its content too, for the lines that say
  // what they are whoever logged them. A forged line can only add an alarm (T22R1A-1).
  const ELEVATION_EXE = ['/usr/bin/sudo', '/usr/bin/su', '/usr/bin/pkexec', '/usr/lib/polkit-1/polkit-agent-helper-1'];
  const ELEVATION_COMM = ['sudo', 'sudoedit', 'su', 'pkexec'];
  const SUDO_IDENT = ['sudo', 'sudoedit'];
  const isElevation = (/** @type {{ exe: string; comm: string; ident: string }} */ l) =>
    ELEVATION_EXE.includes(l.exe) || ELEVATION_COMM.includes(l.comm) || SUDO_IDENT.includes(l.ident);
  const elevation = lines.filter(isElevation);
  const others = lines.filter((l) => !isElevation(l));

  const result = reconcile(
    {
      sshLogins: sshLoginsFrom(fromComm(['sshd', 'sshd-session'])),
      consoleLogins: consoleLoginsFrom(fromComm(['login'])),
      twoFactorSince,
      verboseSince,
      passwordChanges: passwordChangesFrom(fromComm(['passwd', 'chpasswd'])),
      sudo: [...sudoFrom(joinContinued(elevation)), ...sudoFrom(others, { contentOnly: true })],
      shipped: lines
        .filter((l) => l.ident === 'makrai-break-glass')
        .map((l) => ({ ...shippedFrom([l])[0], at: l.at })),
      rows,
      allowed,
      window: { from: new Date(since).toISOString(), to, ...(checkedUntil === null ? {} : { infoFrom: checkedUntil }) },
      anchor,
      state,
      stateRow,
      maxSeq: db.maxSeq,
      now,
    },
    tol,
  );
  const next = nextState({ rows, anchor, stateRow, state, to });
  return {
    line: `records=${records.length} rows=${rows.length} ${countsLine(result)} futureNamedFiles=${futureNamedFiles}`,
    state: `checked_until=${next.checkedUntil} seq=${next.seq} hash=${next.hash}`,
    failed: failed(result),
  };
}

/**
 * @param {string[]} argv
 * @param {string} stdin
 * @returns {{ status: number; stdout: string }}
 */
function main(argv, stdin) {
  if (argv[0] === 'reconcile' && argv.length === 1) {
    const { line, state, failed: bad } = reconcileInput(stdin);
    return { status: bad ? 1 : 0, stdout: `${line}\n${state}\n` };
  }
  if (argv[0] === 'expired' && argv.length === 2) {
    const names = stdin.split('\n').filter((n) => n !== '');
    const out = expiredNames(names, argv[1]);
    return { status: 0, stdout: out.map((n) => `${n}\n`).join('') };
  }
  throw new InputError('usage: auditlog.mjs reconcile < input.json | auditlog.mjs expired <YYYY-MM-DD> < names');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { status, stdout } = main(process.argv.slice(2), readFileSync(0, 'utf8'));
    process.stdout.write(stdout);
    process.exitCode = status;
  } catch (e) {
    // Only an InputError's own message, which names a part and never a value. Anything else
    // is reported by type alone: a stack or a message could quote the input.
    process.stderr.write(`auditlog: ${e instanceof InputError ? e.message : `failed (${e instanceof Error ? e.name : typeof e})`}\n`);
    process.exitCode = 2;
  }
}
