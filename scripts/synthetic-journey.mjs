#!/usr/bin/env node

/**
 * The hourly synthetic journey (FR-OPS-01, NFR-AVL-03): sign in, read one decision, save its next version,
 * read it back and replay the save.
 *
 * It runs from .github/workflows/synthetic.yml and from the host (ops/host/makrai-synthetic.sh) against
 * production, as a real account in an organisation that is not a team ("zz Synthetic monitoring (not a team)"),
 * on one fixed question of a project made for it (SYNTHETIC_PROJECT_ID, SYNTHETIC_STAGE, SYNTHETIC_QUESTION_ID).
 * The question must already hold a decision that can be saved again. It writes one decision version an hour.
 * FR-DEC-01 refuses a save identical to the current version (422 on `form`), so every run changes one field,
 * the reason, which carries the run's UTC time.
 *
 * The steps, and what each expects. The sign-in follows @auth/core 0.41.3, read from
 * lib/index.js, lib/actions/callback/index.js and lib/actions/callback/oauth/csrf-token.js:
 *
 *   csrf      GET  /api/auth/csrf                    200, {csrfToken}, and a csrf cookie holding `token|hash`
 *   signin    POST /api/auth/callback/credentials    302 with a session cookie and no `error=` in Location.
 *             Form body: csrfToken, email, password. The csrf cookie goes back with it: the token
 *             in the body is only believed when it matches the one in the cookie, and the cookie's
 *             hash is checked against the server's secret. A wrong password is also a 302, to
 *             /login?error=CredentialsSignin, which is why the status alone cannot tell success
 *             from failure here.
 *   read      GET  .../projects/{id}/questions/{questionId}/decision?stage={stage}   200, {current} not null
 *   save      POST .../projects/{id}/decisions        201, a SaveDecisionRequest built from `current` with a
 *             fresh requestId, baseVersionNumber = current.versionNumber and a new reason; the answer's
 *             versionNumber is current.versionNumber + 1
 *   readback  GET  the read URL                       200, `current.id` is the id the save returned
 *   replay    POST the same body, the same requestId  200, the same id ("already saved", FR-DEC-07)
 *
 * Redirects are never followed (`redirect: 'manual'`): a request the server sends to /login would
 * otherwise come back as the login page's 200, and the journey would call that a pass.
 *
 * WHAT IT NEVER DOES. It never prints a body, a cookie, the password or the email. It prints one line per
 * step, `step=<name> status=<code>`, and on the step that failed it adds `reason=<code>`, a code from the
 * fixed list below and never text taken from a response or an error. Status 0 means no response
 * (DNS, TLS, refused, timed out). The failure is reported, not logged: the error that caused it is
 * dropped on purpose, because an error message can carry a URL, a header or part of a body.
 *
 * Run: BASE_URL=https://makrai.org SYNTHETIC_EMAIL=... SYNTHETIC_PASSWORD=... SYNTHETIC_ORG_SLUG=... \
 *      SYNTHETIC_PROJECT_ID=... SYNTHETIC_STAGE=... SYNTHETIC_QUESTION_ID=... node scripts/synthetic-journey.mjs
 * Exit 0 when every step passed, 1 at the first that did not, or when the configuration is incomplete.
 *
 * Uses only Node's built-ins (fetch, Headers.getSetCookie, crypto), as scripts/pen-test.mjs does.
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** One request. A hung connection fails its step instead of waiting for the workflow's 5-minute limit. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The session cookie, or one chunk of it: `authjs.session-token`, `__Secure-authjs.session-token.0`. */
const SESSION_COOKIE = /session-token(\.\d+)?$/;

const USER_AGENT = 'makrai-synthetic-monitor/1';

/**
 * Why a journey failed, as a code. The only text the command prints about a failure.
 * @typedef {'no_response' | 'unexpected_status' | 'not_json' | 'no_csrf_token' | 'signin_error' | 'no_session_cookie' | 'no_current_decision' | 'not_saveable' | 'version_not_advanced' | 'readback_differs' | 'replay_not_recognised'} Reason
 */

/**
 * @typedef {{ name: string, status: number }} Step
 * @typedef {{ ok: boolean, steps: Step[], reason?: Reason }} JourneyResult
 */

