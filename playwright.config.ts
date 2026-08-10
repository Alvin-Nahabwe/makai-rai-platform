import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    // CI serves the production build; local development keeps the dev server.
    // Playwright OWNS this process in both cases -- the CI job must never
    // start its own, or Playwright's own port check throws (verified at
    // node_modules/playwright/lib/runner/index.js:821-827).
    command: process.env.CI ? 'npm run start' : 'npm run dev',
    url: 'http://localhost:3000',
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
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['setup'],
    },
  ],
});
