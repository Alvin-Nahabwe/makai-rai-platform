import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { runJourney } from '../../scripts/synthetic-journey.mjs';

/**
 * FR-OPS-01, NFR-AVL-03: the hourly synthetic sign-in, then read, save, read-back and replay of one decision.
 *
 * `runJourney` signs in the way a browser does, reads the current decision of a fixed question (route 48),
 * saves the next version of it (route 1), reads it back and replays the save. These tests run it against a
 * stand-in for NextAuth and the two decision routes. The stand-in enforces the contract the real endpoints
 * enforce, as read from @auth/core 0.41.3 (lib/index.js, lib/actions/callback/index.js, lib/actions/callback/oauth/csrf-token.js)
 * and from the contract (routes 1 and 48):
 *
 *   - GET  /api/auth/csrf answers {csrfToken} and sets a csrf cookie holding `token|hash`;
 *   - POST /api/auth/callback/credentials needs that cookie AND the same token in the form
 *     body, else it redirects to .../api/auth/error?error=MissingCSRF;
 *   - a wrong password redirects to /login?error=CredentialsSignin&code=credentials, with no
 *     session cookie; success redirects with a session cookie (HTTP 302 either way);
 *   - the read, save and read-back answer 401 without the session cookie;
 *   - a save names the version it is based on (409 if it moved), is refused as identical to the current
 *     version (422), and a request id seen before answers 200 with the version it made (FR-DEC-07).
 *
 * So the happy-path test passes only if the client really sends the cookie, the token and
 * the credentials, and really sends the session cookie back on every later step.
 *
 * What no test here can prove is that production's real NextAuth behaves as the stand-in
 * does. The first run of the workflow against makrai.org is that proof (Task 20 step 5).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stand-in bodies are untyped JSON
type Rec = Record<string, any>;

const REPO_ROOT = join(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/synthetic-journey.mjs');

// Values that must never reach stdout or stderr. Each is distinctive, so a leak is a plain substring hit.
const EMAIL = 'synthetic-monitor@example.invalid';
const FAKE_PW = 'PW-MARKER-Zk3-never-print-me';
const WRONG_PW = 'a-different-pw-value';
const SLUG = 'zz-synthetic-monitoring';
const PROJECT_ID = '5b0f4c1e-1d2a-4f6e-9a77-0c0ffee00001';
const STAGE = 'pre-processing';
const QUESTION_ID = 'Q-PP-01';
const CSRF_FORM_VALUE = 'csrf-token-a1b2c3';
const CSRF_COOKIE = '__Host-authjs.csrf-token';
const CSRF_COOKIE_VALUE = `${CSRF_FORM_VALUE}%7Ccsrf-hash-COOKIE-MARKER-9f8e`;
const SESSION_COOKIE = '__Secure-authjs.session-token';
const SESSION_COOKIE_VALUE = 'SESSION-COOKIE-MARKER-eyJhbGciOiJkaXIi';
const BODY_MARKER = 'BODY-MARKER-private-project-name';

const SECRET_MARKERS = [FAKE_PW, CSRF_COOKIE_VALUE, CSRF_FORM_VALUE, SESSION_COOKIE_VALUE, BODY_MARKER, EMAIL];

const CURRENT_V3 = {
  id: 'dv-3', projectId: PROJECT_ID, stage: STAGE, questionId: QUESTION_ID, versionNumber: 3, baseVersionNumber: 2,
  content: { contentVersionId: 'cv-1', semver: '1.0.0', contentHash: 'h' }, status: 'partly', scopeAnswer: 'yes',
  optionsInPlace: ['o1', 'o2'], reasonCode: 'na_x', reason: 'Synthetic check, earlier run', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: 'u-synth', name: BODY_MARKER, formerMember: false } },
  declaredDate: '2026-10-01', declaredPrecision: 'day', withdrawalCode: null,
  enteredBy: { userId: 'u-synth', name: BODY_MARKER, formerMember: false }, enteredByRole: 'org_admin',
  receivedAt: '2026-11-01T10:00:00.000Z', evidence: [{ id: 'ev-1' }, { id: 'ev-2' }],
} as Rec;

const DECISION_PATH = `/api/v1/orgs/${SLUG}/projects/${PROJECT_ID}/questions/${QUESTION_ID}/decision?stage=${STAGE}`;
const SAVE_PATH = `/api/v1/orgs/${SLUG}/projects/${PROJECT_ID}/decisions`;

type StepName = 'csrf' | 'signin' | 'read' | 'save' | 'readback' | 'replay';

interface FakeReq {
  method: string;
  path: string;
  headers: Headers;
  body: string;
  redirect?: RequestRedirect;
  signal?: AbortSignal | null;
}
interface FakeRes {
  status: number;
  headers: [string, string][];
  body: string;
}
type Override = (req: FakeReq, normal: () => FakeRes) => FakeRes;

interface FakeOptions {
  origin?: string;
  override?: Partial<Record<StepName, Override>>;
  /** The `name=value` pairs the sign-in sets as the session. One pair, or several for a chunked cookie. */
  sessionCookies?: [string, string][];
  /** The current decision the stand-in holds; null for none. */
  current?: Rec | null;
}