/** Wrong configuration, with a message that names a parameter and never a value. */
class ConfigError extends Error {}

/** @param {string} value */
function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('baseUrl is not a valid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    // The password is in the request body. Over plain http to a remote host it would cross the network in the clear.
    throw new ConfigError('baseUrl must be an https URL (http is allowed for localhost only)');
  }
  return url;
}

/** The cookies of one session, by name. Enough of a jar for one origin and one run. */
class CookieJar {
  /** @type {Map<string, string>} */
  #cookies = new Map();

  /** @param {Response} res */
  store(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
      if (value === '' || expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  hasSession() {
    return [...this.#cookies].some(([name, value]) => SESSION_COOKIE.test(name) && value !== '');
  }
}

/**
 * One request, or null when none was answered. The error is dropped on purpose: see the header.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 */
async function send(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/** The parsed JSON body, or null when it is not JSON. Nothing about the body is kept but its value. */
async function jsonOf(/** @type {Response} */ res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The save request for the next version of `current`, or null when `current` cannot be saved again: withdrawn,
 * or a field the request needs is gone (a reason erased, no decider or declared date recorded).
 * Only the reason changes, and it carries the run's UTC time (see the header).
 * @param {Record<string, any>} current a DecisionVersionView
 * @param {{ stage: string, questionId: string }} ids
 */
function nextSave(current, { stage, questionId }) {
  const { status, reason, decidedBy, declaredDate } = current;
  // A gate question's decision has status null and a scope answer; it can be saved again like any other.
  if (status === 'withdrawn' || typeof reason !== 'string') return null;
  if (typeof declaredDate !== 'string' || !isObject(decidedBy)) return null;
  /** @type {Record<string, unknown> | null} */
  let decider = null;
  if (decidedBy.kind === 'member' && isObject(decidedBy.user)) decider = { kind: 'member', userId: decidedBy.user.userId };
  else if (decidedBy.kind === 'outside_role') decider = { kind: 'outside_role', role: decidedBy.role };
  if (decider === null || !Number.isInteger(current.versionNumber)) return null;
  return {
    requestId: randomUUID(),
    stage,
    questionId,
    baseVersionNumber: current.versionNumber,
    status,
    scopeAnswer: current.scopeAnswer ?? null,
    optionsInPlace: current.optionsInPlace ?? [],
    reasonCode: current.reasonCode ?? null,
    reason: `Synthetic monitoring check at ${new Date().toISOString().slice(0, 19)}Z`,
    decidedBy: decider,
    declaredDate,
    evidenceIds: Array.isArray(current.evidence) ? current.evidence.map((/** @type {{ id: string }} */ e) => e.id) : [],
  };
}

/**
 * @param {{ baseUrl: string, email: string, password: string, orgSlug: string, projectId: string, stage: string, questionId: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<JourneyResult>} Stops at the first step that fails; that step is the last one in `steps`.
 */
export async function runJourney({ baseUrl, email, password, orgSlug, projectId, stage, questionId, fetchImpl = fetch }) {
  const base = parseBaseUrl(baseUrl);
  for (const [name, value] of Object.entries({ email, password, orgSlug, projectId, stage, questionId })) {
    if (typeof value !== 'string' || value === '') throw new ConfigError(`${name} must be a non-empty string`);
  }

  /** @type {Step[]} */
  const steps = [];
  const jar = new CookieJar();
  const project = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}`;
  const decisionUrl = `${project}/questions/${encodeURIComponent(questionId)}/decision?stage=${encodeURIComponent(stage)}`;
  const saveUrl = `${project}/decisions`;

  /**
   * Make one request, record its step, keep any cookies it set. Null when nothing answered.
   * @param {string} name
   * @param {string} path
   * @param {{ method: string, headers?: Record<string, string>, body?: string }} init
   */
  const call = async (name, path, { method, headers = {}, body }) => {
    const cookie = jar.header();
    const res = await send(fetchImpl, new URL(path, base).href, {
      method,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(cookie === '' ? {} : { cookie }), ...headers },
      ...(body === undefined ? {} : { body }),
    });
    steps.push({ name, status: res ? res.status : 0 });
    if (res) jar.store(res);
    return res;
  };
  /** @param {Reason} reason @returns {JourneyResult} */
  const failed = (reason) => ({ ok: false, steps, reason });

  const csrf = await call('csrf', '/api/auth/csrf', { method: 'GET' });
  if (!csrf) return failed('no_response');
  if (csrf.status !== 200) return failed('unexpected_status');
  const csrfBody = await jsonOf(csrf);
  if (!isObject(csrfBody)) return failed('not_json');
  const csrfToken = csrfBody.csrfToken;
  if (typeof csrfToken !== 'string' || csrfToken === '') return failed('no_csrf_token');

  const signin = await call('signin', '/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, email, password }).toString(),
  });
  if (!signin) return failed('no_response');
  if (signin.status !== 302) return failed('unexpected_status');
  if ((signin.headers.get('location') ?? '').includes('error=')) return failed('signin_error');
  if (!jar.hasSession()) return failed('no_session_cookie');

  const read = await call('read', decisionUrl, { method: 'GET' });
  if (!read) return failed('no_response');
  if (read.status !== 200) return failed('unexpected_status');
  const readBody = await jsonOf(read);
  if (!isObject(readBody)) return failed('not_json');
  const current = readBody.current;
  if (!isObject(current)) return failed('no_current_decision');
  const request = nextSave(current, { stage, questionId });
  if (request === null) return failed('not_saveable');

  const post = JSON.stringify(request);
  const save = await call('save', saveUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: post });
  if (!save) return failed('no_response');
  if (save.status !== 201) return failed('unexpected_status');
  const saved = await jsonOf(save);
  if (!isObject(saved)) return failed('not_json');
  if (typeof saved.id !== 'string' || saved.versionNumber !== current.versionNumber + 1) return failed('version_not_advanced');

  const readback = await call('readback', decisionUrl, { method: 'GET' });
  if (!readback) return failed('no_response');
  if (readback.status !== 200) return failed('unexpected_status');
  const backBody = await jsonOf(readback);
  if (!isObject(backBody)) return failed('not_json');
  const back = backBody.current;
  if (!isObject(back) || back.id !== saved.id) return failed('readback_differs');

  // The same request id and body again: the server must answer with the version it already made, not a new one.
  const replay = await call('replay', saveUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: post });
  if (!replay) return failed('no_response');
  if (replay.status !== 200) return failed(replay.status === 201 ? 'replay_not_recognised' : 'unexpected_status');
  const replayBody = await jsonOf(replay);
  if (!isObject(replayBody)) return failed('not_json');
  if (replayBody.id !== saved.id) return failed('replay_not_recognised');

  return { ok: true, steps };
}

export const REQUIRED_ENV = ['BASE_URL', 'SYNTHETIC_EMAIL', 'SYNTHETIC_PASSWORD', 'SYNTHETIC_ORG_SLUG', 'SYNTHETIC_PROJECT_ID', 'SYNTHETIC_STAGE', 'SYNTHETIC_QUESTION_ID'];

async function main() {
  const env = process.env;
  // An unset secret reaches the step as an empty string, so empty counts as missing.
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`missing configuration: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await runJourney({
      baseUrl: /** @type {string} */ (env.BASE_URL),
      email: /** @type {string} */ (env.SYNTHETIC_EMAIL),
      password: /** @type {string} */ (env.SYNTHETIC_PASSWORD),
      orgSlug: /** @type {string} */ (env.SYNTHETIC_ORG_SLUG),
      projectId: /** @type {string} */ (env.SYNTHETIC_PROJECT_ID),
      stage: /** @type {string} */ (env.SYNTHETIC_STAGE),
      questionId: /** @type {string} */ (env.SYNTHETIC_QUESTION_ID),
    });
  } catch (e) {
    // A ConfigError's message names a parameter and never a value. Any other error is a bug in this
    // script, and its message could hold anything, so only its class is printed.
    console.error(e instanceof ConfigError ? `configuration error: ${e.message}` : `unexpected error: ${e instanceof Error ? e.name : typeof e}`);
    process.exitCode = 1;
    return;
  }

  result.steps.forEach((step, i) => {
    const last = i === result.steps.length - 1;
    console.log(`step=${step.name} status=${step.status}${last && !result.ok ? ` reason=${result.reason}` : ''}`);
  });
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
