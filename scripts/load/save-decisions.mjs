#!/usr/bin/env node
// Load script for the server response budgets of NFR-PERF-04 (SRS line 3207).
//
//   node scripts/load/save-decisions.mjs --base <url> --users 10 --seconds 60
//
// Signs in `--users` owner or admin seats of the fixture's organisation (from the e2e manifest,
// e2e/fixtures/.auth/manifest.json, which `npx playwright test --project=setup` writes), one seat per virtual
// user and never shared (fewer seats than users exits 2), then runs five operations with the `--users` concurrent
// virtual users for `--seconds`, and prints the 95th percentile of each. Each save has its own text, and a seat
// sends at most 20 seal and 10 document requests in a run, the per-user limits of an hour:
//
//   op=<name> p95ms=<n> budgetms=<300|800|3000|15000|10000> n=<count>
//
//   save-decision      POST   .../projects/<id>/decisions            route 1, 300 ms
//   render-s10-s11     GET    S-10 and S-11 pages, full response     800 ms
//   seal-stage         POST   .../reviews/<id>/seals                  route 13, 3 s
//   generate-document  POST   .../reviews/<id>/documents              route 16, 15 s
//   team-export        GET    .../export, time to first byte          route 20, 10 s
//
// An operation whose route answers 501, or 404 with something other than the API's JSON (the route is not
// there yet: a stub, or a page that does not exist), prints `op=<name> pending` and counts as not measured. A
// JSON 404 (`not_found`) is the route refusing, so it is an error. A pending answer never stops an operation
// that already has samples. `render-s10-s11` keeps each page under its own key, so one page can be measured
// while the other is pending: `op=render-s10-s11 partial pending=S-11 p95ms=...`.
// Other answers than a success are counted: `errors=<k> firstStatus=<s>`; a 409 base_version_moved on a save and the
// export's 429 are counted as `expected409=<k>` and `expected429=<k>` instead, and are not errors. A timeout enters the p95 as 60000 ms.
// The export is limited to 3 an hour per organisation (route 20), so it is timed twice per run at most.
//
// `--only <op>[,<op>]` runs the named operations alone (names as in the table above), so one budget can be measured
// without the others sharing the server: `--only render-s10-s11` sends no save, review, seal, document or export. Each
// operation not named prints `op=<name> skipped` and neither fails the run nor counts as pending. The release run names
// no `--only`: NFR-PERF-04's budgets are met with the five operations running together.
//
// Exit 0: every operation is measured and within budget, or pending with --allow-pending. Exit 1: an operation is
// over budget, or has any error (a 5xx, a timeout, a 403, a 422, a 409 with another code), or measured nothing. Exit 2: refused or
// mis-used before the run: the base is not localhost or 127.0.0.1 (NFR-SEC-17, K-10), an option is out of range,
// or the manifest, a sign-in or the project list failed. Exit 3: an operation is pending or partial and
// --allow-pending was not given; the pending ones are named on stderr. The release run never passes
// --allow-pending: a route that is not there is not a budget met.
//
// Safety: `assertLocalBase` runs before anything is read or sent. Requests are built from the base and a
// fixed path, redirects are never followed, so the session cookies stay on the base's origin. Passwords come
// from the manifest and are never printed.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUDGETS_MS = Object.freeze({
  'save-decision': 300,
  'render-s10-s11': 800,
  'seal-stage': 3000,
  'generate-document': 15000,
  'team-export': 10000,
});
const MAX_USERS = 50;
const MAX_SECONDS = 600;
const EXPORT_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 60_000;
/** What a request that timed out or failed counts as in the p95. */
const TIMEOUT_MS = REQUEST_TIMEOUT_MS;
/** The stats keys of an operation: the render operation keeps one per page. */
const KEYS_OF = Object.freeze({
  'save-decision': [['save-decision', null]],
  'render-s10-s11': [['render-s10', 'S-10'], ['render-s11', 'S-11']],
  'seal-stage': [['seal-stage', null]],
  'generate-document': [['generate-document', null]],
  'team-export': [['team-export', null]],
});
const DEFAULT_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e', 'fixtures', '.auth', 'manifest.json');

class Refused extends Error {}

