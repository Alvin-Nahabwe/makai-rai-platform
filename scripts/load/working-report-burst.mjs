#!/usr/bin/env node
// Measures the working report PDF under a workshop-sized burst (path to outputs, Task 16; design §5).
//
//   LOAD_BASE_URL=http://localhost:3310 LOAD_ORG_SLUG=<slug> LOAD_EMAIL=<assessor email> LOAD_PASSWORD=<password> \
//     MAKRAI_CONTENT_ROOT=<fixture content root> node scripts/load/working-report-burst.mjs
//
// It measures and reports; it changes nothing in the application and decides nothing. Up to 21 participants sit behind one
// IP and a heavy PDF render must not block a page, so for each run it fires 21 concurrent GETs of
// `/api/v1/orgs/<slug>/projects/<id>/working-report?part=<part>` and, 200 ms later, one GET of the project page, and records
// how long the page took. It also times the page alone first (the baseline).
//
// Steps: sign in once per account through the real credentials login (cookies are reused), make a project through the real
// routes, answer every question of the content bundle in MAKRAI_CONTENT_ROOT (the running version's question bank) across
// all stages (mostly Done, some Partly and Not yet, so findings exist), then measure. Output is one JSON document on
// stdout; progress goes to stderr.
//
// The proxy's `default` rate limit is 60 requests a minute per signed-in user (lib/rate-limit.ts), and a real workshop has
// one account per participant. So the seeding is paced under that limit, and the downloads are spread round-robin over the
// accounts named in LOAD_EXTRA_EMAILS (comma-separated, same password) as well as LOAD_EMAIL, never over one account: one
// account's 21 downloads plus its page reads would measure the limiter, not the render. A 429 is counted as an error.
//
// It refuses any host but localhost or 127.0.0.1 (as scripts/test-db/fixture-content.mjs does) and never repeats the password.
// Node's fetch only; no dependencies.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const BURST_SIZE = 21;
const PAGE_DELAY_MS = 200;
const BASELINE_RUNS = 5;
const BURST_RUNS = 3;
const PAUSE_BETWEEN_RUNS_MS = 2000;

const refuse = (reason) => {
  process.stderr.write(`working-report-burst: refused: ${reason}\n`);
  process.exit(1);
};
const log = (m) => process.stderr.write(`${m}\n`);

function env(name) {
  const v = process.env[name];
  if (v === undefined || v === '') refuse(`${name} is not set`);
  return v;
}

const baseUrl = new URL(process.env.LOAD_BASE_URL ?? 'http://localhost:3310');
if (baseUrl.protocol !== 'http:' || !LOCAL_HOSTS.has(baseUrl.hostname)) refuse(`only http://localhost or http://127.0.0.1 may be measured, not "${baseUrl.hostname}"`);
const origin = baseUrl.origin;
const slug = env('LOAD_ORG_SLUG');
const email = env('LOAD_EMAIL');
const password = env('LOAD_PASSWORD');
const extraEmails = (process.env.LOAD_EXTRA_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
const SEED_PACE_MS = 1300; // 46 requests a minute, under the 60 a minute of the `default` rule
const contentRoot = env('MAKRAI_CONTENT_ROOT');

// ---- a minimal cookie jar per account ---------------------------------------------------------------------------------
const keep = (session, res) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    session.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
};
const cookieHeader = (session) => [...session.jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(session, path, init = {}) {
  const res = await fetch(`${origin}${path}`, { redirect: 'manual', ...init, headers: { cookie: cookieHeader(session), ...(init.headers ?? {}) } });
  keep(session, res);
  return res;
}

/** A signed-in session for `account`, through the real credentials login. */
async function signIn(account) {
  const session = { jar: new Map(), account };
  const csrf = await (await request(session, '/api/auth/csrf')).json();
  const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email: account, password, callbackUrl: `${origin}/`, json: 'true' });
  const res = await request(session, '/api/auth/callback/credentials', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  await res.arrayBuffer();
  if (res.status >= 400 || ![...session.jar.keys()].some((k) => k.includes('session-token'))) refuse(`sign-in failed (HTTP ${res.status}); no session cookie was issued`);
  return session;
}

