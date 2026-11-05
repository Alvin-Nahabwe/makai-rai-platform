import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { e2eBaseURL, e2ePort } from './e2e/helpers/port';

// Outside CI an unset E2E_PORT throws here, at config load, so a run can never
// attach to a server that belongs to another builder (00-master.md E2). With
// CI set it is 3000, as before.
const port = e2ePort(process.env);
const baseURL = e2eBaseURL(process.env);

// E2E_BROWSER_CHANNEL=chrome runs the system Chrome, because Playwright's own
// Chromium build is not in the local cache (00-master.md E2). Unset, as in CI,
// no channel is added and every project uses Playwright's own build as before.
// It sits in the top-level `use` once, so every project takes it from there,
// `setup` included (it signs the fixture's users in through a browser), and no
// project repeats it and drifts from the others.
const channel = process.env.E2E_BROWSER_CHANNEL
  ? { channel: process.env.E2E_BROWSER_CHANNEL }
  : {};

// The content bundle a live server serves: the fixture bundle, never data/content
// (contract "Content bundle", Live servers, finding F11). lib/content/root.ts
// accepts it only because MAKRAI_TEST_SEAMS is exactly 1 and the real path is
// inside this directory.
const FIXTURE_CONTENT_ROOT = path.join(process.cwd(), '__tests__', 'fixtures', 'content');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  // Task 5 (docs/DEFERRED_REGISTER.md D-185's quarantine): verified live that
  // 'html' alone does NOT name a quarantined (`test.fixme`) test in CI
  // stdout -- it prints only an aggregate count ("1 skipped"), with the
  // title/file:line visible solely inside the HTML report artifact, which
  // is uploaded on failure only and never on a green run. 'list' prints the
  // test's title and location for every run (`-  1 <file>:<line> › <title>`
  // for a fixme, confirmed against the same fixture), so a reader scanning
  // raw CI logs -- not downloading an artifact -- can see which test the
  // gate is skipping. This is what makes D-185's "visible, not silent"
  // claim (`ci.yml`'s test-e2e job comment) true of the CI log itself.
  reporter: [['list'], ['html']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    ...channel,
  },
  webServer: {
    // CI serves the production build; local development keeps the dev server.
    // Playwright OWNS this process in both cases -- the CI job must never
    // start its own, or Playwright's own port check throws (verified at
    // node_modules/playwright/lib/runner/index.js:821-827).
    //
    // The server's output goes to test-results/server.log, which the server
    // log checks read. Playwright's `stdout` option only takes 'pipe' or
    // 'ignore' (node_modules/playwright/types/test.d.ts), so the redirect is
    // done by the shell. Playwright deletes test-results/ before it starts the
    // server, so the shell creates it first; `exec` replaces the shell with npm,
    // so no idle `sh` stays between Playwright and the server. One `>`, not
    // `>>`: the file holds this server's lines and no earlier run's, so a log
    // scan cannot be failed or passed by a line from another run.
    command: `sh -c 'mkdir -p test-results && exec npm run ${process.env.CI ? 'start' : 'dev'} -- -p ${port} > test-results/server.log 2>&1'`,
    url: baseURL,
    // Never attach to a server that is already listening. Playwright would
    // otherwise skip `command` for any server answering on the URL, and the run
    // would test that server's code and database, and write no server.log. A
    // taken port now fails with "... is already used" (00-master.md E2).
    reuseExistingServer: false,
    // D-188 (docs/DEFERRED_REGISTER.md). The invite POST this server handles
    // (e2e/two-orgs.spec.ts) used to make a LIVE call to Resend, whose
    // sandbox mode rejects the fixture's synthetic recipient -- 2 of 6
    // full-suite runs failed waiting on that real network round trip.
    // Blanking RESEND_API_KEY makes sendEmail throw locally and instantly,
    // before a Resend client is even constructed (lib/email/send.ts:32-37);
    // the route already tolerates that throw and still returns 201 with
    // acceptUrl (members/route.ts:104-127). Two mechanisms checked directly,
    // not assumed: Playwright spreads this object OVER process.env when it
    // spawns the server (node_modules/playwright/lib/runner/index.js --
    // `env: { ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env,
    // ...this._options.env }`), so DATABASE_URL and everything else still
    // come from process.env; and @next/env's `populate()`
    // (node_modules/@next/env/dist/index.js) only applies a `.env` value
    // when the key is `typeof undefined` in the environment it captured at
    // startup, so this empty string counts as already-defined and the real
    // key in `.env` never overwrites it.
    //
    // The two seam variables point the server at the fixture content bundle
    // (G-17). They are set here, in the process Playwright starts, and nowhere
    // that builds or deploys the image (__tests__/lint/test-seams.test.ts).
    //
    env: { RESEND_API_KEY: '', MAKRAI_TEST_SEAMS: '1', MAKRAI_CONTENT_ROOT: FIXTURE_CONTENT_ROOT },
  },
  /**
   * Task 10: `setup` builds the shared 20-user fixture and saves one
   * `storageState` per user ONCE (e2e/fixtures/auth.setup.ts), then every
   * other project depends on it having already run. Existing specs
   * (auth.spec.ts, org-routing.spec.ts, project.spec.ts, security.spec.ts)
   * register their own throwaway users and start with NO storageState — the
   * `chromium` project below sets none at the project level, deliberately,
   * so `security.spec.ts`'s "unauthenticated access redirects to login"
   * assertions keep starting from a clean, logged-out context. A future
   * spec that wants a specific fixture seat reads its `storageStatePath`
   * from `e2e/fixtures/.auth/manifest.json` and passes it explicitly via
   * `test.use({ storageState })`.
   */
  projects: [
    // `content` publishes the two fixture framework_versions rows into the
    // database the server uses, so a live save does not answer 503
    // content_not_published (K-2). `setup` waits for it.
    { name: 'content', testMatch: /content\.setup\.ts/ },
    { name: 'setup', testMatch: /auth\.setup\.ts/, dependencies: ['content'] },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /(auth|content)\.setup\.ts|db-outage\.spec\.ts/,
      dependencies: ['setup'],
    },
    // The database outage test stops and starts the Postgres container (E2E_DB_CONTAINER), so no other project
    // collects it and it must not overlap another: it waits for `chromium` as well as `setup`, because projects
    // with no dependency between them run at the same time. CI runs it after the suite as its own step, where the
    // fixture and the suite are already done: `npx playwright test --project=outage --no-deps`. Locally,
    // `--project=outage` alone runs the browser project first; add --no-deps once the fixture is on disk.
    {
      name: 'outage',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /db-outage\.spec\.ts/,
      dependencies: ['setup', 'chromium'],
    },
  ],
});