/**
 * Nearest-rank 95th percentile: the sample at rank ceil(0.95 * n) of the ascending order.
 * @param {readonly number[]} samples
 * @returns {number}
 */
export function p95(samples) {
  if (samples.length === 0) throw new Error('p95: no samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((95 * sorted.length) / 100) - 1];
}

/**
 * Splits `--connect-to <ip>:<port>` and judges it: the port is the text after the last colon and is a whole number from
 * 1 to 65535; the ip is the rest, with one pair of square brackets removed, and is exactly 127.0.0.1 or ::1. So
 * `127.0.0.1:8460`, `[::1]:8460` and `::1:8460` are read, and `127.0.0.1`, `:8460`, `127.0.0.1:0` and every other
 * address or name are refused. A message names the ip and nothing else of the value.
 * @param {string} connectTo
 * @returns {{ ip: string, port: number }}
 */
function splitConnectTo(connectTo) {
  const colon = connectTo.lastIndexOf(':');
  if (colon < 0) throw new Refused('refused: --connect-to must be <ip>:<port>');
  const portText = connectTo.slice(colon + 1);
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Refused('refused: the port of --connect-to must be a whole number from 1 to 65535');
  }
  let ip = connectTo.slice(0, colon);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip === '') throw new Refused('refused: --connect-to must be <ip>:<port>');
  if (ip !== '127.0.0.1' && ip !== '::1') throw new Refused(`refused: --connect-to must be 127.0.0.1 or ::1, not ${ip}`);
  return { ip, port: Number(portText) };
}

/**
 * Throws unless the script may talk to `base` (NFR-SEC-17, K-10).
 *
 * Without `connectTo`, `base` is an http(s) address whose host is exactly localhost or 127.0.0.1. Only the parsed
 * host decides: a userinfo trick (`http://localhost@host`), a longer name (`localhost.example.org`) or another loopback
 * form is refused. The message names the host and repeats nothing else of the address.
 *
 * With `connectTo` (`--connect-to <ip>:<port>`, as curl's option of that name), the script connects to that loopback
 * address and speaks as `base`'s name, so that the local nginx stack, which answers only a handshake naming makrai.org,
 * can be driven. Bytes go to the loopback address alone; the base's host name is only named, so it is not judged local.
 * `base` must then be an https address without credentials, and `connectTo` must be 127.0.0.1 or ::1 with a valid port.
 * @param {string} base
 * @param {string} [connectTo]
 * @returns {void}
 */
export function assertLocalBase(base, connectTo) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Refused('refused: --base is not an http or https address');
  }
  if (connectTo !== undefined) {
    if (url.protocol !== 'https:') throw new Refused('refused: --base must be an https address when --connect-to is given');
    if (url.username !== '' || url.password !== '') throw new Refused('refused: --base must not carry credentials');
    splitConnectTo(connectTo);
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused('refused: --base must be an http or https address');
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Refused(`refused: the load script runs against only localhost or 127.0.0.1, not ${url.hostname}`);
  }
  if (url.username !== '' || url.password !== '') throw new Refused('refused: --base must not carry credentials');
}

/**
 * Where a request goes and what it says: pure, no network. `host` and `port` are where the bytes go (the `--connect-to`
 * address, or the base itself), `servername` the TLS server name, `hostHeader` the Host the server compares with Origin
 * (`lib/http/sameOrigin.ts`), `origin` the Origin sent on every request. Throws what assertLocalBase throws.
 * @param {string} base
 * @param {string} [connectTo]
 * @returns {{ host: string, port: number, servername: string, hostHeader: string, origin: string }}
 */
export function requestTarget(base, connectTo) {
  assertLocalBase(base, connectTo);
  const url = new URL(base);
  const common = { servername: url.hostname, hostHeader: url.host, origin: url.origin };
  if (connectTo !== undefined) {
    const { ip, port } = splitConnectTo(connectTo);
    return { host: ip, port, ...common };
  }
  return { host: url.hostname, port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80, ...common };
}

function wholeNumber(name, text, min, max) {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) throw new Refused(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
}

/**
 * @param {readonly string[]} argv
 * @returns {{ base: string, connectTo: string | null, users: number, seconds: number, manifest: string, org: string | null, project: string | null, questions: string[], allowPending: boolean, only: string[] | null }}
 */