async function postJson(session, path, data) {
  const res = await request(session, path, { method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json', origin } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---- seeding: every question of the running bundle, in every stage ----------------------------------------------------
function questionsByStage() {
  const running = JSON.parse(readFileSync(join(contentRoot, 'index.json'), 'utf8')).running;
  const bank = JSON.parse(readFileSync(join(contentRoot, running, 'questionBank.json'), 'utf8'));
  const out = [];
  for (const [stage, def] of Object.entries(bank.stages)) {
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (typeof v.id === 'string' && v.id.startsWith('Q-')) out.push({ stage, q: v });
        else Object.values(v).forEach(walk);
      }
    };
    walk(def);
  }
  return out;
}

async function seedProject(session) {
  const project = await postJson(session, `/api/v1/orgs/${slug}/projects`, { requestId: randomUUID(), name: `Load ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  const all = questionsByStage();
  let n = 0;
  const tally = { done: 0, partly: 0, not_yet: 0, scope: 0 };
  for (const { stage, q } of all) {
    n += 1;
    const gate = q.type === 'gate';
    const status = gate ? null : n % 11 === 0 ? 'not_yet' : n % 7 === 0 ? 'partly' : 'done';
    await postJson(session, `/api/v1/orgs/${slug}/projects/${project.id}/decisions`, {
      requestId: randomUUID(), stage, questionId: q.id, baseVersionNumber: null, status, scopeAnswer: gate ? 'yes' : null,
      optionsInPlace: q.type === 'checklist' ? q.options.slice(0, 2) : [],
      reasonCode: status === 'not_yet' ? 'ny_planned_later' : null,
      reason: `Load measurement reason ${n} for ${q.id}: what was done, where it is kept, and who can confirm it.`,
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
    });
    tally[gate ? 'scope' : status] += 1;
    await sleep(SEED_PACE_MS);
  }
  return { id: project.id, questions: all.length, tally };
}

// ---- measuring --------------------------------------------------------------------------------------------------------
/** One GET: time to first byte (headers) and total (body read to the end), in ms; the body's bytes are kept only when asked. */
async function timed(session, path, { keepBody = false } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${origin}${path}`, { redirect: 'manual', headers: { cookie: cookieHeader(session) } });
    const ttfb = performance.now() - t0;
    const bytes = Buffer.from(await res.arrayBuffer());
    const total = performance.now() - t0;
    return { status: res.status, ttfbMs: round(ttfb), totalMs: round(total), size: bytes.byteLength, body: keepBody ? bytes : undefined, pdf: bytes.subarray(0, 5).toString('latin1') === '%PDF-' };
  } catch (e) {
    return { status: 0, error: String(e?.cause?.code ?? e?.message ?? e), totalMs: round(performance.now() - t0), size: 0, pdf: false };
  }
}

const round = (x) => Math.round(x * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const p95 = (xs) => { const s = sorted(xs); return round(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]); };

async function burst(sessions, pdfPath, pagePath) {
  const downloads = Array.from({ length: BURST_SIZE }, (_, i) => timed(sessions[i % sessions.length], pdfPath));
  await sleep(PAGE_DELAY_MS);
  const page = timed(sessions[0], pagePath);
  const [pdfs, pageResult] = [await Promise.all(downloads), await page];
  const ok = pdfs.filter((r) => r.status === 200 && r.pdf);
  const times = ok.map((r) => r.totalMs);
  return {
    pdf: {
      requests: pdfs.length, errors: pdfs.length - ok.length, statuses: Object.fromEntries([...new Set(pdfs.map((r) => r.status))].map((s) => [s, pdfs.filter((r) => r.status === s).length])),
      medianMs: times.length ? median(times) : null, p95Ms: times.length ? p95(times) : null, maxMs: times.length ? round(Math.max(...times)) : null,
    },
    page: { status: pageResult.status, ttfbMs: pageResult.ttfbMs ?? null, totalMs: pageResult.totalMs, size: pageResult.size },
  };
}

/** The page count of a PDF: the page objects (`/Type /Page`, not `/Pages`) in its bytes; checked against the document's own count when it has one. */
function pdfPages(bytes) {
  const text = bytes.toString('latin1');
  const objects = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return { pageObjects: objects, declaredCount: counts.length ? Math.max(...counts) : null };
}

async function main() {
  const sessions = [await signIn(email)];
  for (const e of extraEmails) sessions.push(await signIn(e));
  const main = sessions[0];
  log(`signed in ${sessions.length} account(s)`);
  const project = await seedProject(main);
  log(`seeded project ${project.id}: ${project.questions} questions ${JSON.stringify(project.tally)}`);
  const pagePath = `/orgs/${slug}/projects/${project.id}`;
  const reportPath = (part) => `/api/v1/orgs/${slug}/projects/${project.id}/working-report?part=${encodeURIComponent(part)}`;

  log('seeded; waiting out the rate-limit window');
  await sleep(61_000);
  // warm-up: one page and one PDF, not counted, so the first compile or connection does not stand in for steady state
  const warmPdf = await timed(main, reportPath('all'), { keepBody: true });
  const warmPage = await timed(main, pagePath);
  if (warmPdf.status !== 200 || !warmPdf.pdf) refuse(`the whole report answered ${warmPdf.status}${warmPdf.error ? ` (${warmPdf.error})` : ''}, not a PDF`);
  if (warmPage.status !== 200) refuse(`the project page answered ${warmPage.status}`);
  log('warm-up done');

  const baselineRuns = [];
  for (let i = 0; i < BASELINE_RUNS; i++) baselineRuns.push(await timed(main, pagePath));
  const baseline = {
    runs: baselineRuns.map((r) => ({ status: r.status, ttfbMs: r.ttfbMs, totalMs: r.totalMs })),
    medianTtfbMs: median(baselineRuns.map((r) => r.ttfbMs)), medianTotalMs: median(baselineRuns.map((r) => r.totalMs)),
  };
  log(`baseline: median TTFB ${baseline.medianTtfbMs} ms, total ${baseline.medianTotalMs} ms`);

  const wholeBurst = [];
  for (let i = 0; i < BURST_RUNS; i++) {
    await sleep(PAUSE_BETWEEN_RUNS_MS);
    wholeBurst.push(await burst(sessions, reportPath('all'), pagePath));
    log(`burst part=all #${i + 1}: page total ${wholeBurst[i].page.totalMs} ms, pdf median ${wholeBurst[i].pdf.medianMs} ms, errors ${wholeBurst[i].pdf.errors}`);
  }
  await sleep(PAUSE_BETWEEN_RUNS_MS);
  const summaryBurst = await burst(sessions, reportPath('summary'), pagePath);
  log(`burst part=summary: page total ${summaryBurst.page.totalMs} ms, pdf median ${summaryBurst.pdf.medianMs} ms, errors ${summaryBurst.pdf.errors}`);

  const limitMs = Math.max(3 * baseline.medianTotalMs, 5000);
  const worst = Math.max(...wholeBurst.map((b) => b.page.totalMs));
  const overall = {
    pageTotalMedianMs: median(wholeBurst.map((b) => b.page.totalMs)), pageTotalWorstMs: worst,
    thresholdMs: limitMs, rule: 'page total under the burst > 3x baseline median total, or > 5000 ms',
    crossed: wholeBurst.some((b) => b.page.totalMs > 3 * baseline.medianTotalMs || b.page.totalMs > 5000 || b.page.status !== 200),
  };

  process.stdout.write(`${JSON.stringify({
    measuredAt: new Date().toISOString(), baseUrl: origin, accounts: sessions.length, burstSize: BURST_SIZE, pageDelayMs: PAGE_DELAY_MS, project,
    onePdfResponse: { part: 'all', size: warmPdf.size, ...pdfPages(warmPdf.body), warmUpTotalMs: warmPdf.totalMs },
    baseline, burstAll: wholeBurst, burstSummary: summaryBurst, threshold: overall,
  }, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`working-report-burst: failed: ${String(e?.message ?? e).replaceAll(password, '***')}\n`);
  process.exit(1);
});