const json = (status: number, value: unknown, extra: [string, string][] = []): FakeRes => ({
  status,
  headers: [['content-type', 'application/json'], ...extra],
  body: JSON.stringify(value),
});
const html = (status: number): FakeRes => ({ status, headers: [['content-type', 'text/html']], body: '<html>challenge</html>' });
const redirect = (location: string, extra: [string, string][] = []): FakeRes => ({
  status: 302,
  headers: [['location', location], ...extra],
  body: '',
});

/** A stand-in for NextAuth plus the two decision routes, as pure request -> response logic. */
function makeFake(options: FakeOptions = {}) {
  const origin = options.origin ?? 'https://synthetic.example.test';
  const sessionCookies = options.sessionCookies ?? [[SESSION_COOKIE, SESSION_COOKIE_VALUE]];
  const stored = { current: (options.current === undefined ? structuredClone(CURRENT_V3) : options.current) as Rec | null };
  const byRequestId = new Map<string, Rec>();
  const log: FakeReq[] = [];
  let decisionGets = 0;
  let posts = 0;

  const hasSession = (req: FakeReq): boolean => {
    const cookie = req.headers.get('cookie') ?? '';
    return sessionCookies.every(([n, v]) => cookie.split('; ').includes(`${n}=${v}`));
  };
  const unauthorized = () => json(401, { error: 'Unauthorized', echoed: BODY_MARKER });

  const normal = (step: StepName, req: FakeReq): FakeRes => {
    switch (step) {
      case 'csrf':
        return json(200, { csrfToken: CSRF_FORM_VALUE }, [
          ['set-cookie', `${CSRF_COOKIE}=${CSRF_COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax`],
        ]);
      case 'signin': {
        const form = new URLSearchParams(req.body);
        const cookie = req.headers.get('cookie') ?? '';
        const csrfVerified =
          cookie.split('; ').includes(`${CSRF_COOKIE}=${CSRF_COOKIE_VALUE}`) &&
          form.get('csrfToken') === CSRF_FORM_VALUE &&
          (req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
        if (!csrfVerified) return redirect(`${origin}/api/auth/error?error=MissingCSRF`);
        if (form.get('email') !== EMAIL || form.get('password') !== FAKE_PW) {
          return redirect(`${origin}/login?error=CredentialsSignin&code=credentials`);
        }
        return redirect(
          origin,
          sessionCookies.map(([n, v]) => ['set-cookie', `${n}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax`] as [string, string]),
        );
      }
      case 'read':
      case 'readback':
        if (req.path !== DECISION_PATH) return json(404, { error: 'Not found' });
        if (!hasSession(req)) return unauthorized();
        return json(200, { current: stored.current });
      case 'save':
      case 'replay': {
        if (req.path !== SAVE_PATH) return json(404, { error: 'Not found' });
        if (!hasSession(req)) return unauthorized();
        if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(400, { error: 'bad type' });
        const body = JSON.parse(req.body) as Rec;
        const seen = byRequestId.get(body.requestId);
        if (seen) return json(200, seen);
        const cur = stored.current;
        if (!cur || body.baseVersionNumber !== cur.versionNumber) return json(409, { error: 'base_version_moved', current: cur, echoed: BODY_MARKER });
        if (body.reason === cur.reason) return json(422, { error: 'validation', field: 'form' });
        const next = {
          ...cur, id: `dv-${cur.versionNumber + 1}`, versionNumber: cur.versionNumber + 1, baseVersionNumber: cur.versionNumber,
          reason: body.reason, status: body.status, scopeAnswer: body.scopeAnswer, optionsInPlace: body.optionsInPlace,
          reasonCode: body.reasonCode, declaredDate: body.declaredDate, evidence: body.evidenceIds.map((id: string) => ({ id })),
        };
        stored.current = next;
        byRequestId.set(body.requestId, next);
        return json(201, next);
      }
    }
  };

  const classify = (req: FakeReq): StepName => {
    if (req.path === '/api/auth/csrf') return 'csrf';
    if (req.path === '/api/auth/callback/credentials') return 'signin';
    if (req.method === 'POST') return posts++ === 0 ? 'save' : 'replay';
    return decisionGets++ === 0 ? 'read' : 'readback';
  };

  const handle = (req: FakeReq): FakeRes => {
    log.push(req);
    const step = classify(req);
    const res = options.override?.[step]?.(req, () => normal(step, req)) ?? normal(step, req);
    return res;
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const res = handle({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '',
      redirect: init?.redirect,
      signal: init?.signal,
    });
    const headers = new Headers();
    for (const [k, v] of res.headers) headers.append(k, v);
    return new Response(res.body === '' ? null : res.body, { status: res.status, headers });
  };

  return { fetchImpl: fetchImpl as typeof fetch, handle, log, stored };
}

const journeyArgs = (fetchImpl: typeof fetch) => ({
  baseUrl: 'https://synthetic.example.test',
  email: EMAIL,
  password: FAKE_PW,
  orgSlug: SLUG,
  projectId: PROJECT_ID,
  stage: STAGE,
  questionId: QUESTION_ID,
  fetchImpl,
});

const OK_STEPS = [
  { name: 'csrf', status: 200 },
  { name: 'signin', status: 302 },
  { name: 'read', status: 200 },
  { name: 'save', status: 201 },
  { name: 'readback', status: 200 },
  { name: 'replay', status: 200 },
];

describe('runJourney', () => {
  it('FR-OPS-01: the journey reads, saves base+1 with a fresh request id, reads back and replays as already saved', async () => {
    const fake = makeFake();
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result).toEqual({ ok: true, steps: OK_STEPS });
    const posts = fake.log.filter((r) => r.method === 'POST' && r.path === SAVE_PATH).map((r) => JSON.parse(r.body));
    expect(posts).toHaveLength(2);
    const [save, replay] = posts;
    expect(save).toMatchObject({
      baseVersionNumber: 3, questionId: QUESTION_ID, stage: STAGE, status: 'partly', scopeAnswer: 'yes',
      optionsInPlace: ['o1', 'o2'], reasonCode: 'na_x', declaredDate: '2026-10-01',
      decidedBy: { kind: 'member', userId: 'u-synth' }, evidenceIds: ['ev-1', 'ev-2'],
    });
    expect(save.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(replay).toEqual(save);
    expect(fake.stored.current?.versionNumber).toBe(4);
  });

  it('FR-OPS-01: each run changes one field, so a save is never identical to the current version (REACH-1)', async () => {
    const fake = makeFake();
    await runJourney(journeyArgs(fake.fetchImpl));
    const save = JSON.parse(fake.log.find((r) => r.method === 'POST' && r.path === SAVE_PATH)!.body);
    expect(save.reason).not.toBe(CURRENT_V3.reason);
    expect(save.reason).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
    // A second run on the saved state changes it again (the stand-in answers 422 for an identical save).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(Date.now() + 3_600_000) });
    try {
      const again = await runJourney(journeyArgs(fake.fetchImpl));
      expect(again.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.stored.current?.versionNumber).toBe(5);
  });

  it('FR-OPS-01: a replay answered 201 (a second version) fails with replay_not_recognised', async () => {
    const fake = makeFake({
      override: {
        replay: () => json(201, { ...CURRENT_V3, id: 'dv-5', versionNumber: 5 }),
      },
    });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: 'replay', status: 201 });
    expect(r.reason).toBe('replay_not_recognised');
  });

  it('FR-OPS-01: a replay answered 200 with another id fails with replay_not_recognised', async () => {
    const fake = makeFake({ override: { replay: () => json(200, { id: 'dv-other', versionNumber: 4 }) } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.reason).toBe('replay_not_recognised');
  });

  it('FR-OPS-01: a save answered 201 that did not advance the version fails with version_not_advanced', async () => {
    const fake = makeFake({ override: { save: () => json(201, { ...CURRENT_V3 }) } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: 'save', status: 201 });
    expect(r.reason).toBe('version_not_advanced');
  });

  it('FR-OPS-01: a read-back that names another version fails with readback_differs', async () => {
    const fake = makeFake({ override: { readback: () => json(200, { current: { ...CURRENT_V3, id: 'dv-other', versionNumber: 4 } }) } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: 'readback', status: 200 });
    expect(r.reason).toBe('readback_differs');
  });

  it.each([
    ['csrf', 'csrf'],
    ['read', 'read'],
    ['save', 'save'],
    ['readback', 'readback'],
    ['replay', 'replay'],
  ] as const)('FR-OPS-01: a %s answered with a body that is not JSON fails with not_json, not with the reason of a missing field', async (_n, step) => {
    const status = step === 'save' ? 201 : 200;
    const fake = makeFake({ override: { [step]: () => html(status) } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: step, status });
    expect(r.reason).toBe('not_json');
  });

  it('FR-OPS-01: a gate question\'s current decision has status null and a scope answer, and is saved again with status null', async () => {
    const fake = makeFake({ current: { ...CURRENT_V3, status: null, scopeAnswer: 'no', optionsInPlace: [] } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r).toEqual({ ok: true, steps: OK_STEPS });
    const save = JSON.parse(fake.log.find((q) => q.method === 'POST' && q.path === SAVE_PATH)!.body);
    expect(save).toMatchObject({ status: null, scopeAnswer: 'no', baseVersionNumber: 3 });
  });

  it('FR-OPS-01: a question with no current decision fails with no_current_decision and sends no save', async () => {
    const fake = makeFake({ current: null });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: 'read', status: 200 });
    expect(r.reason).toBe('no_current_decision');
    expect(fake.log.some((q) => q.method === 'POST' && q.path === SAVE_PATH)).toBe(false);
  });

  it.each([
    ['withdrawn', { status: 'withdrawn' }],
    ['reason erased', { reason: null }],
    ['no decider', { decidedBy: null }],
    ['no declared date', { declaredDate: null }],
  ])('FR-OPS-01: a current decision that is %s fails with not_saveable and sends no save', async (_n, patch) => {
    const fake = makeFake({ current: { ...CURRENT_V3, ...patch } });
    const r = await runJourney(journeyArgs(fake.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toEqual({ name: 'read', status: 200 });
    expect(r.reason).toBe('not_saveable');
    expect(fake.log.some((q) => q.method === 'POST' && q.path === SAVE_PATH)).toBe(false);
  });

  it('FR-OPS-01: an outside-role decider is sent as an outside role, not as a user', async () => {
    const fake = makeFake({ current: { ...CURRENT_V3, decidedBy: { kind: 'outside_role', role: 'external_auditor' } } });
    await runJourney(journeyArgs(fake.fetchImpl));
    const save = JSON.parse(fake.log.find((q) => q.method === 'POST' && q.path === SAVE_PATH)!.body);
    expect(save.decidedBy).toEqual({ kind: 'outside_role', role: 'external_auditor' });
  });

  it('FR-OPS-01 NFR-AVL-03: fails and names the step when the save returns 500', async () => {
    const fake = makeFake({ override: { save: () => json(500, { echoed: BODY_MARKER, password: FAKE_PW }) } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'save', status: 500 });
    expect(result.reason).toBe('unexpected_status');
    // It stops at the first failure: nothing is read back after a failed save.
    expect(result.steps.map((s) => s.name)).toEqual(['csrf', 'signin', 'read', 'save']);
    expect(fake.log.length).toBe(4);
  });

  it('FR-OPS-01 NFR-AVL-03: fails when sign-in redirects to an error', async () => {
    // A wrong password: 302 to /login?error=CredentialsSignin, as @auth/core answers it.
    const wrong = makeFake();
    const badPassword = await runJourney({ ...journeyArgs(wrong.fetchImpl), password: WRONG_PW });
    expect(badPassword.ok).toBe(false);
    expect(badPassword.steps.at(-1)).toEqual({ name: 'signin', status: 302 });
    expect(badPassword.reason).toBe('signin_error');
    expect(wrong.log.length, 'nothing is requested after a failed sign-in').toBe(2);

    // A missing CSRF token redirects the same way, to .../api/auth/error?error=MissingCSRF.
    const noCsrf = makeFake({ override: { csrf: () => json(200, { csrfToken: 'a-different-token' }) } });
    const result = await runJourney(journeyArgs(noCsrf.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'signin', status: 302 });
  });

  it('FR-OPS-01 NFR-AVL-03: fails when sign-in answers 302 to a clean location but sets no session cookie', async () => {
    const fake = makeFake({ override: { signin: () => redirect('https://synthetic.example.test') } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'signin', status: 302 });
    expect(result.reason).toBe('no_session_cookie');
  });

  it('FR-OPS-01 NFR-AVL-03: sends every chunk of a chunked session cookie on the steps after sign-in', async () => {
    const fake = makeFake({
      sessionCookies: [
        [`${SESSION_COOKIE}.0`, 'chunk-zero-value'],
        [`${SESSION_COOKIE}.1`, 'chunk-one-value'],
      ],
    });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result).toEqual({ ok: true, steps: OK_STEPS });
  });

  it('FR-OPS-01 NFR-AVL-03: does not follow a redirect: a read that is sent to the login page fails as a 302', async () => {
    const fake = makeFake({ override: { read: () => redirect('https://synthetic.example.test/login') } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'read', status: 302 });
    expect(result.reason).toBe('unexpected_status');
  });

  it('FR-OPS-01 NFR-AVL-03: asks for manual redirects and a timeout on every request', async () => {
    const fake = makeFake();
    await runJourney(journeyArgs(fake.fetchImpl));
    expect(fake.log).toHaveLength(6);
    for (const req of fake.log) {
      expect(req.redirect, `${req.method} ${req.path}`).toBe('manual');
      expect(req.signal, `${req.method} ${req.path} has no abort signal`).toBeInstanceOf(AbortSignal);
      expect(req.headers.get('user-agent'), 'a named client, so a Cloudflare rule can allow it').toMatch(/^makrai-synthetic-monitor\//);
    }
  });

  it('FR-OPS-01 NFR-AVL-03: fails the step, with status 0, when there is no response at all', async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed for ${FAKE_PW}`);
    }) as unknown as typeof fetch;
    const result = await runJourney(journeyArgs(fetchImpl));
    expect(result).toEqual({ ok: false, steps: [{ name: 'csrf', status: 0 }], reason: 'no_response' });
    // The error text can carry anything, so none of it is returned.
    expect(JSON.stringify(result)).not.toContain(FAKE_PW);
  });

  it('FR-OPS-01 NFR-AVL-03: fails when the csrf step does not answer 200, or answers without a token', async () => {
    const down = makeFake({ override: { csrf: () => json(503, {}) } });
    expect(await runJourney(journeyArgs(down.fetchImpl))).toEqual({
      ok: false,
      steps: [{ name: 'csrf', status: 503 }],
      reason: 'unexpected_status',
    });

    const noToken = makeFake({ override: { csrf: () => json(200, {}) } });
    expect(await runJourney(journeyArgs(noToken.fetchImpl))).toEqual({
      ok: false,
      steps: [{ name: 'csrf', status: 200 }],
      reason: 'no_csrf_token',
    });
  });

  it('FR-OPS-01 NFR-AVL-03: keeps the org slug, project id and question id inside their path segments', async () => {
    const fake = makeFake();
    await runJourney({ ...journeyArgs(fake.fetchImpl), orgSlug: 'a/../b?x=1', projectId: 'id#frag/ment', questionId: 'q/../x', stage: 'pre processing&x=1' });
    const read = fake.log.find((r) => r.method === 'GET' && r.path.startsWith('/api/v1/'));
    expect(read?.path).toBe('/api/v1/orgs/a%2F..%2Fb%3Fx%3D1/projects/id%23frag%2Fment/questions/q%2F..%2Fx/decision?stage=pre%20processing%26x%3D1');
  });

  it('FR-OPS-01 NFR-AVL-03: refuses to send credentials over plain http to a host that is not local, and sends nothing', async () => {
    const fake = makeFake();
    await expect(runJourney({ ...journeyArgs(fake.fetchImpl), baseUrl: 'http://makrai.org' })).rejects.toThrow(/https/);
    expect(fake.log).toEqual([]);
    // Local development hosts are allowed over http, as the CLI tests below rely on.
    const local = makeFake();
    await expect(runJourney({ ...journeyArgs(local.fetchImpl), baseUrl: 'http://127.0.0.1:3000' })).resolves.toBeDefined();
  });

  it('FR-OPS-01 NFR-AVL-03: refuses an empty email, password, org slug, project id, stage or question id, and sends nothing', async () => {
    for (const name of ['email', 'password', 'orgSlug', 'projectId', 'stage', 'questionId'] as const) {
      const fake = makeFake();
      await expect(runJourney({ ...journeyArgs(fake.fetchImpl), [name]: '' })).rejects.toThrow(new RegExp(name));
      expect(fake.log, name).toEqual([]);
    }
  });

  it('FR-OPS-01 NFR-AVL-03: writes nothing to stdout, stderr or the console, whatever happens', async () => {
    // process.stdout.write and process.stderr.write are patched, and so are the console methods: the vitest worker
    // routes console.* through its own reporter, so patching the streams alone would not see a console.log.
    const written: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    process.stdout.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await runJourney(journeyArgs(makeFake().fetchImpl));
      await runJourney(journeyArgs(makeFake({ override: { save: () => json(500, { x: BODY_MARKER }) } }).fetchImpl));
      await runJourney(journeyArgs(makeFake({ override: { signin: () => redirect('/login?error=CredentialsSignin') } }).fetchImpl));
      await runJourney(journeyArgs((async () => { throw new TypeError(FAKE_PW); }) as unknown as typeof fetch));
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    const calls = consoleSpies.flatMap((spy) => spy.mock.calls);
    consoleSpies.forEach((spy) => spy.mockRestore());
    expect(calls, 'console calls').toEqual([]);
    expect(written).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The command line, run as a child process against a local server that answers like the stand-in.

interface Cli {
  code: number | null;
  stdout: string;
  stderr: string;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function serve(options: FakeOptions = {}): Promise<{ baseUrl: string }> {
  // The stand-in builds its redirects from an origin, so it needs the port before it answers.
  let fake = makeFake(options);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const out = fake.handle({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(out.status, out.headers.flat());
      res.end(out.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = makeFake({ ...options, origin: baseUrl });
  return { baseUrl };
}

function runCli(env: Record<string, string | undefined>, nodeArgs: string[] = []): Promise<Cli> {
  return new Promise((resolve, reject) => {
    // Only what the command is given: none of the parent's environment, so no real secret can be in it.
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    const child = spawn(process.execPath, [...nodeArgs, SCRIPT], { env: clean as NodeJS.ProcessEnv, cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const cliEnv = (baseUrl: string): Record<string, string> => ({
  BASE_URL: baseUrl,
  SYNTHETIC_EMAIL: EMAIL,
  SYNTHETIC_PASSWORD: FAKE_PW,
  SYNTHETIC_ORG_SLUG: SLUG,
  SYNTHETIC_PROJECT_ID: PROJECT_ID,
  SYNTHETIC_STAGE: STAGE,
  SYNTHETIC_QUESTION_ID: QUESTION_ID,
});

describe('the synthetic-journey command', () => {
  it('FR-OPS-01: prints step=<name> status=<code> per step and nothing else, and exits 0 when the journey passes', async () => {
    const { baseUrl } = await serve();
    const cli = await runCli(cliEnv(baseUrl));
    expect(cli.stdout.trimEnd().split('\n')).toEqual([
      'step=csrf status=200',
      'step=signin status=302',
      'step=read status=200',
      'step=save status=201',
      'step=readback status=200',
      'step=replay status=200',
    ]);
    expect(cli.stderr).toBe('');
    expect(cli.code).toBe(0);
  });

  it('FR-OPS-01 NFR-AVL-03: exits 1 at the first failure, and the last line names the failing step', async () => {
    const { baseUrl } = await serve({ override: { save: () => json(500, { echoed: BODY_MARKER }) } });
    const cli = await runCli(cliEnv(baseUrl));
    expect(cli.code).toBe(1);
    const lines = cli.stdout.trimEnd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['step=csrf status=200', 'step=signin status=302', 'step=read status=200']);
    expect(lines.at(-1)).toBe('step=save status=500 reason=unexpected_status');
    expect(lines.some((l) => l.startsWith('step=readback')), 'nothing runs after the failure').toBe(false);
  });

  it('FR-OPS-01 NFR-AVL-03: never writes the password or a cookie to stdout, or a body, on a passing run or a failing one', async () => {
    const outputs: string[] = [];

    // A passing run.
    outputs.push(text(await runCliPair(await serve())));
    // A save that fails with a body that echoes the password and both cookies back, as a careless server might.
    const echo = {
      echoed: BODY_MARKER,
      password: FAKE_PW,
      cookie: `${CSRF_COOKIE}=${CSRF_COOKIE_VALUE}; ${SESSION_COOKIE}=${SESSION_COOKIE_VALUE}`,
    };
    outputs.push(text(await runCliPair(await serve({ override: { save: () => json(500, echo) } }))));
    // A sign-in that fails, and a read-back that differs.
    outputs.push(text(await runCliPair(await serve({ override: { signin: () => redirect(`/login?error=CredentialsSignin&p=${FAKE_PW}`) } }))));
    outputs.push(
      text(
        await runCliPair(
          await serve({
            override: {
              readback: (_r, normal) => {
                const res = normal();
                const body = JSON.parse(res.body);
                body.current.id = 'dv-other';
                return { ...res, body: JSON.stringify(body) };
              },
            },
          }),
        ),
      ),
    );

    const all = outputs.join('\n');
    // Not vacuous: the runs did print their step lines.
    expect(all).toContain('step=csrf status=200');
    expect(all).toContain('step=save status=500');
    expect(all).toContain('step=signin status=302');
    expect(all).toContain('step=readback status=200');
    for (const secret of SECRET_MARKERS) {
      expect(all, `output contains ${secret.slice(0, 12)}...`).not.toContain(secret);
    }
    expect(all.toLowerCase()).not.toContain('set-cookie');
  });

  it('FR-OPS-01: exits 1 and names each missing variable, SYNTHETIC_QUESTION_ID included, without a request, when its configuration is incomplete', async () => {
    const { baseUrl } = await serve();
    const env = cliEnv(baseUrl);
    const cli = await runCli({ ...env, SYNTHETIC_PASSWORD: '', SYNTHETIC_QUESTION_ID: undefined });
    expect(cli.code).toBe(1);
    expect(cli.stdout).toBe('');
    expect(cli.stderr).toContain('SYNTHETIC_PASSWORD');
    expect(cli.stderr).toContain('SYNTHETIC_QUESTION_ID');
    expect(cli.stderr).not.toContain(FAKE_PW);
    expect(cli.stderr).not.toContain(EMAIL);
  });

  it('FR-OPS-01 NFR-AVL-03: prints only the class of an error it did not expect, because its message could hold a secret', async () => {
    // Stands in for a bug in the script: an internal call throws an error whose message is the password.
    const preload = 'data:text/javascript,Headers.prototype.getSetCookie=()=>{throw new Error(process.env.SYNTHETIC_PASSWORD)}';
    const { baseUrl } = await serve();
    const cli = await runCli(cliEnv(baseUrl), ['--import', preload]);
    expect(cli.code).toBe(1);
    expect(cli.stderr.trimEnd()).toBe('unexpected error: Error');
    expect(cli.stdout + cli.stderr).not.toContain(FAKE_PW);
  });

  it('FR-OPS-01 NFR-AVL-03: exits 1 without printing a stack, or any secret, when the base URL refuses the connection', async () => {
    const cli = await runCli(cliEnv('http://127.0.0.1:1'));
    expect(cli.code).toBe(1);
    expect(cli.stdout.trimEnd()).toBe('step=csrf status=0 reason=no_response');
    for (const secret of SECRET_MARKERS) {
      expect(cli.stdout + cli.stderr).not.toContain(secret);
    }
    expect(cli.stderr).not.toMatch(/\n\s+at /);
  });
});

async function runCliPair(server: { baseUrl: string }): Promise<Cli> {
  return runCli(cliEnv(server.baseUrl));
}

const text = (cli: Cli): string => `${cli.stdout}\n${cli.stderr}`;
