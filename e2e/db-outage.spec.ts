import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { draftKey } from '../lib/client/drafts';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoMarkersOrEmails, startServerLogCapture } from './helpers/logs';

/**
 * NFR-AVL-04 (fault harness, SRS line 3254) and NFR-OBS-05. With the database stopped, a page shows the support
 * reference, a write answers 503 with one, the server log holds one line for each reference, and what the person
 * typed stays on their device. Then the database starts again and the same pages load.
 *
 * It stops and starts the Postgres container named by E2E_DB_CONTAINER (the slot's `v060-pg-bK`; CI sets it from
 * `docker ps -q --filter ancestor=postgres:16-alpine`), so it runs alone as the Playwright project `outage`. The
 * restart is in a `finally`: a failed run must not leave the slot's database stopped. Without the variable the
 * file is skipped, with the reason printed.
 */
const CONTAINER = process.env.E2E_DB_CONTAINER ?? '';
test.skip(CONTAINER === '', 'E2E_DB_CONTAINER is not set: name the Postgres container of this run (the slot\'s v060-pg-bK) to run the database outage test');
// The name goes to the docker CLI as an argument: a container name or an id, never an option.
if (CONTAINER !== '' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(CONTAINER)) throw new Error('E2E_DB_CONTAINER is not a container name or id');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const psqlAt = (sql: string): string[] =>
  docker('exec', CONTAINER, 'sh', '-c', 'psql -U "${POSTGRES_USER:-makrai}" -d postgres -Atc "$1"', 'psql', sql)
    .split('\n')
    .filter(Boolean);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilAccepting(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', CONTAINER, 'sh', '-c', 'pg_isready -U "${POSTGRES_USER:-makrai}" -q');
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('the database did not accept connections within 60 seconds of docker start');
}

test('NFR-AVL-04 NFR-OBS-05: with the database stopped, pages show the reference, writes answer 503 and drafts stay', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
  const org = manifest.orgs[0];
  const owner = manifest.users.find((u) => u.orgSlug === org.slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error('the fixture manifest has no owner seat for the first organisation');
  const dashboard = `/orgs/${owner.orgSlug}/dashboard`;
  const origin = new URL(baseURL as string).origin;

  const context = await browser.newContext({ storageState: owner.storageStatePath });
  const page = await context.newPage();
  await page.goto(dashboard);
  await expect(page.getByText('Support reference:')).toHaveCount(0);
  await expect(page.getByRole('main')).toBeVisible();

  // One draft, kept on this device under the account's own key.
  const key = draftKey({ userId: owner.userId, orgId: org.id, projectId: 'outage-probe', target: { kind: 'question', questionId: 'Q-PP-01' } });
  const draft = JSON.stringify({ baseVersionNumber: null, value: { reason: 'typed before the outage' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, draft]);

  const before = { databases: psqlAt(`SELECT datname FROM pg_database WHERE datname IN ('makrai', 'makrai_test') ORDER BY 1`), roles: psqlAt(`SELECT rolname FROM pg_roles WHERE rolname IN ('makrai_app', 'makrai_identity') ORDER BY 1`) };

  const capture = startServerLogCapture();
  let lines: string[] = [];
  let pageReference = '';
  let writeBody: { error?: string; code?: string; reference?: string } = {};
  let writeStatus = 0;
  try {
    docker('stop', CONTAINER);

    // A page: the error page, with the reference of the server's own log line.
    await page.goto(dashboard);
    const shown = page.getByText(/^Support reference: \S+$/);
    await expect(shown).toBeVisible({ timeout: 60_000 });
    pageReference = ((await shown.textContent()) ?? '').replace('Support reference: ', '').trim();
    await expect(page.getByRole('heading', { name: 'This page could not be loaded' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // No error text on the page. `next dev` forwards the error's message to the browser in its page data, for debugging
    // (Next 16, error.md: "During development ... include the `message` of the original error"), so the whole document
    // is held to this only on the production build CI serves; what a person sees is held to it everywhere.
    expect(await page.locator('main').innerText()).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|localhost|Prisma|database server/i);
    if (process.env.CI) expect(await page.content()).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|database server/i);

    // A write, same origin: 503 with a reference and the fixed body.
    const res = await context.request.patch(`/api/v1/orgs/${owner.orgSlug}/projects/outage-probe`, { headers: { origin }, data: { name: 'Outage probe' } });
    writeStatus = res.status();
    writeBody = await res.json();
    console.log(`503 body: ${JSON.stringify(writeBody)}`);

    // What the person typed is still on the device while the server is down.
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).not.toBeNull();
  } finally {
    // The database starts again whatever happened above, and a log that cannot be read fails the test here.
    try {
      lines = await capture.stop();
    } finally {
      docker('start', CONTAINER);
      await waitUntilAccepting();
    }
  }

  expect(writeStatus).toBe(503);
  expect(writeBody).toMatchObject({ error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
  expect(Object.keys(writeBody).sort()).toEqual(['code', 'error', 'reference']);

  // The write's reference is in exactly one log line, with the fixed name of what failed and no host or port.
  const writeLines = lines.filter((l) => l.includes(writeBody.reference as string));
  expect(writeLines).toHaveLength(1);
  console.log(`503 log line: ${writeLines[0]}`);
  const logged = JSON.parse(writeLines[0]);
  expect(Object.keys(logged).sort()).toEqual(['at', 'cause', 'code', 'event', 'reference', 'status']);
  expect(logged).toMatchObject({ event: 'REQUEST_FAILED', status: 503, code: 'database_unavailable', reference: writeBody.reference });
  // One of the thirteen fixed names, and the one this path produces. The route's first database access is the
  // identity lane's Prisma query, and through @prisma/adapter-pg a refused connection arrives as a
  // PrismaClientKnownRequestError with code P1001 ("Can't reach database server"), not as the raw AggregateError
  // with code ECONNREFUSED that a direct `pg` connection to a host with two addresses gives (R11-21). The brief
  // expected ECONNREFUSED; the slot's line says P1001 (reported, not widened to a list).
  expect(logged.cause).toBe('P1001');
  expect(writeLines[0]).not.toMatch(/\d+\.\d+\.\d+\.\d+|::1|localhost|\b5\d{3}\b/);

  // The page's reference is the digest of the render error; Next prints it once in the server's own output (A-H2).
  const pageLines = lines.filter((l) => l.includes(pageReference));
  console.log(`page reference ${pageReference} appears in ${pageLines.length} log line(s):\n${pageLines.join('\n')}`);
  expect(pageLines).toHaveLength(1);
  expectNoMarkersOrEmails(lines);

  // The database starts again: the same page loads, and the draft is still there.
  await page.goto(dashboard);
  await expect(page.getByText('Support reference:')).toHaveCount(0);
  await expect(page.getByRole('main')).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).not.toBeNull();
  await context.close();

  // The slot survived the stop (a named volume, finding WI-02): its databases and both login roles are still there.
  expect(before.databases).toContain('makrai_test');
  expect(before.roles).toEqual(['makrai_app', 'makrai_identity']);
  expect(psqlAt(`SELECT datname FROM pg_database WHERE datname IN ('makrai', 'makrai_test') ORDER BY 1`)).toEqual(before.databases);
  expect(psqlAt(`SELECT rolname FROM pg_roles WHERE rolname IN ('makrai_app', 'makrai_identity') ORDER BY 1`)).toEqual(before.roles);
});
