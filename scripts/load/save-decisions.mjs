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
// An operation whose route answers 404 or 501 prints `op=<name> pending` and counts as not measured (the
// route is a stub until its producer merges). Any other answer than success adds to `errors=<k>`.
// The export is limited to 3 an hour per organisation (route 20), so it is timed twice per run at most.
//
// Exit 0: every measured operation is within budget. Exit 1: an operation is over budget, or has errors and
// no success. Exit 2: refused or mis-used before any request: the base is not localhost or 127.0.0.1
// (NFR-SEC-17, K-10), an option is out of range, or the manifest or a sign-in failed.
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
 * @returns {{ base: string, users: number, seconds: number, manifest: string, org: string | null, project: string | null, questions: string[] }}
 */
export function parseArgs(argv) {
  const out = { base: '', users: 10, seconds: 60, manifest: DEFAULT_MANIFEST, org: null, project: null, questions: [] };
  const known = new Set(['--base', '--users', '--seconds', '--manifest', '--org', '--project', '--questions']);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
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
  if (out.base === '') throw new Refused('usage: node scripts/load/save-decisions.mjs --base <url> [--users 10] [--seconds 60] [--org <slug>] [--project <id>] [--questions Q-PP-01,Q-PP-02]');
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

function stats() {
  return Object.fromEntries(Object.keys(BUDGETS_MS).map((name) => [name, { samples: [], errors: 0, firstError: null, pending: false }]));
}

/** Records one answer: success adds a sample, 404 and 501 mark the operation pending, anything else is an error. */
function record(s, op, status, ms) {
  if (status === 404 || status === 501) s[op].pending = true;
  else if (status >= 200 && status < 300) s[op].samples.push(ms);
  else {
    s[op].errors += 1;
    s[op].firstError ??= status;
  }
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    const res = await fn();
    return { res, ms: performance.now() - t0 };
  } catch (e) {
    return { res: null, ms: performance.now() - t0, failure: e?.name ?? 'error' };
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

  const open = await timed(() => c.send(`${base}/reviews`, { method: 'POST', ...json({ requestId: randomUUID(), stage, preparedFor: null }) }));
  if (open.res?.ok) reviewId = (await open.res.json()).id;
  else if (open.res && (open.res.status === 404 || open.res.status === 501)) {
    s['seal-stage'].pending = true;
    s['generate-document'].pending = true;
  }

  while (performance.now() < deadline) {
    if (!s['save-decision'].pending) {
      const today = new Date().toISOString().slice(0, 10);
      const body = {
        requestId: randomUUID(), stage, questionId: question, baseVersionNumber: baseVersion, status: 'done', scopeAnswer: null,
        optionsInPlace: [], reasonCode: null, reason: 'load', decidedBy: { kind: 'member', userId }, declaredDate: today, evidenceIds: [],
      };
      const r = await timed(() => c.send(`${base}/decisions`, { method: 'POST', ...json(body) }));
      if (r.res) {
        const answer = await r.res.json().catch(() => null);
        record(s, 'save-decision', r.res.status, r.ms);
        if (r.res.ok) baseVersion = answer?.versionNumber ?? baseVersion;
        else if (r.res.status === 409 && answer?.code === 'base_version_moved') baseVersion = answer.current?.versionNumber ?? baseVersion;
      } else record(s, 'save-decision', 0, r.ms);
    }
    if (!s['render-s10-s11'].pending) {
      for (const page of [`/orgs/${slug}/projects/${projectId}`, `/orgs/${slug}/projects/${projectId}/stages/${stage}`]) {
        const r = await timed(async () => {
          const res = await c.send(page);
          await res.arrayBuffer();
          return res;
        });
        record(s, 'render-s10-s11', r.res?.status ?? 0, r.ms);
      }
    }
    let sealId = null;
    if (reviewId && !s['seal-stage'].pending) {
      const r = await timed(() => c.send(`${base}/reviews/${reviewId}/seals`, { method: 'POST', ...json({ requestId: randomUUID() }) }));
      record(s, 'seal-stage', r.res?.status ?? 0, r.ms);
      if (r.res?.ok) sealId = (await r.res.json()).id;
    }
    if (reviewId && sealId && !s['generate-document'].pending) {
      const r = await timed(() => c.send(`${base}/reviews/${reviewId}/documents`, { method: 'POST', ...json({ requestId: randomUUID(), documentType: 'data_card', sealId, typedFields: {} }) }));
      record(s, 'generate-document', r.res?.status ?? 0, r.ms);
    }
    if (exportsLeft > 0 && !s['team-export'].pending) {
      exportsLeft -= 1;
      const r = await timed(() => c.send(`/api/v1/orgs/${slug}/export`));
      record(s, 'team-export', r.res?.status ?? 0, r.ms); // first byte: fetch resolves at the response headers
      await r.res?.body?.cancel();
      if (r.res?.status === 429) exportsLeft = 0; // export_busy or rate_limited: asking again only adds to the limit
    }
    if (s['save-decision'].pending && s['render-s10-s11'].pending) break; // nothing left to do on a build with no routes yet
  }
}

function report(s) {
  let failed = false;
  for (const [op, budget] of Object.entries(BUDGETS_MS)) {
    const o = s[op];
    if (o.pending && o.samples.length === 0) {
      process.stdout.write(`op=${op} pending\n`);
      continue;
    }
    const errors = o.errors > 0 ? ` errors=${o.errors} firstStatus=${o.firstError}` : '';
    if (o.samples.length === 0) {
      process.stdout.write(`op=${op} notmeasured${errors}\n`);
      failed = true;
      continue;
    }
    const value = Math.round(p95(o.samples));
    process.stdout.write(`op=${op} p95ms=${value} budgetms=${budget} n=${o.samples.length}${errors}\n`);
    if (value > budget) failed = true;
  }
  return failed;
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
    const list = res.ok ? await res.json() : [];
    projectId = Array.isArray(list) ? list[0]?.id : null;
  }
  if (!projectId) {
    process.stderr.write('save-decisions: the organisation has no project; pass --project <id> or create one first\n');
    process.exit(2);
  }

  const s = stats();
  const deadline = performance.now() + opts.seconds * 1000;
  await Promise.all(
    Array.from({ length: opts.users }, (_, i) =>
      virtualUser(i, { c: sessions[i % sessions.length], userId: owners[i % owners.length].userId, slug, projectId, question: opts.questions[i % opts.questions.length] }, s, deadline),
    ),
  );
  process.exit(report(s) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
