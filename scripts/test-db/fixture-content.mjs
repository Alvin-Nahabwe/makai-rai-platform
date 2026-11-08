#!/usr/bin/env node
// Publishes the two fixture content versions into the database a live test server uses.
//
//   MAKRAI_TEST_SEAMS=1 DATABASE_URL=postgresql://...@localhost:<port>/makrai_test \
//     node scripts/test-db/fixture-content.mjs
//
// A live server (`next dev`, `next start` under Playwright) cannot use vitest's mock or `useFixtureContent`,
// so it serves the fixture bundle through the content seam (lib/content/root.ts) and needs the matching
// `framework_versions` rows, or a save answers 503 content_not_published (K-2). This upserts exactly two rows,
// ids `fv_fixture_0_0_1` and `fv_fixture_0_0_2`, with the hash of their files, published; it changes nothing
// else, and running it twice changes nothing more.
//
// It writes to a database, so it refuses (exit 1, naming the reason, before it opens a connection) unless
//   - MAKRAI_TEST_SEAMS is exactly 1, and
//   - the host of DATABASE_URL, as parsed, is exactly localhost or 127.0.0.1, and the URL names no other host
//     in its query string.
// The connection is made from the parsed parts, never from the URL string, so nothing in the query string can
// redirect it. No message repeats the URL or the password. (Contract "Content bundle", Live servers, finding
// R2-18; NFR-SEC-17; H-S3.)

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures', 'content');
const ROWS = [
  { id: 'fv_fixture_0_0_1', semver: '0.0.1-fixture' },
  { id: 'fv_fixture_0_0_2', semver: '0.0.2-fixture' },
];
const PUBLISHED_AT = '2026-10-30T00:00:00Z';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const HOST_OVERRIDES = ['host', 'hostaddr', 'service'];

function refuse(reason) {
  process.stderr.write(`fixture-content: refused: ${reason}\n`);
  process.exit(1);
}

/** The connection settings of DATABASE_URL, or a refusal. Nothing about the URL but the host is ever printed. */
function localConnection(databaseUrl) {
  if (!databaseUrl) refuse('DATABASE_URL is not set');
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    refuse('DATABASE_URL is not a URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') refuse('DATABASE_URL is not a postgresql URL');
  if (!LOCAL_HOSTS.has(url.hostname)) refuse(`only localhost or 127.0.0.1 may be written, not "${url.hostname}"`);
  for (const name of HOST_OVERRIDES) {
    if (url.searchParams.has(name)) refuse(`DATABASE_URL names another host in its query string (${name})`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (database === '') refuse('DATABASE_URL names no database');
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

if (process.env.MAKRAI_TEST_SEAMS !== '1') refuse('set MAKRAI_TEST_SEAMS=1 (test databases only)');
const connection = localConnection(process.env.DATABASE_URL);

// Loaded only now, so a refusal never depends on it: Node strips the types of this TypeScript module itself.
const { computeVersionBundleHash } = await import('../../lib/content/bundleHash.ts');

const client = new pg.Client(connection);
try {
  await client.connect();
  await client.query('BEGIN');
  for (const { id, semver } of ROWS) {
    const contentHash = computeVersionBundleHash(join(FIXTURE_ROOT, semver));
    await client.query(
      `INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt", "status")
       VALUES ($1, $2, $3, $4, 'published')
       ON CONFLICT ("id") DO UPDATE
         SET "semver" = EXCLUDED."semver", "contentHash" = EXCLUDED."contentHash", "status" = 'published'`,
      [id, semver, contentHash, PUBLISHED_AT],
    );
  }
  await client.query('COMMIT');
  process.stdout.write(`fixture-content: published ${ROWS.map((r) => r.id).join(', ')}\n`);
} catch (e) {
  // The reason only: a pg error can carry the address, and the password must not leave this process.
  process.stderr.write(`fixture-content: failed: ${e?.code ?? e?.name ?? 'error'}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
