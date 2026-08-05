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
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
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
