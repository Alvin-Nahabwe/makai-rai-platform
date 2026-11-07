import 'dotenv/config';
import { execFileSync } from 'node:child_process';
// The loopback guard: playwright.perf-nginx.config.ts (baseURL https://makrai.org) runs this file too.
import { test as setup } from '../helpers/loopbackOnly';

/**
 * The `content` project (playwright.config.ts) runs before `setup`. The web server Playwright starts serves the
 * fixture content bundle through the content seam (MAKRAI_TEST_SEAMS and MAKRAI_CONTENT_ROOT in its `env`), and a
 * save pins the running version's `framework_versions` row, so the two fixture rows must exist in the database
 * the server uses or a live save answers 503 content_not_published (K-2).
 *
 * `scripts/test-db/fixture-content.mjs` upserts exactly those two rows into DATABASE_URL, which `dotenv/config`
 * has loaded from `.env` (the same file the server reads). It refuses unless MAKRAI_TEST_SEAMS is 1 and the host
 * is localhost or 127.0.0.1; the flag is set here in the child's environment only, not in this process's. The
 * script's own output is printed, and a non-zero exit fails this test with it. The warning Node prints when it
 * loads the TypeScript module the script imports (package.json has no "type") is turned off for this one child.
 */
setup('publish the fixture content versions the live server serves', () => {
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/test-db/fixture-content.mjs'], {
    env: { ...process.env, MAKRAI_TEST_SEAMS: '1' },
    stdio: 'inherit',
  });
});
