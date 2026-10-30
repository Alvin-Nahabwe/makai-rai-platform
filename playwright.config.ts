import { defineConfig, devices } from '@playwright/test';
import { e2eBaseURL, e2ePort } from './e2e/helpers/port';

// Outside CI an unset E2E_PORT throws here, at config load, so a run can never
// attach to a server that belongs to another builder (00-master.md E2). With
// CI set it is 3000, as before.
const port = e2ePort(process.env);

// E2E_BROWSER_CHANNEL=chrome runs the system Chrome, because Playwright's own
// Chromium build is not in the local cache (00-master.md E2). Unset, as in CI,
// no channel is added and both projects use Playwright's own build as before.
// It applies to `setup` as well as `chromium`: the setup project signs the
// fixture's users in through a browser too.
const channel = process.env.E2E_BROWSER_CHANNEL
  ? { channel: process.env.E2E_BROWSER_CHANNEL }
  : {};

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
    baseURL: e2eBaseURL(process.env),
    trace: 'on-first-retry',
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
    // so no idle `sh` stays between Playwright and the server.
    command: `sh -c 'mkdir -p test-results && exec npm run ${process.env.CI ? 'start' : 'dev'} -- -p ${port} >> test-results/server.log 2>&1'`,
    url: e2eBaseURL(process.env),
    reuseExistingServer: !process.env.CI,
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
    env: { RESEND_API_KEY: '' },
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
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...channel } },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...channel },
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['setup'],
    },
  ],
});
