#!/usr/bin/env node
// Load script for the server response budgets of NFR-PERF-04 (SRS line 3207).
//
//   node scripts/load/save-decisions.mjs --base <url> --users 10 --seconds 60
//
// Signs in the fixture's owner accounts (from the e2e manifest, e2e/fixtures/.auth/manifest.json, which
// `npx playwright test --project=setup` writes), then runs five operations with `--users` concurrent
// virtual users for `--seconds`, and prints the 95th percentile of each:
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
// Other answers than a success are counted: `errors=<k> firstStatus=<s>`, and a 409 base_version_moved on a save
// and the export's 429 also as `expected409=<k>` and `expected429=<k>`. A timeout enters the p95 as 60000 ms.
// The export is limited to 3 an hour per organisation (route 20), so it is timed twice per run at most.
//
// Exit 0: every operation is measured and within budget, or pending with --allow-pending. Exit 1: an operation is
// over budget, has a 5xx or a timeout among its answers, or has errors and no success. Exit 2: refused or
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
import { dirname, join } from 'node:path';
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
 * Throws unless `base` is an http(s) address whose host is exactly localhost or 127.0.0.1 (NFR-SEC-17). Only
 * the parsed host decides: a userinfo trick (`http://localhost@host`), a longer name (`localhost.example.org`)
 * or another loopback form is refused. The message names the host and repeats nothing else of the address.
 * @param {string} base
 * @returns {void}
 */
export function assertLocalBase(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Refused('refused: --base is not an http or https address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused('refused: --base must be an http or https address');
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Refused(`refused: the load script runs against only localhost or 127.0.0.1, not ${url.hostname}`);
  }
  if (url.username !== '' || url.password !== '') throw new Refused('refused: --base must not carry credentials');
}

function wholeNumber(name, text, min, max) {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) throw new Refused(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
}

/**
 * @param {readonly string[]} argv
 * @returns {{ base: string, users: number, seconds: number, manifest: string, org: string | null, project: string | null, questions: string[], allowPending: boolean }}
 */
export function parseArgs(argv) {
  const out = { base: '', users: 10, seconds: 60, manifest: DEFAULT_MANIFEST, org: null, project: null, questions: [], allowPending: false };
  const known = new Set(['--base', '--users', '--seconds', '--manifest', '--org', '--project', '--questions', '--allow-pending']);
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
    if (flag === '--users') out.users = wholeNumber('--users', value, 1, MAX_USERS);
    if (flag === '--seconds') out.seconds = wholeNumber('--seconds', value, 1, MAX_SECONDS);
    if (flag === '--manifest') out.manifest = value;
    if (flag === '--org') out.org = value;
    if (flag === '--project') out.project = value;
    if (flag === '--questions') out.questions = value.split(',').filter(Boolean);
  }
  if (out.base === '') throw new Refused('usage: node scripts/load/save-decisions.mjs --base <url> [--users 10] [--seconds 60] [--org <slug>] [--project <id>] [--questions Q-PP-01,Q-PP-02] [--allow-pending]');
  if (out.questions.length === 0) out.questions = Array.from({ length: 10 }, (_, i) => `Q-PP-${String(i + 1).padStart(2, '0')}`);
  return out;
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

/** A client that only ever talks to `base` with one account's cookies and one synthetic client address. */
function client(base, address) {
  const origin = new URL(base).origin;
  const jar = new Map();
  async function send(path, init = {}) {
    const headers = { 'x-forwarded-for': address, origin, ...(init.headers ?? {}) };
    if (jar.size > 0) headers.cookie = cookieHeader(jar);
    // redirect: 'manual' keeps the cookies on this origin whatever the server answers.
    const res = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    absorb(res, jar);
    return res;
  }
  return { send, origin };
}

async function signIn(base, user, address) {
  const c = client(base, address);
  const csrf = await (await c.send('/api/auth/csrf')).json();
  const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email: user.email, password: user.password, callbackUrl: `${c.origin}/` });
  const res = await c.send('/api/auth/callback/credentials', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  await res.arrayBuffer();
  const session = await (await c.send('/api/auth/session')).json();
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
 *  - anything else: an error; a 5xx is also counted as a server error, a 409 base_version_moved on a save as
 *    expected409 and a 429 on the export as expected429.
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
  o.errors += 1;
  o.firstError ??= status === 0 ? 'timeout' : status;
  if (status === 0) {
    o.timeouts += 1;
    o.samples.push(TIMEOUT_MS);
  } else if (status >= 500) o.serverErrors += 1;
  else if (status === 409 && key === 'save-decision' && answer.code === 'base_version_moved') o.expected409 += 1;
  else if (status === 429 && key === 'team-export') o.expected429 += 1;
}

/**
 * The report lines (stdout), the notes (stderr) and the exit code of a run; pure, so the cases of
 * __tests__/unit/load-script.test.ts can feed it answers.
 * @param {ReturnType<typeof newStats>} s
 * @param {{ allowPending?: boolean }} [options]
 * @returns {{ lines: string[], notes: string[], code: number }}
 */
