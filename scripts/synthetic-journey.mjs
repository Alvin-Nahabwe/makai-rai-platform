#!/usr/bin/env node

/**
 * The hourly synthetic journey (Task 20, RL 2.3): sign in, save an assessment, read it back.
 *
 * It runs from .github/workflows/synthetic.yml against production, as a real account in an
 * organisation that is not a team ("zz Synthetic monitoring (not a team)"), on an assessment
 * that is started and never completed. Completing one would make it immutable: the save
 * below would then answer 409 and the check would go red for a reason that is not an outage.
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
 *   read      GET   /api/v1/orgs/{slug}/assessments/{id}   200, with an engineState
 *   save      PATCH the same URL, {engineState} as read    200 (the route refuses a state without all stages)
 *   readback  GET   the same URL                           200, with an engineState deep-equal to the one saved
 *
 * Redirects are never followed (`redirect: 'manual'`): a request the server sends to /login would
 * otherwise come back as the login page's 200, and the journey would call that a pass.
 *
 * WHAT IT NEVER DOES. It never prints a body, a cookie, the password or the email, and it never
 * reads a score: it compares `engineState` and nothing else. It prints one line per step,
 * `step=<name> status=<code>`, and on the step that failed it adds `reason=<code>`, a code from the
 * fixed list below and never text taken from a response or an error. Status 0 means no response
 * (DNS, TLS, refused, timed out). The failure is reported, not logged: the error that caused it is
 * dropped on purpose, because an error message can carry a URL, a header or part of a body.
 *
 * Run: BASE_URL=https://makrai.org SYNTHETIC_EMAIL=... SYNTHETIC_PASSWORD=... \
 *      SYNTHETIC_ORG_SLUG=... SYNTHETIC_ASSESSMENT_ID=... node scripts/synthetic-journey.mjs
 * Exit 0 when every step passed, 1 at the first that did not, or when the configuration is incomplete.
 *
 * Uses only Node's built-ins (fetch, Headers.getSetCookie), as scripts/pen-test.mjs does.
 */

import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

/** One request. A hung connection fails its step instead of waiting for the workflow's 5-minute limit. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The session cookie, or one chunk of it: `authjs.session-token`, `__Secure-authjs.session-token.0`. */
const SESSION_COOKIE = /session-token(\.\d+)?$/;

const USER_AGENT = 'makrai-synthetic-monitor/1';

/**
 * Why a journey failed, as a code. The only text the command prints about a failure.
 * @typedef {'no_response' | 'unexpected_status' | 'no_csrf_token' | 'signin_error' | 'no_session_cookie' | 'no_engine_state' | 'readback_differs'} Reason
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
 * @param {{ baseUrl: string, email: string, password: string, orgSlug: string, assessmentId: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<JourneyResult>} Stops at the first step that fails; that step is the last one in `steps`.
 */
export async function runJourney({ baseUrl, email, password, orgSlug, assessmentId, fetchImpl = fetch }) {
  const base = parseBaseUrl(baseUrl);
  for (const [name, value] of Object.entries({ email, password, orgSlug, assessmentId })) {
    if (typeof value !== 'string' || value === '') throw new ConfigError(`${name} must be a non-empty string`);
  }

  /** @type {Step[]} */
  const steps = [];
  const jar = new CookieJar();
  const assessment = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/assessments/${encodeURIComponent(assessmentId)}`;

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
  const csrfToken = (await jsonOf(csrf))?.csrfToken;
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

  const read = await call('read', assessment, { method: 'GET' });
  if (!read) return failed('no_response');
  if (read.status !== 200) return failed('unexpected_status');
  const engineState = (await jsonOf(read))?.engineState;
  if (!isObject(engineState)) return failed('no_engine_state');

  const save = await call('save', assessment, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engineState }),
  });
  if (!save) return failed('no_response');
  if (save.status !== 200) return failed('unexpected_status');

  const readback = await call('readback', assessment, { method: 'GET' });
  if (!readback) return failed('no_response');
  if (readback.status !== 200) return failed('unexpected_status');
  // Deep equality, not a string comparison: Postgres JSONB does not keep the order of an object's keys.
  if (!isDeepStrictEqual((await jsonOf(readback))?.engineState, engineState)) return failed('readback_differs');

  return { ok: true, steps };
}

const REQUIRED_ENV = ['BASE_URL', 'SYNTHETIC_EMAIL', 'SYNTHETIC_PASSWORD', 'SYNTHETIC_ORG_SLUG', 'SYNTHETIC_ASSESSMENT_ID'];

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
      assessmentId: /** @type {string} */ (env.SYNTHETIC_ASSESSMENT_ID),
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