export function parseArgs(argv) {
  const out = { base: '', connectTo: null, users: 10, seconds: 60, manifest: DEFAULT_MANIFEST, org: null, project: null, questions: [], allowPending: false, only: null };
  const known = new Set(['--base', '--connect-to', '--users', '--seconds', '--manifest', '--org', '--project', '--questions', '--allow-pending', '--only']);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === '--allow-pending') {
      out.allowPending = true;
      i -= 1; // a flag without a value
      continue;
    }
    const value = argv[i + 1];
    if (!known.has(flag)) throw new Refused(`unknown option ${flag}; options: ${[...known].join(' ')}`);
    if (value === undefined) throw new Refused(`${flag} needs a value`);
    if (flag === '--base') out.base = value;
    if (flag === '--connect-to') out.connectTo = value; // judged by assertLocalBase
    if (flag === '--users') out.users = wholeNumber('--users', value, 1, MAX_USERS);
    if (flag === '--seconds') out.seconds = wholeNumber('--seconds', value, 1, MAX_SECONDS);
    if (flag === '--manifest') out.manifest = value;
    if (flag === '--org') out.org = value;
    if (flag === '--project') out.project = value;
    if (flag === '--questions') out.questions = value.split(',').filter(Boolean);
    if (flag === '--only') out.only = onlyOperations(value);
  }
  if (out.base === '') throw new Refused('usage: node scripts/load/save-decisions.mjs --base <url> [--connect-to <loopback-ip>:<port>] [--users 10] [--seconds 60] [--org <slug>] [--project <id>] [--questions Q-PP-01,Q-PP-02] [--only render-s10-s11] [--allow-pending]');
  if (out.questions.length === 0) out.questions = Array.from({ length: 10 }, (_, i) => `Q-PP-${String(i + 1).padStart(2, '0')}`);
  return out;
}

/** The operation names of `--only`, each one of BUDGETS_MS's keys; anything else, or none, is a refusal naming them. */
function onlyOperations(text) {
  const names = text.split(',').filter(Boolean);
  const valid = Object.keys(BUDGETS_MS);
  if (names.length === 0 || names.some((n) => !valid.includes(n))) throw new Refused(`--only takes one or more of ${valid.join(',')}`);
  return [...new Set(names)];
}

// ---- the run ---------------------------------------------------------------------------------------------

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(res, jar) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/**
 * One request through node:https, for `--connect-to`: the connection goes to the loopback address, the TLS server name,
 * Host and Origin are the base's name. Built-in `fetch` cannot set the server name without a package this project does
 * not list. `rejectUnauthorized: false` is here and nowhere else: the local stack's certificate is self-signed, and the
 * bytes go to a loopback address only. `node:https` follows no redirect, so the cookies stay on the one origin. The
 * answer is a web `Response` made from the incoming message, resolved at its headers, so the rest of the script treats
 * both transports alike.
 */
