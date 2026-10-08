import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * GET /api/health, and the container wiring that depends on it (INFRA-12, D-236).
 *
 * The route is the one thing an uptime monitor and the container's own healthcheck
 * both read, so what it says is deliberately thin: `{"status":"ok"}` or
 * `{"status":"unavailable"}`. No version, no error text, no timing. It is open to the
 * internet by design (the monitor has no credentials), which is why nothing about the
 * database, the host or the build may reach the body.
 *
 * The data client is replaced here; `__tests__/integration/health.test.ts` runs the
 * same route against the real database.
 */

const queryRaw = vi.fn();
const transaction = vi.fn();
/** Set to make touching `appClient.$queryRaw` throw, as the real lazy proxy does with no URL. */
let clientCannotBeBuilt = false;

vi.mock('../../lib/data/tenant', () => ({
  appClient: {
    get $queryRaw() {
      if (clientCannotBeBuilt) throw new Error('APP_DATABASE_URL is not set.');
      return queryRaw;
    },
    $transaction: transaction,
  },
}));

/** What a failing driver puts in its message: a user, a host and a connection string. */
const DRIVER_ERROR =
  'password authentication failed for user "makrai_app" (postgresql://makrai_app:hunter2@db.internal:5432/makrai)';
const LEAKABLE = ['makrai_app', 'hunter2', 'db.internal', 'postgresql://', 'password authentication'];

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  queryRaw.mockReset();
  transaction.mockReset();
  clientCannotBeBuilt = false;
  // The route logs why a check failed; keep that out of the test output.
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  errorLog.mockRestore();
});

describe('GET /api/health', () => {
  it('returns 200 ok when the database answers', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { GET } = await import('../../app/api/health/route');

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    // Exact text, not a parsed object: a field added to the body fails here.
    expect(await res.text()).toBe('{"status":"ok"}');
  });

  it('returns 503 with no error detail when it does not', async () => {
    queryRaw.mockRejectedValue(new Error(DRIVER_ERROR));
    const { GET } = await import('../../app/api/health/route');

    const res = await GET();
    const body = await res.text();

    expect(res.status).toBe(503);
    // First, so a leak is reported as a leak and not as a body mismatch.
    for (const secret of LEAKABLE) expect(body, `the 503 body leaks '${secret}'`).not.toContain(secret);
    expect(body).toBe('{"status":"unavailable"}');
    // The cause is for the operator's journal, never the response.
    expect(errorLog).toHaveBeenCalled();
  });

  it('answers 503 rather than throwing when the client cannot even be built', async () => {
    // appClient is a lazy proxy: with APP_DATABASE_URL unset, the property access itself
    // throws (lib/data/connection.ts#requireDatabaseUrl), before any query is sent.
    clientCannotBeBuilt = true;
    const { GET } = await import('../../app/api/health/route');

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"unavailable"}');
  });

  it.each([
    ['ok', () => queryRaw.mockResolvedValue([{ '?column?': 1 }]), 200],
    ['unavailable', () => queryRaw.mockRejectedValue(new Error(DRIVER_ERROR)), 503],
  ] as const)('is never cached, whether it says %s or not', async (_label, arrange, status) => {
    arrange();
    const route = await import('../../app/api/health/route');

    const res = await route.GET();

    expect(res.status).toBe(status);
    // `no-store` on the response, which is what Cloudflare and browsers obey, and the route
    // itself dynamic. Next 16 already treats a GET handler as dynamic, so the export is a
    // pin: measured, `dynamic = 'force-static'` makes `next build` bake `{"status":"ok"}`
    // into .next/server/app/api/health.body and list the route as static, and a monitor
    // reading that file can never see the database fail.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('asks the database one question and does no auth or org lookup', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { GET } = await import('../../app/api/health/route');

    await GET();

    expect(queryRaw).toHaveBeenCalledTimes(1);
    // withOrg is the tenant path: it opens a transaction. A health check has no org.
    expect(transaction).not.toHaveBeenCalled();
    // And it takes no request, so there is nothing to authenticate.
    expect(GET.length).toBe(0);
  });
});

describe('databaseReachable', () => {
  it('is true when SELECT 1 comes back', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { databaseReachable } = await import('../../lib/data/health');

    await expect(databaseReachable()).resolves.toBe(true);
  });

  it('is false, and does not throw, when the query fails', async () => {
    queryRaw.mockRejectedValue(new Error(DRIVER_ERROR));
    const { databaseReachable } = await import('../../lib/data/health');

    await expect(databaseReachable()).resolves.toBe(false);
  });

  it('is false once the timeout passes, without waiting for a query that never returns', async () => {
    queryRaw.mockReturnValue(new Promise(() => undefined));
    const { databaseReachable } = await import('../../lib/data/health');

    const started = Date.now();
    await expect(databaseReachable(25)).resolves.toBe(false);

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves no timer running once it has answered', async () => {
    vi.useFakeTimers();
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { databaseReachable } = await import('../../lib/data/health');

    await expect(databaseReachable()).resolves.toBe(true);

    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The container half. Read as text, as the neighbouring lint tests read these two files.
 */
describe('the production container', () => {
  const compose = readFileSync('docker/docker-compose.prod.yml', 'utf8');
  const dockerfile = readFileSync('docker/Dockerfile', 'utf8');

  /** A service's text: from its two-space key to the next two-space key or top-level key. */
  function service(name: string): string {
    const lines = compose.split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    if (start === -1) throw new Error(`docker-compose.prod.yml has no service '${name}'`);
    const end = lines.findIndex((l, i) => i > start && /^( {2}[A-Za-z0-9_-]+:|\S)/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  }

  /** The text of one Dockerfile stage, from its FROM line to the next FROM. */
  function stage(name: string): string {
    const lines = dockerfile.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^FROM .* AS ${name}\\s*$`).test(l));
    if (start === -1) throw new Error(`Dockerfile has no stage '${name}'`);
    const end = lines.findIndex((l, i) => i > start && /^FROM /.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  }

  /** The service's `healthcheck:` block: its key line and every deeper-indented line after. */
  function healthcheck(name: string): string {
    const lines = service(name).split('\n');
    const start = lines.findIndex((l) => l === '    healthcheck:');
    if (start === -1) return '';
    const end = lines.findIndex((l, i) => i > start && l.trim() !== '' && !/^ {5,}/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  }

  it('the web service has a healthcheck on /api/health', () => {
    const block = healthcheck('nextjs');
    expect(block, 'the nextjs service has no healthcheck: block').not.toBe('');

    // Run inside the container on loopback, bypassing nginx and Cloudflare, so a failure is
    // the app's and not the edge's. Exit 0 only on a 200: a 503 from the database check, a
    // refused connection and a timeout all fail it.
    expect(block).toContain(
      "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))",
    );
    expect(block).toMatch(/^ {6}interval: 30s$/m);
    expect(block).toMatch(/^ {6}timeout: 5s$/m);
    expect(block).toMatch(/^ {6}retries: 3$/m);
    expect(block).toMatch(/^ {6}start_period: 30s$/m);
  });

  it('the runner listens on all interfaces', () => {
    // D-236: standalone `server.js` binds to $HOSTNAME, and Docker sets HOSTNAME to the
    // container id, so without this 127.0.0.1 inside the container is not listened on and
    // the healthcheck above can never pass. It has to be in the stage that runs.
    expect(stage('runner')).toMatch(/^ENV HOSTNAME=0\.0\.0\.0$/m);
  });
});
