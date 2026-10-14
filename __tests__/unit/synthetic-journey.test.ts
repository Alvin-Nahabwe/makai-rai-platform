import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { runJourney } from '../../scripts/synthetic-journey.mjs';

/**
 * Task 20 (RL 2.3): the hourly synthetic sign-in, save and read-back against production.
 *
 * `runJourney` signs in the way a browser does, saves an assessment the way the autosave
 * does, and reads it back. These tests run it against a stand-in for NextAuth and the
 * assessment route. The stand-in enforces the contract the real endpoints enforce, as read
 * from @auth/core 0.41.3 (lib/index.js, lib/actions/callback/index.js, lib/actions/callback/oauth/csrf-token.js)
 * and from app/api/v1/orgs/[slug]/assessments/[id]/route.ts:
 *
 *   - GET  /api/auth/csrf answers {csrfToken} and sets a csrf cookie holding `token|hash`;
 *   - POST /api/auth/callback/credentials needs that cookie AND the same token in the form
 *     body, else it redirects to .../api/auth/error?error=MissingCSRF;
 *   - a wrong password redirects to /login?error=CredentialsSignin&code=credentials, with no
 *     session cookie; success redirects with a session cookie (HTTP 302 either way);
 *   - GET and PATCH on the assessment answer 401 without the session cookie.
 *
 * So the happy-path test passes only if the client really sends the cookie, the token and
 * the credentials, and really sends the session cookie back on every later step.
 *
 * What no test here can prove is that production's real NextAuth behaves as the stand-in
 * does. The first run of the workflow against makrai.org is that proof (Task 20 step 5).
 */

const REPO_ROOT = join(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/synthetic-journey.mjs');

// Values that must never reach stdout or stderr. Each is distinctive, so a leak is a plain substring hit.
const EMAIL = 'synthetic-monitor@example.invalid';
const FAKE_PW = 'PW-MARKER-Zk3-never-print-me';
const WRONG_PW = 'a-different-pw-value';
const SLUG = 'zz-synthetic-monitoring';
const ASSESSMENT_ID = '5b0f4c1e-1d2a-4f6e-9a77-0c0ffee00001';
const CSRF_FORM_VALUE = 'csrf-token-a1b2c3';
const CSRF_COOKIE = '__Host-authjs.csrf-token';
const CSRF_COOKIE_VALUE = `${CSRF_FORM_VALUE}%7Ccsrf-hash-COOKIE-MARKER-9f8e`;
const SESSION_COOKIE = '__Secure-authjs.session-token';
const SESSION_COOKIE_VALUE = 'SESSION-COOKIE-MARKER-eyJhbGciOiJkaXIi';
const BODY_MARKER = 'BODY-MARKER-private-project-name';

const SECRET_MARKERS = [FAKE_PW, CSRF_COOKIE_VALUE, CSRF_FORM_VALUE, SESSION_COOKIE_VALUE, BODY_MARKER, EMAIL];

const ENGINE_STATE = {
  stages: {
    'pre-processing': { status: 'in_progress', responses: { q1: 'yes', q2: null, q3: [1, 2.5, 3] } },
    'in-processing': { status: 'not_started', responses: {} },
    'post-processing': { status: 'not_started', responses: {} },
  },
  note: 'café ✓',
  nested: { a: { b: [true, false, { c: 0 }] } },
};

const ASSESSMENT_PATH = `/api/v1/orgs/${SLUG}/assessments/${ASSESSMENT_ID}`;

type StepName = 'csrf' | 'signin' | 'read' | 'save' | 'readback';

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
}

const json = (status: number, value: unknown, extra: [string, string][] = []): FakeRes => ({
  status,
  headers: [['content-type', 'application/json'], ...extra],
  body: JSON.stringify(value),
});
const redirect = (location: string, extra: [string, string][] = []): FakeRes => ({
  status: 302,
  headers: [['location', location], ...extra],
  body: '',
});

/** A stand-in for NextAuth plus the assessment route, as pure request -> response logic. */
function makeFake(options: FakeOptions = {}) {
  const origin = options.origin ?? 'https://synthetic.example.test';
  const sessionCookies = options.sessionCookies ?? [[SESSION_COOKIE, SESSION_COOKIE_VALUE]];
  const stored = { engineState: structuredClone(ENGINE_STATE) as unknown };
  const log: FakeReq[] = [];
  let assessmentGets = 0;

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
        if (req.path !== ASSESSMENT_PATH) return json(404, { error: 'Not found' });
        if (!hasSession(req)) return unauthorized();
        return json(200, {
          id: ASSESSMENT_ID,
          status: 'in_progress',
          overallScore: 41,
          project: { name: BODY_MARKER },
          engineState: stored.engineState,
        });
      case 'save': {
        if (req.path !== ASSESSMENT_PATH) return json(404, { error: 'Not found' });
        if (!hasSession(req)) return unauthorized();
        if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json(400, { error: 'bad type' });
        const body = JSON.parse(req.body) as { engineState?: unknown };
        if (body.engineState === undefined) return json(400, { error: 'A valid engineState is required' });
        stored.engineState = body.engineState;
        return json(200, { id: ASSESSMENT_ID, engineState: stored.engineState });
      }
    }
  };

  const classify = (req: FakeReq): StepName => {
    if (req.path === '/api/auth/csrf') return 'csrf';
    if (req.path === '/api/auth/callback/credentials') return 'signin';
    if (req.method === 'PATCH') return 'save';
    return assessmentGets++ === 0 ? 'read' : 'readback';
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
  assessmentId: ASSESSMENT_ID,
  fetchImpl,
});

