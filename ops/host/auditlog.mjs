// The daily reconcile of the host's shipped audit log against the integrity log, and the
// retention rule for what is shipped (RL 7.13; G2-22; Task 22).
//
// makrai-auditlog-reconcile.sh runs it inside the web image, offline, with this directory
// mounted read-only:
//
//   docker run --rm -i --pull never --network none -v /srv/makrai/app/ops/host:/ops:ro \
//     --entrypoint node "$WEB_IMAGE" /ops/auditlog.mjs reconcile < input.json
//
// and makrai-auditlog-ship.sh runs `... /ops/auditlog.mjs expired <YYYY-MM-DD>` with the
// Storage Box's file names on stdin, one per line, to choose what to delete.
//
// Built-ins only: nothing else is installed for it in that image.
//
// WHAT IT PRINTS. `reconcile` prints one line of counts and nothing else:
//
//   records=<n> rows=<n> matched=<n> consoleLoginsWithoutEntry=<n> entriesWithoutLogin=<n>
//   unknownKeyLogins=<n> singleFactorLogins=<n> chainBreaks=<n> hashMismatches=<n>
//   noticeFailures=<n> sudoToRoot=<n> operatorSessions=<n> rootPasswordChanges=<n>
//   rowsWithoutShipped=<n>
//
// (one line, wrapped here). No address, user, key, hash or log text: the counts are the only
// output, on success and on failure. Exit 0: every failure count is zero. Exit 1: one is not.
// Exit 2: the input was refused (stderr names which part, never its value).
//
// THE INPUT, on stdin, is one JSON object the reconcile script builds:
//
//   since, until         the window, ISO 8601 UTC. Journal records are kept when
//                        since <= time < until; the rows were read for the same window.
//   twoFactorSinceB64    /etc/makrai/ssh-two-factor-since, base64, or null when the file
//                        does not exist (before Task 23's switch)
//   allowedKeysB64       /etc/makrai/allowed-keys.fp, base64: `SHA256:<fp> <label>` lines
//   rows                 integrity_log rows, as { seq, prevHash, hash, atUtc, kind, actorRef,
//                        detailText }, read with the renderings entryHash needs
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
/** @typedef {{ at: string; user: string; target: string }} Sudo */
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

const ACCEPTED_OR_PARTIAL = /^(Accepted|Partial) (\S+) for (\S+) from \S+ port \d+ ssh2(?:: (.*?))?(?: \[preauth\])?$/;
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

const CONSOLE_LOGIN = /^pam_unix\(login:session\): session opened for user ([^\s(]+)(?:\(uid=\d+\))?(?: by .*)?$/;

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
 * sudo's command lines: `<user> : [<problem> ; ]TTY=... ; PWD=... ; USER=<target> ; COMMAND=...`.
 * A refused attempt is read too: an attempt to become root is what the check is for.
 *
 * PWD and COMMAND are the caller's own text and can hold ` ; USER=postgres ; `. So the target
 * is root when ANY `USER=root` field is present, and otherwise the first USER= field: a forged
 * field can add a false alarm, never hide a real root target.
 *
 * @param {Line[]} lines
 * @returns {Sudo[]}
 */
export function sudoFrom(lines) {
  return lines.flatMap(({ at, message }) => {
    const m = /^\s*([^\s:]+) : (.*)$/.exec(message);
    if (!m) return [];
    const fields = m[2].split(' ; ');
    const targets = fields.filter((f) => f.startsWith('USER=')).map((f) => f.slice(5));
    if (targets.length === 0 || !fields.some((f) => f.startsWith('COMMAND='))) return [];
    return [{ at, user: m[1], target: targets.includes('root') ? 'root' : targets[0] }];
  });
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
 *   passwordChanges: UserAt[];
 *   sudo: Sudo[];
 *   shipped: Shipped[];
 *   rows: Row[];
 *   allowed: Allowed[];
 * }} input
 * @param {number} [toleranceSec] how far apart a console login and its entry may be
 */
