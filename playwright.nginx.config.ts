import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { e2eBaseURL, e2ePort } from './e2e/helpers/port';

/**
 * The Playwright config of the nginx-in-front run (SRS NFR-SEC-06 "Verified by"; 12.2 step 2; ACC-b Task 15): the mail
 * catcher, the app on `next start`, then the production nginx configuration in a container, started in that order and
 * stopped at the end. It runs e2e/sign-in-nginx.spec.ts and the two J-15 cases of e2e/account.spec.ts, the specs tagged
 * @nginx, and nothing else. Run with `CI=1 E2E_NGINX_URL=https://127.0.0.1:<8440+K> npx playwright test -c
 * playwright.nginx.config.ts` after `npm run build`; it starts no server that is already running (`reuseExistingServer`
 * false everywhere).
 *
 * nginx's readiness is a TCP accept on its port, not a `url` probe: Playwright's probe sends no server name and
 * default.conf's default_server refuses a handshake without one (`ssl_reject_handshake on`), so a `url` entry would never
 * become ready. The specs wait for the first answer through nginx themselves.
 */
const port = e2ePort(process.env); // H0's rule: unset outside CI throws
const nginxUrl = process.env.E2E_NGINX_URL ?? '';
const m = /^https:\/\/127\.0\.0\.1:(\d{4,5})$/.exec(nginxUrl);
if (!m || Number(m[1]) < 8440) throw new Error('E2E_NGINX_URL must be https://127.0.0.1:<8440+K> (ACC-b Task 15)');
const nginxPort = Number(m[1]);
const k = nginxPort - 8440;
const mailOut = join(tmpdir(), `makrai-mail-${port}.jsonl`);
process.env.E2E_MAIL_OUT = mailOut;

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, reporter: [['list']],
  testMatch: /(sign-in-nginx|account)\.spec\.ts$/, grep: /@nginx/, // the nginx spec, and only the two J-15 cases of account.spec.ts
  use: { baseURL: e2eBaseURL(process.env) }, // required by the array form
  webServer: [
    { name: 'mail catcher', command: `node scripts/mail-catcher/catcher.mjs --host 127.0.0.1 --port 0 --out ${mailOut}`,
      // A named group, stored upper-cased in process.env as MAIL_PORT for the next entry; written as a string because the
      // project's TypeScript target predates named groups in regex literals.
      wait: { stdout: new RegExp('listening (?<mail_port>\\d+)') }, reuseExistingServer: false },
    { name: 'app', url: e2eBaseURL(process.env), reuseExistingServer: false,
      command: `sh -c 'mkdir -p test-results && RESEND_BASE_URL=http://127.0.0.1:$MAIL_PORT exec npm run start -- -p ${port} >> test-results/server.log 2>&1'`,
      env: { NEXTAUTH_URL: 'https://makrai.org', RESEND_API_KEY: 're_test_local' } },
    { name: 'nginx', command: `scripts/nginx-test/up.sh ${k}`, port: nginxPort, reuseExistingServer: false, // a TCP accept, not a url
      timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 }, env: { E2E_PORT: port } },
  ],
});