const OK_STEPS = [
  { name: 'csrf', status: 200 },
  { name: 'signin', status: 302 },
  { name: 'read', status: 200 },
  { name: 'save', status: 200 },
  { name: 'readback', status: 200 },
];

describe('runJourney', () => {
  it('passes when every step returns its expected status', async () => {
    const fake = makeFake();
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result).toEqual({ ok: true, steps: OK_STEPS });
    // The journey saved the state it read, unchanged: it writes nothing of its own.
    expect(fake.stored.engineState).toEqual(ENGINE_STATE);
  });

  it('fails and names the step when the save returns 500', async () => {
    const fake = makeFake({ override: { save: () => json(500, { echoed: BODY_MARKER, password: FAKE_PW }) } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'save', status: 500 });
    expect(result.reason).toBe('unexpected_status');
    // It stops at the first failure: nothing is read back after a failed save.
    expect(result.steps.map((s) => s.name)).toEqual(['csrf', 'signin', 'read', 'save']);
    expect(fake.log.length).toBe(4);
  });

  it('fails when sign-in redirects to an error', async () => {
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

  it('fails when the read-back differs from what was saved', async () => {
    const fake = makeFake({
      override: {
        readback: (_req, normal) => {
          const res = normal();
          const body = JSON.parse(res.body);
          body.engineState.stages['pre-processing'].responses.q1 = 'no';
          return { ...res, body: JSON.stringify(body) };
        },
      },
    });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'readback', status: 200 });
    expect(result.reason).toBe('readback_differs');
    expect(result.steps).toHaveLength(5);
  });

  it('does not mistake the order of keys for a difference, because Postgres JSONB does not keep it', async () => {
    const fake = makeFake({
      override: {
        readback: (_req, normal) => {
          const res = normal();
          const body = JSON.parse(res.body);
          const reorder = (v: unknown): unknown =>
            Array.isArray(v)
              ? v.map(reorder)
              : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)]))
                : v;
          body.engineState = reorder(body.engineState);
          return { ...res, body: JSON.stringify(body) };
        },
      },
    });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result).toEqual({ ok: true, steps: OK_STEPS });
  });

  it('fails when sign-in answers 302 to a clean location but sets no session cookie', async () => {
    const fake = makeFake({ override: { signin: () => redirect('https://synthetic.example.test') } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'signin', status: 302 });
    expect(result.reason).toBe('no_session_cookie');
  });

  it('sends every chunk of a chunked session cookie on the steps after sign-in', async () => {
    const fake = makeFake({
      sessionCookies: [
        [`${SESSION_COOKIE}.0`, 'chunk-zero-value'],
        [`${SESSION_COOKIE}.1`, 'chunk-one-value'],
      ],
    });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result).toEqual({ ok: true, steps: OK_STEPS });
  });

  it('does not follow a redirect: a read that is sent to the login page fails as a 302', async () => {
    const fake = makeFake({ override: { read: () => redirect('https://synthetic.example.test/login') } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'read', status: 302 });
    expect(result.reason).toBe('unexpected_status');
  });

  it('asks for manual redirects and a timeout on every request', async () => {
    const fake = makeFake();
    await runJourney(journeyArgs(fake.fetchImpl));
    expect(fake.log).toHaveLength(5);
    for (const req of fake.log) {
      expect(req.redirect, `${req.method} ${req.path}`).toBe('manual');
      expect(req.signal, `${req.method} ${req.path} has no abort signal`).toBeInstanceOf(AbortSignal);
      expect(req.headers.get('user-agent'), 'a named client, so a Cloudflare rule can allow it').toMatch(/^makrai-synthetic-monitor\//);
    }
  });

  it('fails the step, with status 0, when there is no response at all', async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed for ${FAKE_PW}`);
    }) as unknown as typeof fetch;
    const result = await runJourney(journeyArgs(fetchImpl));
    expect(result).toEqual({ ok: false, steps: [{ name: 'csrf', status: 0 }], reason: 'no_response' });
    // The error text can carry anything, so none of it is returned.
    expect(JSON.stringify(result)).not.toContain(FAKE_PW);
  });

  it('fails when the csrf step does not answer 200, or answers without a token', async () => {
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

  it('fails when the read returns no engineState, so there is nothing to save', async () => {
    const fake = makeFake({ override: { read: () => json(200, { id: ASSESSMENT_ID }) } });
    const result = await runJourney(journeyArgs(fake.fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toEqual({ name: 'read', status: 200 });
    expect(result.reason).toBe('no_engine_state');
    expect(fake.log.some((r) => r.method === 'PATCH'), 'must not save when the read gave nothing').toBe(false);
  });

  it('keeps the org slug and the assessment id inside their path segments', async () => {
    const fake = makeFake();
    await runJourney({ ...journeyArgs(fake.fetchImpl), orgSlug: 'a/../b?x=1', assessmentId: 'id#frag/ment' });
    const read = fake.log.find((r) => r.method === 'GET' && r.path.startsWith('/api/v1/'));
    expect(read?.path).toBe('/api/v1/orgs/a%2F..%2Fb%3Fx%3D1/assessments/id%23frag%2Fment');
  });

  it('refuses to send credentials over plain http to a host that is not local, and sends nothing', async () => {
    const fake = makeFake();
    await expect(runJourney({ ...journeyArgs(fake.fetchImpl), baseUrl: 'http://makrai.org' })).rejects.toThrow(/https/);
    expect(fake.log).toEqual([]);
    // Local development hosts are allowed over http, as the CLI tests below rely on.
    const local = makeFake();
    await expect(runJourney({ ...journeyArgs(local.fetchImpl), baseUrl: 'http://127.0.0.1:3000' })).resolves.toBeDefined();
  });

  it('refuses an empty email, password, org slug or assessment id, and sends nothing', async () => {
    for (const name of ['email', 'password', 'orgSlug', 'assessmentId'] as const) {
      const fake = makeFake();
      await expect(runJourney({ ...journeyArgs(fake.fetchImpl), [name]: '' })).rejects.toThrow(new RegExp(name));
      expect(fake.log, name).toEqual([]);
    }
  });

  it('writes nothing to stdout, stderr or the console, whatever happens', async () => {
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
  SYNTHETIC_ASSESSMENT_ID: ASSESSMENT_ID,
});

describe('the synthetic-journey command', () => {
  it('prints step=<name> status=<code> for each step and exits 0 when the journey passes', async () => {
    const { baseUrl } = await serve();
    const cli = await runCli(cliEnv(baseUrl));
    expect(cli.stdout.trimEnd().split('\n')).toEqual([
      'step=csrf status=200',
      'step=signin status=302',
      'step=read status=200',
      'step=save status=200',
      'step=readback status=200',
    ]);
    expect(cli.stderr).toBe('');
    expect(cli.code).toBe(0);
  });

  it('exits 1 at the first failure, and the last line names the failing step', async () => {
    const { baseUrl } = await serve({ override: { save: () => json(500, { echoed: BODY_MARKER }) } });
    const cli = await runCli(cliEnv(baseUrl));
    expect(cli.code).toBe(1);
    const lines = cli.stdout.trimEnd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['step=csrf status=200', 'step=signin status=302', 'step=read status=200']);
    expect(lines.at(-1)).toBe('step=save status=500 reason=unexpected_status');
    expect(lines.some((l) => l.startsWith('step=readback')), 'nothing runs after the failure').toBe(false);
  });

  it('never writes the password or a cookie to stdout, or a body, on a passing run or a failing one', async () => {
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
                body.engineState.note = 'changed';
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

  it('exits 1 and names each missing variable, without a request, when its configuration is incomplete', async () => {
    const { baseUrl } = await serve();
    const env = cliEnv(baseUrl);
    const cli = await runCli({ ...env, SYNTHETIC_PASSWORD: '', SYNTHETIC_ASSESSMENT_ID: undefined });
    expect(cli.code).toBe(1);
    expect(cli.stdout).toBe('');
    expect(cli.stderr).toContain('SYNTHETIC_PASSWORD');
    expect(cli.stderr).toContain('SYNTHETIC_ASSESSMENT_ID');
    expect(cli.stderr).not.toContain(FAKE_PW);
    expect(cli.stderr).not.toContain(EMAIL);
  });

  it('prints only the class of an error it did not expect, because its message could hold a secret', async () => {
    // Stands in for a bug in the script: an internal call throws an error whose message is the password.
    const preload = 'data:text/javascript,Headers.prototype.getSetCookie=()=>{throw new Error(process.env.SYNTHETIC_PASSWORD)}';
    const { baseUrl } = await serve();
    const cli = await runCli(cliEnv(baseUrl), ['--import', preload]);
    expect(cli.code).toBe(1);
    expect(cli.stderr.trimEnd()).toBe('unexpected error: Error');
    expect(cli.stdout + cli.stderr).not.toContain(FAKE_PW);
  });

  it('exits 1 without printing a stack, or any secret, when the base URL refuses the connection', async () => {
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