export function reconcile(input, toleranceSec = 300) {
  const { sshLogins, consoleLogins, twoFactorSince, passwordChanges, sudo, shipped, rows, allowed } = input;

  // Console logins and break_glass.open entries, paired one to one: each login takes the
  // nearest unpaired entry within the tolerance.
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
      matched += 1;
    } else {
      consoleLoginsWithoutEntry.push(login);
    }
  }
  const entriesWithoutLogin = entries.filter((e) => !e.paired).map(({ seq, at }) => ({ seq, at }));

  // SSH: a key on the allowlist, and from the switch on, the key and then the code.
  const keys = new Set(allowed.map((a) => a.fingerprint));
  const unknownKeyLogins = sshLogins.filter((l) => l.fingerprint === null || !keys.has(l.fingerprint));
  const since = twoFactorSince === null ? null : ms(twoFactorSince);
  const singleFactorLogins = sshLogins.filter(
    (l) => since !== null && ms(l.at) >= since && !(l.methods.length === 2 && l.methods.every((m, i) => m === TWO_FACTOR[i])),
  );

  // The chain, in seq order. A window may start mid-chain; seq 1 starts at the genesis.
  const bySeq = [...rows].sort((a, b) => a.seq - b.seq);
  /** @type {number[]} */
  const chainBreaks = [];
  bySeq.forEach((r, i) => {
    if (i === 0) {
      if (r.seq === 1 && r.prevHash !== GENESIS) chainBreaks.push(r.seq);
      return;
    }
    const p = bySeq[i - 1];
    if (r.seq !== p.seq + 1 || r.prevHash !== p.hash) chainBreaks.push(r.seq);
  });

  // A row that no longer reproduces its own hash, or the hash shipped for it, was rewritten.
  // A shipped entry with no row is a hash no row reproduces: the row was removed.
  const rowAt = new Map(rows.map((r) => [r.seq, r]));
  /** @type {Set<number>} */
  const mismatched = new Set();
  for (const r of rows) if (entryHash(r) !== r.hash) mismatched.add(r.seq);
  for (const s of shipped) {
    if (s.seq === 0) continue;
    const r = rowAt.get(s.seq);
    if (!r || entryHash(r) !== s.hash) mismatched.add(s.seq);
  }
  const hashMismatches = [...mismatched].sort((a, b) => a - b);

  const shippedHashes = new Set(shipped.map((s) => s.hash).filter(Boolean));
  const rowsWithoutShipped = bySeq.filter((r) => !shippedHashes.has(r.hash)).map((r) => r.seq);

  return {
    matched,
    consoleLoginsWithoutEntry,
    entriesWithoutLogin,
    unknownKeyLogins,
    singleFactorLogins,
    chainBreaks,
    hashMismatches,
    noticeFailures: shipped.filter((s) => s.notice !== 'sent').length,
    sudoToRoot: sudo.filter((s) => s.user !== 'root' && s.target === 'root'),
    operatorSessions: sshLogins.length,
    rootPasswordChanges: passwordChanges.filter((p) => p.user === 'root').length,
    rowsWithoutShipped,
  };
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
]);
/** Reported, never failing. */
const INFORMATIONAL = new Set(['matched', 'operatorSessions', 'rootPasswordChanges']);

/** @param {unknown} v */
const count = (v) => (Array.isArray(v) ? v.length : Number(v));

/**
 * True when any field other than matched, operatorSessions and rootPasswordChanges is
 * non-empty or non-zero.
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

/** @param {unknown} v @returns {Row[]} */
function rowsFrom(v) {
  if (!Array.isArray(v)) throw new InputError('rows is not an array');
  return v.map((r, i) => {
    const ok =
      r !== null &&
      typeof r === 'object' &&
      Number.isSafeInteger(r.seq) &&
      r.seq > 0 &&
      HEX64.test(r.prevHash) &&
      HEX64.test(r.hash) &&
      typeof r.atUtc === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.atUtc) &&
      typeof r.kind === 'string' &&
      typeof r.actorRef === 'string' &&
      typeof r.detailText === 'string';
    if (!ok) throw new InputError(`row ${i + 1} is not a well-formed integrity_log row`);
    return { seq: r.seq, prevHash: r.prevHash, hash: r.hash, atUtc: r.atUtc, kind: r.kind, actorRef: r.actorRef, detailText: r.detailText };
  });
}

/**
 * The CLI's reconcile: parse, keep the window, extract, reconcile, and return the counts.
 *
 * @param {string} text the JSON on stdin
 * @returns {{ line: string; failed: boolean }}
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

  let twoFactorSince = null;
  if (input.twoFactorSinceB64 !== null) {
    const raw = base64Text(input.twoFactorSinceB64, 'twoFactorSinceB64').toString('utf8');
    twoFactorSince = isoInstant(raw.endsWith('\n') ? raw.slice(0, -1) : raw, 'the two-factor switch time');
  }
  const allowed = allowedFrom(base64Text(input.allowedKeysB64, 'allowedKeysB64').toString('utf8'));
  const rows = rowsFrom(input.rows);

  // The shipped records in the window, each once: a ship that died after its copy and before
  // moving its cursor ships the same records again, under the same cursor.
  const seen = new Set();
  const records = parseExport(base64Text(input.journalB64, 'journalB64')).filter((r) => {
    const t = Number(r.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(t)) throw new InputError('a journal record has no time');
    if (t < since || t >= until) return false;
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
    ident: r.SYSLOG_IDENTIFIER ?? '',
    message: r.MESSAGE ?? '',
  }));
  const from = (/** @type {string[]} */ comms) => lines.filter((l) => comms.includes(l.comm));

  const result = reconcile({
    sshLogins: sshLoginsFrom(from(['sshd', 'sshd-session'])),
    consoleLogins: consoleLoginsFrom(from(['login'])),
    twoFactorSince,
    passwordChanges: passwordChangesFrom(from(['passwd', 'chpasswd'])),
    sudo: sudoFrom(from(['sudo'])),
    shipped: shippedFrom(lines.filter((l) => l.ident === 'makrai-break-glass')),
    rows,
    allowed,
  });
  return { line: `records=${records.length} rows=${rows.length} ${countsLine(result)}`, failed: failed(result) };
}

/**
 * @param {string[]} argv
 * @param {string} stdin
 * @returns {{ status: number; stdout: string }}
 */
function main(argv, stdin) {
  if (argv[0] === 'reconcile' && argv.length === 1) {
    const { line, failed: bad } = reconcileInput(stdin);
    return { status: bad ? 1 : 0, stdout: `${line}\n` };
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