function sendHttps(target, address, path, init, cookie) {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : String(init.body);
    const headers = { host: target.hostHeader, origin: target.origin, 'x-forwarded-for': address, ...(init.headers ?? {}) };
    if (cookie !== null) headers.cookie = cookie;
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const req = https.request(
      {
        host: target.host,
        port: target.port,
        servername: target.servername,
        method: init.method ?? 'GET',
        path,
        headers,
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (incoming) => {
        const out = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) out.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const status = incoming.statusCode ?? 0;
        resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(incoming), { status, headers: out }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * A client that only ever talks to one target with one account's cookies and one synthetic client address. `connected` is
 * true when `--connect-to` is in use (node:https to the loopback address); otherwise it is `fetch`, with the strict
 * certificate check and redirects never followed, so the cookies stay on the target's origin whatever the server answers.
 */
function client(target, address, connected) {
  const jar = new Map();
  async function send(path, init = {}) {
    const cookie = jar.size > 0 ? cookieHeader(jar) : null;
    let res;
    if (connected) res = await sendHttps(target, address, path, init, cookie);
    else {
      const headers = { 'x-forwarded-for': address, origin: target.origin, ...(init.headers ?? {}) };
      if (cookie !== null) headers.cookie = cookie;
      res = await fetch(new URL(path, target.origin), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    absorb(res, jar);
    return res;
  }
  return { send, origin: target.origin };
}

/** The total a seat waits for a 429 to clear before it is given up on. */
const SIGN_IN_PATIENCE_MS = 60_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The milliseconds to wait before sending a sign-in request again, or null for "do not retry" (R16-6). Only a 429 waits:
 * through nginx every seat shares one client address and its `auth_login` zone answers 429 to a burst. The wait is the
 * `Retry-After` header when it is a whole number of seconds of at least 1, else 2 seconds (nginx's own 429 carries none);
 * it is null when the wait would take the seat's total past 60 seconds.
 * @param {number} status
 * @param {string | null} retryAfter
 * @param {number} waitedMs what this seat has already waited
 * @returns {number | null}
 */
export function signInRetryDelay(status, retryAfter, waitedMs) {
  if (status !== 429) return null;
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) && Number(retryAfter) >= 1 ? Number(retryAfter) : 2;
  const delay = seconds * 1000;
  return waitedMs + delay > SIGN_IN_PATIENCE_MS ? null : delay;
}

/**
 * Wraps a client's `send` for one seat's sign-in: on a 429 it reads and discards the body, waits `signInRetryDelay`
 * and sends the same request again (same body, same cookies; the CSRF token is still valid). When the delay is null it
 * throws `onGiveUp()`. Any other status is returned as it is. `waited` starts at 0 for each seat.
 * @param {(path: string, init?: object) => Promise<Response>} send
 * @param {{ sleep?: (ms: number) => Promise<void>, onGiveUp: () => Error }} options
 */
export function withSignInRetry(send, { sleep = defaultSleep, onGiveUp }) {
  let waited = 0;
  return async (path, init) => {
    for (;;) {
      const res = await send(path, init);
      if (res.status !== 429) return res;
      await res.arrayBuffer();
      const delay = signInRetryDelay(429, res.headers.get('retry-after'), waited);
      if (delay === null) throw onGiveUp();
      await sleep(delay);
      waited += delay;
    }
  };
}

async function signIn(target, connected, user, address) {
  const c = client(target, address, connected);
  const send = withSignInRetry(c.send, {
    onGiveUp: () => new Refused(`sign-in for the ${user.role} seat of ${user.orgSlug} was still answered 429 after 60 s of waiting`),
  });
  const csrf = await (await send('/api/auth/csrf')).json();
  const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email: user.email, password: user.password, callbackUrl: `${c.origin}/` });
  const res = await send('/api/auth/callback/credentials', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  await res.arrayBuffer();
  const session = await (await send('/api/auth/session')).json();
  if (!session || session.user == null) throw new Refused(`sign-in failed for the ${user.role} seat of ${user.orgSlug} (status ${res.status}); is the base the server the manifest was written for?`);
  return c;
}

/** One entry per stats key: the render operation has two, one per page. */
export function newStats() {
  const entry = () => ({ samples: [], errors: 0, firstError: null, pending: 0, serverErrors: 0, timeouts: 0, expected409: 0, expected429: 0 });
  return Object.fromEntries(Object.values(KEYS_OF).flatMap((keys) => keys.map(([key]) => [key, entry()])));
}

/** True while every answer so far said the route is not there and nothing was measured: nothing is gained by asking again. */
export function isPendingOnly(entry) {
  return entry.pending > 0 && entry.samples.length === 0 && entry.errors === 0;
}

/**
 * Records one answer for a stats key. `answer` says what the body was: `apiJson` is true when it was the API's own JSON
 * (so a 404 is `not_found` from a route that exists), `code` is that JSON's `code`.
 *  - 2xx: a sample.
 *  - 501, or a 404 that is not the API's JSON: the route is not there yet (pending).
 *  - status 0 (a timeout or a failed connection): a sample of 60000 ms and an error.
 *  - a 409 base_version_moved on a save, or a 429 on the export: expected409 or expected429, and not an error.
 *  - anything else: an error; a 5xx is also counted as a server error.
 * @param {ReturnType<typeof newStats>} s
 * @param {string} key
 * @param {number} status
 * @param {number} ms
 * @param {{ apiJson?: boolean, code?: string }} [answer]
 */
export function record(s, key, status, ms, answer = {}) {
  const o = s[key];
  if (status >= 200 && status < 300) {
    o.samples.push(ms);
    return;
  }
  if (status === 501 || (status === 404 && answer.apiJson !== true)) {
    o.pending += 1;
    return;
  }
  // An answer a correct server gives is counted as that and as nothing else: V's rule is errors=0 with expected409 at most --users.
  if (status === 409 && key === 'save-decision' && answer.code === 'base_version_moved') {
    o.expected409 += 1;
    return;
  }
  if (status === 429 && key === 'team-export') {
    o.expected429 += 1;
    return;
  }
  o.errors += 1;
  o.firstError ??= status === 0 ? 'timeout' : status;
  if (status === 0) {
    o.timeouts += 1;
    o.samples.push(TIMEOUT_MS);
  } else if (status >= 500) o.serverErrors += 1;
}

/**
 * The report lines (stdout), the notes (stderr) and the exit code of a run; pure, so the cases of
 * __tests__/unit/load-script.test.ts can feed it answers.
 * @param {ReturnType<typeof newStats>} s
 * @param {{ allowPending?: boolean, only?: string[] | null }} [options] `only`: the operations of `--only`; the others print `skipped`
 * @returns {{ lines: string[], notes: string[], code: number }}
 */
export function renderReport(s, { allowPending = false, only = null } = {}) {
  const lines = [];
  const pending = [];
  let failed = false;
  for (const [op, budget] of Object.entries(BUDGETS_MS)) {
    if (only !== null && !only.includes(op)) {
      lines.push(`op=${op} skipped`);
      continue;
    }
    const parts = KEYS_OF[op].map(([key, label]) => ({ label, o: s[key] }));
    const measured = parts.filter((p) => p.o.samples.length > 0);
    const sum = (field) => parts.reduce((total, p) => total + p.o[field], 0);
    const counts = [];
    if (sum('errors') > 0) counts.push(`errors=${sum('errors')} firstStatus=${parts.map((p) => p.o.firstError).find((v) => v !== null)}`);
    if (sum('expected409') > 0) counts.push(`expected409=${sum('expected409')}`);
    if (sum('expected429') > 0) counts.push(`expected429=${sum('expected429')}`);
    const detail = counts.length > 0 ? ` ${counts.join(' ')}` : '';
    const notThere = parts.filter((p) => isPendingOnly(p.o));
    if (measured.length === 0) {
      if (notThere.length === parts.length) {
        lines.push(`op=${op} pending`);
        pending.push(op);
      } else {
        lines.push(`op=${op} notmeasured${detail}`);
        failed = true;
      }
      continue;
    }
    const samples = measured.flatMap((p) => p.o.samples);
    const value = Math.round(p95(samples));
    const partial = notThere.length > 0 ? `partial pending=${notThere.map((p) => p.label).join(',')} ` : '';
    lines.push(`op=${op} ${partial}p95ms=${value} budgetms=${budget} n=${samples.length}${detail}`);
    if (notThere.length > 0) pending.push(`${op} (${notThere.map((p) => p.label).join(', ')})`);
    // V's rule is errors=0, and `errors` holds only answers a correct server does not give (expected 409s and 429s are
    // counted apart), so any error fails the run, whether or not the operation also has samples.
    if (value > budget || sum('errors') > 0) failed = true;
  }
  const notes = [];
  if (pending.length > 0) {
    notes.push(`save-decisions: pending, not measured: ${pending.join(', ')}${allowPending ? ' (allowed by --allow-pending)' : '; exit 3 unless --allow-pending is given'}`);
  }
  return { lines, notes, code: failed ? 1 : pending.length > 0 && !allowPending ? 3 : 0 };
}

/**
 * What one save sends. The `reason` carries the virtual user and its sequence (`load u<i> #<n>`): DEC-a refuses a save
 * equal to the current version with 422, so a repeated body would be refused after a user's first, and two users on one
 * question must not send the same text either.
 * @param {{ requestId: string, stage: string, questionId: string, baseVersion: number | null, userId: string, i: number, n: number, today: string }} a
 */
export function saveDecisionBody({ requestId, stage, questionId, baseVersion, userId, i, n, today }) {
  return {
    requestId, stage, questionId, baseVersionNumber: baseVersion, status: 'done', scopeAnswer: null,
    optionsInPlace: [], reasonCode: null, reason: `load u${i} #${n}`, decidedBy: { kind: 'member', userId }, declaredDate: today, evidenceIds: [],
  };
}

/**
 * The users take the manifest's seats whose role is `owner` or `admin` in the organisation (both hold every operation
 * the script runs: lib/authz/policy.ts), one seat each, in manifest order. NFR-PERF-04's 10 users are 10 people, and the
 * per-user limits key on the user id, so a seat is never shared. Fewer seats than users is a refusal naming both counts.
 * @template {{ role: string, orgSlug: string }} U
 * @param {U[]} users
 * @param {string} slug
 * @param {number} wanted
 * @returns {U[]}
 */
export function selectSeats(users, slug, wanted) {
  const seats = users.filter((u) => u.orgSlug === slug && (u.role === 'owner' || u.role === 'admin'));
  if (seats.length < wanted) {
    throw new Refused(`--users ${wanted} needs ${wanted} owner or admin seats of ${slug} in the manifest, which has ${seats.length}`);
  }
  return seats.slice(0, wanted);
}

/** A seat sends at most this many requests to one path in any 60 s window: K0b's default limit is 60 a minute per user per path. */
const PACE_LIMIT = 50;
const PACE_WINDOW_MS = 60_000;

/**
 * The milliseconds to wait before sending the next request to a path so that no 60 s window holds more than `limit` of
 * them, given the times (ascending) at which this seat sent its earlier requests to it.
 * @param {readonly number[]} sent
 * @param {number} now
 * @returns {number}
 */
export function paceDelay(sent, now, limit = PACE_LIMIT, windowMs = PACE_WINDOW_MS) {
  const recent = sent.filter((t) => t > now - windowMs);
  if (recent.length < limit) return 0;
  return recent[recent.length - limit] + windowMs - now; // when the limit-th most recent request leaves the window
}

/**
 * One seat's pacer. `wait(path, deadline)` resolves true when the caller may send to `path` now (after sleeping, if it
 * must), and false when the wait would end after `deadline` (the end of the measured window), in which case nothing is
 * slept: the seat is at its limit for the rest of the run. The wait is outside every timed call, so no p95 holds it. A
 * path is counted without its query string.
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} [clock]
 */
export function createPacer({ now = () => performance.now(), sleep = defaultSleep } = {}) {
  const sentByPath = new Map();
  return {
    async wait(path, deadline) {
      const key = path.split('?')[0];
      const sent = sentByPath.get(key) ?? [];
      const delay = paceDelay(sent, now());
      if (delay > 0) {
        if (now() + delay > deadline) return false;
        await sleep(delay);
      }
      const at = now();
      sent.push(at);
      while (sent.length > 0 && sent[0] <= at - PACE_WINDOW_MS) sent.shift();
      sentByPath.set(key, sent);
      return true;
    },
  };
}

/** The most requests of each kind one seat sends in a run: the per-user limits of an hour (00-contract.md:1061-1062). */
export const SEAT_LIMITS = Object.freeze({ 'seal-stage': 20, 'generate-document': 10 });

/**
 * Which operations a virtual user asks for in this iteration, as stats keys. An operation is skipped when it is pending
 * only (nothing is there to measure), when it needs a review the user does not have, when the seat has sent its limit of
 * it (`SEAT_LIMITS`: a seat at its cap skips it for the rest of the window), for the export when none is left, and
 * when `only` (the operations of `--only`) does not name its operation.
 * @param {{ sent: Record<string, number>, hasReview: boolean, exportsLeft: number, pendingOnly: ReadonlySet<string>, only?: string[] | null }} state
 * @returns {string[]}
 */
export function operationsToAsk({ sent, hasReview, exportsLeft, pendingOnly, only = null }) {
  const under = (key) => (sent[key] ?? 0) < SEAT_LIMITS[key];
  const ops = ['save-decision', 'render-s10', 'render-s11'];
  if (hasReview && under('seal-stage')) ops.push('seal-stage');
  if (hasReview && under('generate-document')) ops.push('generate-document');
  if (exportsLeft > 0) ops.push('team-export');
  const named = (key) => only === null || only.some((op) => KEYS_OF[op].some(([k]) => k === key));
  return ops.filter((key) => !pendingOnly.has(key) && named(key));
}

/**
 * Runs `call` and times it, the body included unless `drain` is false (the export is timed to its headers). A thrown
 * request (timeout, refused connection) gives `res: null`. `answer` is what record() needs to know of the body.
 */
async function timed(call, { drain = true } = {}) {
  const t0 = performance.now();
  try {
    const res = await call();
    const text = drain ? await res.text() : null;
    const apiJson = (res.headers.get('content-type') ?? '').includes('application/json');
    let body = null;
    if (apiJson && text !== null) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { res, ms: performance.now() - t0, status: res.status, body, answer: { apiJson, code: body?.code } };
  } catch (e) {
    return { res: null, ms: performance.now() - t0, status: 0, body: null, answer: {}, failure: e?.name ?? 'error' };
  }
}

const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function virtualUser(i, ctx, s, deadline) {
  const { c, userId, slug, projectId, question, only } = ctx;
  const base = `/api/v1/orgs/${slug}/projects/${projectId}`;
  const stage = 'pre-processing';
  let baseVersion = null;
  let reviewId = null;
  let exportsLeft = i === 0 ? EXPORT_ATTEMPTS : 0;
  const sent = { 'seal-stage': 0, 'generate-document': 0 };
  const pacer = createPacer();
  const spent = new Set(); // operations whose path is at the pace limit for the rest of the window
  let saves = 0;

  // Opening a review is setup, not a measured operation; if the route is not there, neither is the seal or the document.
  // With --only naming neither, no review is opened.
  if (only === null || only.includes('seal-stage') || only.includes('generate-document')) {
    await pacer.wait(`${base}/reviews`, deadline);
    const open = await timed(() => c.send(`${base}/reviews`, { method: 'POST', ...json({ requestId: randomUUID(), stage, preparedFor: null }) }));
    if (open.status >= 200 && open.status < 300) reviewId = open.body?.id ?? null;
    else if (open.status === 501 || (open.status === 404 && !open.answer.apiJson)) {
      record(s, 'seal-stage', open.status, open.ms, open.answer);
      record(s, 'generate-document', open.status, open.ms, open.answer);
    }
  }

  while (performance.now() < deadline) {
    const pendingOnly = new Set([...Object.keys(s).filter((key) => isPendingOnly(s[key])), ...spent]);
    const ops = operationsToAsk({ sent, hasReview: reviewId !== null, exportsLeft, pendingOnly, only });
    if (ops.length === 0) break; // every operation is pending: nothing changes by asking again
    let sealId = null;
    for (const op of ops) {
      const path = {
        'save-decision': `${base}/decisions`,
        'render-s10': `/orgs/${slug}/projects/${projectId}`,
        'render-s11': `/orgs/${slug}/projects/${projectId}/stages/${stage}`,
        'seal-stage': `${base}/reviews/${reviewId}/seals`,
        'generate-document': `${base}/reviews/${reviewId}/documents`,
        'team-export': `/api/v1/orgs/${slug}/export`,
      }[op];
      if (op === 'generate-document' && sealId === null) continue;
      // Paced outside the timed call: a seat that would pass 50 requests to one path in 60 s waits, and no p95 holds the wait.
      if (!(await pacer.wait(path, deadline))) {
        spent.add(op);
        continue;
      }
      if (op === 'save-decision') {
        saves += 1;
        const body = saveDecisionBody({ requestId: randomUUID(), stage, questionId: question, baseVersion, userId, i, n: saves, today: new Date().toISOString().slice(0, 10) });
        const r = await timed(() => c.send(`${base}/decisions`, { method: 'POST', ...json(body) }));
        record(s, op, r.status, r.ms, r.answer);
        if (r.status >= 200 && r.status < 300) baseVersion = r.body?.versionNumber ?? baseVersion;
        else if (r.status === 409 && r.body?.code === 'base_version_moved') baseVersion = r.body.current?.versionNumber ?? baseVersion;
      } else if (op === 'render-s10' || op === 'render-s11') {
        const page = op === 'render-s10' ? `/orgs/${slug}/projects/${projectId}` : `/orgs/${slug}/projects/${projectId}/stages/${stage}`;
        const r = await timed(() => c.send(page));
        record(s, op, r.status, r.ms, r.answer);
      } else if (op === 'seal-stage') {
        sent[op] += 1;
        const r = await timed(() => c.send(`${base}/reviews/${reviewId}/seals`, { method: 'POST', ...json({ requestId: randomUUID() }) }));
        record(s, op, r.status, r.ms, r.answer);
        if (r.status >= 200 && r.status < 300) sealId = r.body?.id ?? null;
      } else if (op === 'generate-document' && sealId !== null) {
        sent[op] += 1;
        const r = await timed(() => c.send(`${base}/reviews/${reviewId}/documents`, { method: 'POST', ...json({ requestId: randomUUID(), documentType: 'data_card', sealId, typedFields: {} }) }));
        record(s, op, r.status, r.ms, r.answer);
      } else if (op === 'team-export') {
        exportsLeft -= 1;
        const r = await timed(() => c.send(`/api/v1/orgs/${slug}/export`), { drain: false });
        record(s, op, r.status, r.ms, r.answer); // first byte: fetch resolves at the response headers
        await r.res?.body?.cancel();
        if (r.status === 429) exportsLeft = 0; // export_busy or rate_limited: asking again only adds to the limit
      }
    }
  }
}

async function main(argv) {
  let opts;
  let target;
  try {
    opts = parseArgs(argv);
    // Before the manifest is read or anything is sent: a base or a --connect-to that is refused stops the run here.
    target = requestTarget(opts.base, opts.connectTo ?? undefined);
  } catch (e) {
    if (e instanceof Refused) {
      process.stderr.write(`save-decisions: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  const connected = opts.connectTo !== null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
  } catch (e) {
    process.stderr.write(`save-decisions: cannot read the e2e manifest ${opts.manifest} (${e.code ?? 'invalid JSON'}); run \`npx playwright test --project=setup\` first\n`);
    process.exit(2);
  }
  const slug = opts.org ?? manifest.orgs?.[0]?.slug;
  if (!slug) {
    process.stderr.write('save-decisions: the manifest names no organisation; pass --org <slug>\n');
    process.exit(2);
  }
  let seats;
  try {
    seats = selectSeats(manifest.users ?? [], slug, opts.users);
  } catch (e) {
    if (e instanceof Refused) {
      process.stderr.write(`save-decisions: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  // One seat at a time, before the measured window opens (R16-6): through nginx every seat shares one client address and
  // its auth_login zone answers 429 to a burst, so the seats are not signed in together, and no sign-in is in a p95.
  const sessions = [];
  try {
    for (const [k, u] of seats.entries()) sessions.push(await signIn(target, connected, u, `10.43.0.${k + 1}`));
  } catch (e) {
    process.stderr.write(`save-decisions: ${e instanceof Refused ? e.message : `sign-in request failed (${e?.name ?? 'error'})`}\n`);
    process.exit(2);
  }

  let projectId = opts.project;
  if (!projectId) {
    const res = await sessions[0].send(`/api/v1/orgs/${slug}/projects`);
    const text = await res.text();
    const stop = (why) => {
      process.stderr.write(`save-decisions: listing the organisation's projects ${why}; pass --project <id> to skip the list\n`);
      process.exit(2);
    };
    if (!res.ok) stop(`answered ${res.status}`);
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      stop(`answered ${res.status} but the body is not JSON`);
    }
    if (!Array.isArray(list)) stop('answered something that is not a list of projects');
    projectId = list[0]?.id;
    if (!projectId) {
      process.stderr.write('save-decisions: the organisation has no project; pass --project <id> or create one first\n');
      process.exit(2);
    }
  }

  const s = newStats();
  const deadline = performance.now() + opts.seconds * 1000;
  await Promise.all(
    Array.from({ length: opts.users }, (_, i) =>
      virtualUser(i, { c: sessions[i], userId: seats[i].userId, slug, projectId, question: opts.questions[i % opts.questions.length], only: opts.only }, s, deadline),
    ),
  );
  const { lines, notes, code } = renderReport(s, { allowPending: opts.allowPending, only: opts.only });
  process.stdout.write(`${lines.join('\n')}\n`);
  for (const note of notes) process.stderr.write(`${note}\n`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
