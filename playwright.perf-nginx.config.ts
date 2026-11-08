import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { e2eBaseURL, e2ePort } from './e2e/helpers/port';

/**
 * NFR-PERF-02's first-visit transfer through the production nginx configuration (SRS line 3195; 12.2 steps 2 and 8): the
 * app on `next start`, then nginx in front from scripts/nginx-test/up.sh (the production default.conf, rendered for the
 * local network by render.mjs), and e2e/first-visit-transfer.spec.ts measured through it, so the bytes counted are the
 * ones a browser receives from nginx: its compression, its headers and its protocol (HTTP/2 once default.conf enables it
 * on 443; the spec's log line names the protocol it saw).
 *
 *   npm run build
 *   CI=1 E2E_NGINX_URL=https://127.0.0.1:<8440+K> npx playwright test -c playwright.perf-nginx.config.ts
 *
 * The browser reaches nginx by its one server name, with no port (R15-1): Chromium maps makrai.org:443 to the local nginx
 * port, so the TLS handshake carries the name default.conf serves (its default_server refuses a handshake without one,
 * `ssl_reject_handshake on`) and the Origin header has no port (lib/http/sameOrigin.ts compares hosts). Every request of
 * the spec goes through the browser: a Node request context would resolve makrai.org through DNS, to the real site, so
 * the spec makes its setup calls with fetch inside the page (e2e/first-visit-transfer.spec.ts, `apiPost`).
 *
 * The app runs with the test seams on and the fixture content, as playwright.config.ts's server does, because the spec's
 * default run measures the fixture's 28-question stage and makes its accounts with the record fixture builder on the
 * slot's database. No mail catcher: RESEND_API_KEY is blank, so an invitation is still created and answers 201 with its
 * acceptUrl (playwright.config.ts, D-188). Nothing already running is reused (`reuseExistingServer` false).
 */
const port = e2ePort(process.env); // H0's rule: unset outside CI throws
const nginxUrl = process.env.E2E_NGINX_URL ?? '';
const m = /^https:\/\/127\.0\.0\.1:(\d{4,5})$/.exec(nginxUrl);
if (!m || Number(m[1]) < 8440) throw new Error('E2E_NGINX_URL must be https://127.0.0.1:<8440+K> (scripts/nginx-test/up.sh)');
const nginxPort = Number(m[1]);
const k = nginxPort - 8440;
const channel = process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {};
const FIXTURE_CONTENT_ROOT = path.join(process.cwd(), '__tests__', 'fixtures', 'content');

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, reporter: [['list']],
  // `content` publishes the fixture content's registry rows on the slot's database first, as playwright.config.ts does.
  projects: [
    { name: 'content', testMatch: /content\.setup\.ts/ },
    { name: 'perf-nginx', testMatch: /first-visit-transfer\.spec\.ts$/, dependencies: ['content'] },
  ],
  use: {
    baseURL: 'https://makrai.org',
    ignoreHTTPSErrors: true, // up.sh's self-signed certificate
    launchOptions: { args: [`--host-resolver-rules=MAP makrai.org:443 127.0.0.1:${nginxPort}`] },
    ...channel,
  },
  webServer: [
    { name: 'app', url: e2eBaseURL(process.env), reuseExistingServer: false,
      command: `sh -c 'mkdir -p test-results && exec npm run start -- -p ${port} > test-results/server.log 2>&1'`,
      env: { NEXTAUTH_URL: 'https://makrai.org', RESEND_API_KEY: '', MAKRAI_TEST_SEAMS: '1', MAKRAI_CONTENT_ROOT: FIXTURE_CONTENT_ROOT } },
    { name: 'nginx', command: `scripts/nginx-test/up.sh ${k}`, port: nginxPort, reuseExistingServer: false, // a TCP accept, not a url
      timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 }, env: { E2E_PORT: port } },
  ],
});