export function renderReport(s, { allowPending = false } = {}) {
  const lines = [];
  const pending = [];
  let failed = false;
  for (const [op, budget] of Object.entries(BUDGETS_MS)) {
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
    // A page with errors and no sample beside one with samples measured nothing of its own.
    if (parts.some((p) => p.o.samples.length === 0 && p.o.errors > 0)) failed = true;
    if (value > budget || sum('serverErrors') > 0 || sum('timeouts') > 0) failed = true;
  }
  const notes = [];
  if (pending.length > 0) {
    notes.push(`save-decisions: pending, not measured: ${pending.join(', ')}${allowPending ? ' (allowed by --allow-pending)' : '; exit 3 unless --allow-pending is given'}`);
  }
  return { lines, notes, code: failed ? 1 : pending.length > 0 && !allowPending ? 3 : 0 };
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
  const { c, userId, slug, projectId, question } = ctx;
  const base = `/api/v1/orgs/${slug}/projects/${projectId}`;
  const stage = 'pre-processing';
  let baseVersion = null;
  let reviewId = null;
  let exportsLeft = i === 0 ? EXPORT_ATTEMPTS : 0;

  // Opening a review is setup, not a measured operation; if the route is not there, neither is the seal or the document.
  const open = await timed(() => c.send(`${base}/reviews`, { method: 'POST', ...json({ requestId: randomUUID(), stage, preparedFor: null }) }));
  if (open.status >= 200 && open.status < 300) reviewId = open.body?.id ?? null;
  else if (open.status === 501 || (open.status === 404 && !open.answer.apiJson)) {
    record(s, 'seal-stage', open.status, open.ms, open.answer);
    record(s, 'generate-document', open.status, open.ms, open.answer);
  }

  while (performance.now() < deadline) {
    let asked = false;
    if (!isPendingOnly(s['save-decision'])) {
      asked = true;
      const today = new Date().toISOString().slice(0, 10);
      const body = {
        requestId: randomUUID(), stage, questionId: question, baseVersionNumber: baseVersion, status: 'done', scopeAnswer: null,
        optionsInPlace: [], reasonCode: null, reason: 'load', decidedBy: { kind: 'member', userId }, declaredDate: today, evidenceIds: [],
      };
      const r = await timed(() => c.send(`${base}/decisions`, { method: 'POST', ...json(body) }));
      record(s, 'save-decision', r.status, r.ms, r.answer);
      if (r.status >= 200 && r.status < 300) baseVersion = r.body?.versionNumber ?? baseVersion;
      else if (r.status === 409 && r.body?.code === 'base_version_moved') baseVersion = r.body.current?.versionNumber ?? baseVersion;
    }
    for (const [key, page] of [['render-s10', `/orgs/${slug}/projects/${projectId}`], ['render-s11', `/orgs/${slug}/projects/${projectId}/stages/${stage}`]]) {
      if (isPendingOnly(s[key])) continue;
      asked = true;
      const r = await timed(() => c.send(page));
      record(s, key, r.status, r.ms, r.answer);
    }
    let sealId = null;
    if (reviewId && !isPendingOnly(s['seal-stage'])) {
      asked = true;
      const r = await timed(() => c.send(`${base}/reviews/${reviewId}/seals`, { method: 'POST', ...json({ requestId: randomUUID() }) }));
      record(s, 'seal-stage', r.status, r.ms, r.answer);
      if (r.status >= 200 && r.status < 300) sealId = r.body?.id ?? null;
    }
    if (reviewId && sealId && !isPendingOnly(s['generate-document'])) {
      asked = true;
      const r = await timed(() => c.send(`${base}/reviews/${reviewId}/documents`, { method: 'POST', ...json({ requestId: randomUUID(), documentType: 'data_card', sealId, typedFields: {} }) }));
      record(s, 'generate-document', r.status, r.ms, r.answer);
    }
    if (exportsLeft > 0 && !isPendingOnly(s['team-export'])) {
      asked = true;
      exportsLeft -= 1;
      const r = await timed(() => c.send(`/api/v1/orgs/${slug}/export`), { drain: false });
      record(s, 'team-export', r.status, r.ms, r.answer); // first byte: fetch resolves at the response headers
      await r.res?.body?.cancel();
      if (r.status === 429) exportsLeft = 0; // export_busy or rate_limited: asking again only adds to the limit
    }
    if (!asked) break; // every operation is pending: nothing changes by asking again
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    assertLocalBase(opts.base); // before the manifest is read or anything is sent
  } catch (e) {
    if (e instanceof Refused) {
      process.stderr.write(`save-decisions: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  const base = new URL(opts.base).origin;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
  } catch (e) {
    process.stderr.write(`save-decisions: cannot read the e2e manifest ${opts.manifest} (${e.code ?? 'invalid JSON'}); run \`npx playwright test --project=setup\` first\n`);
    process.exit(2);
  }
  const slug = opts.org ?? manifest.orgs?.[0]?.slug;
  const owners = (manifest.users ?? []).filter((u) => u.orgSlug === slug && u.role === 'owner');
  if (!slug || owners.length === 0) {
    process.stderr.write('save-decisions: the manifest has no owner seat for the organisation\n');
    process.exit(2);
  }

  let sessions;
  try {
    sessions = await Promise.all(owners.map((u, k) => signIn(base, u, `10.43.0.${k + 1}`)));
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
      virtualUser(i, { c: sessions[i % sessions.length], userId: owners[i % owners.length].userId, slug, projectId, question: opts.questions[i % opts.questions.length] }, s, deadline),
    ),
  );
  const { lines, notes, code } = renderReport(s, { allowPending: opts.allowPending });
  process.stdout.write(`${lines.join('\n')}\n`);
  for (const note of notes) process.stderr.write(`${note}\n`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
