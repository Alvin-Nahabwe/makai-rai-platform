import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { captureFrom, expectNoMarkersOrEmails, startServerLogCapture } from './helpers/logs';
import { applyNetworkProfile } from './helpers/network';
import { expectNoPersonalData, expectNoThirdPartyRequests, recordRequests } from './helpers/requests';
import { expectTargetsAtLeast24px } from './helpers/targetSize';

/**
 * Self-test of the browser helpers (units/H0.md Task H5). Every case builds its own page with
 * `page.setContent`: the real screens still carry the 7.6.3 defects that UI fixes, so a
 * zero-violation run on them would be red today. No address here names a loopback host with a
 * port, because `__tests__/lint/e2e-no-literal-port.test.ts` forbids that in any e2e file; the
 * fake origins use the reserved `.test` suffix.
 */

test('NFR-A11Y-01 (harness): the checker passes a clean page and names the state when it fails', async ({ page }) => {
  await page.setContent('<html lang="en"><head><title>t</title></head><body><main><h1>Ok</h1></main></body></html>');
  await expectNoSeriousA11yViolations(page, 'clean');
  await page.setContent('<html lang="en"><body><main><img src="x.png"></main></body></html>');
  await expect(expectNoSeriousA11yViolations(page, 'img without alt')).rejects.toThrow(/img without alt[\s\S]*image-alt/);
});

test('NFR-SEC-11 (harness): failOnDialog fails a page that opens an alert', async ({ page }) => {
  const info = test.info();
  failOnDialog(page);
  // The handler must dismiss the dialog (or this call never returns) and record a failure on the test.
  await page.setContent('<html lang="en"><body onload="alert(\'hostile-dialog-text\')">x</body></html>');
  await expect.poll(() => info.errors.length, { message: 'failOnDialog recorded no failure on the test' }).toBeGreaterThan(0);
  const recorded = info.errors.map((e) => e.message ?? '').join('\n');
  expect(recorded).toContain('alert dialog');
  expect(recorded).toContain('hostile-dialog-text');
  // The failure above is the one this test exists to provoke. Declaring it only now means a test
  // that never saw the failure stays red, and one that did is reported as the pass it is.
  test.fail(true, 'failOnDialog must fail the test that opened the dialog; the failure was observed above');
});

test('NFR-A11Y-04 (harness): a 10 by 10 button fails the target-size check, a 24 by 24 one passes', async ({ page }) => {
  const small = 'display:inline-block;width:10px;height:10px;padding:0;border:0;margin:0 2px 0 0;background:#333';
  const big = 'display:inline-block;width:24px;height:24px;padding:0;border:0;margin:0;background:#333';
  // Three 10 px buttons 2 px apart: each one's 24 px circle meets its neighbours' circles.
  await page.setContent(`<html lang="en"><body style="margin:40px"><button style="${small}">a</button><button style="${small}">b</button><button style="${small}">c</button></body></html>`);
  await expect(expectTargetsAtLeast24px(page)).rejects.toThrow(/button/);
  // 24 by 24 buttons next to each other pass on size alone.
  await page.setContent(`<html lang="en"><body style="margin:40px"><button style="${big}">a</button><button style="${big}">b</button><button style="${big}">c</button></body></html>`);
  await expectTargetsAtLeast24px(page);
  // WCAG 2.5.8 spacing exception: one small button with a clear 24 px circle passes.
  await page.setContent(`<html lang="en"><body style="margin:80px"><button style="${small}">a</button></body></html>`);
  await expectTargetsAtLeast24px(page);
  // WCAG 2.5.8 inline exception: a small link inside a sentence passes, even beside another.
  await page.setContent('<html lang="en"><body style="margin:20px"><p style="font-size:12px">Read <a href="#a">the terms</a> and <a href="#b">the policy</a> first.</p></body></html>');
  await expectTargetsAtLeast24px(page);
});

test('NFR-A11Y-02 (harness): a focused field under a fixed bar fails the focus check', async ({ page }) => {
  const covered = (outline: string) => `<html lang="en"><head><style>
    body{margin:0;height:400px}
    input{position:fixed;left:10px;bottom:20px;width:200px;height:30px;${outline}}
    footer{position:fixed;left:0;right:0;bottom:0;height:80px;background:#ccc}
  </style></head><body><input id="f" aria-label="Field"><footer>Save bar</footer></body></html>`;
  await page.setContent(covered('outline:3px solid #036;'));
  await page.focus('#f');
  await expect(expectFocusVisibleAndUncovered(page)).rejects.toThrow(/covered/);

  const clear = (outline: string) => `<html lang="en"><head><style>
    body{margin:0}
    input{position:fixed;left:10px;top:20px;width:200px;height:30px;${outline}}
  </style></head><body><input id="f" aria-label="Field"></body></html>`;
  await page.setContent(clear('outline:3px solid #036;'));
  await page.focus('#f');
  await expectFocusVisibleAndUncovered(page);
  await page.setContent(clear('outline:none;box-shadow:none;'));
  await page.focus('#f');
  await expect(expectFocusVisibleAndUncovered(page)).rejects.toThrow(/focus indicator/);
  await page.setContent(clear('outline:none;box-shadow:0 0 0 3px #036;'));
  await page.focus('#f');
  await expectFocusVisibleAndUncovered(page);
  await page.setContent(clear('outline:3px solid #036;margin-left:-200px;'));
  await page.focus('#f');
  await expect(expectFocusVisibleAndUncovered(page)).rejects.toThrow(/viewport/);
  await page.setContent('<html lang="en"><body>nothing focused</body></html>');
  await expect(expectFocusVisibleAndUncovered(page)).rejects.toThrow(/nothing is focused/);
});

test('NFR-PRIV-04 (harness): a request carrying an email or to another origin is reported', async ({ page }) => {
  expect(() => expectNoPersonalData(['http://harness.test/x?e=a%40b.example'], ['a@b.example'])).toThrow(/a@b.example/);
  expect(() => expectNoPersonalData(['http://harness.test/x?e=A%40B.EXAMPLE'], ['a@b.example'])).toThrow(/a@b.example/);
  expect(() => expectNoPersonalData(['http://harness.test/x?e=other'], ['a@b.example'])).not.toThrow();
  // A malformed escape must not hide a needle, in the address as written or once its other escapes are decoded.
  expect(() => expectNoPersonalData(['http://harness.test/x%zz?e=a@b.example'], ['a@b.example'])).toThrow(/a@b.example/);
  expect(() => expectNoPersonalData(['http://harness.test/x%zz?e=a%40b.example'], ['a@b.example'])).toThrow(/a@b.example/);
  expect(() => expectNoPersonalData(['http://harness.test/x'], [''])).toThrow(/empty needle/);
  expect(() => expectNoThirdPartyRequests(['https://cdn.example/x.js'], 'http://harness.test')).toThrow(/cdn.example/);
  expect(() => expectNoThirdPartyRequests(['data:image/png;base64,AA', 'blob:http://harness.test/1'], 'http://harness.test')).not.toThrow();
  expect(() => expectNoThirdPartyRequests(['http://harness.test/a', 'http://harness.test:81/b'], 'http://harness.test')).toThrow(/harness.test:81/);
  expect(() => expectNoThirdPartyRequests(['not a url'], 'http://harness.test')).toThrow(/not a url/);

  const seen = recordRequests(page);
  await page.route('http://harness.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="en"><body>ok</body></html>' }));
  await page.goto('http://harness.test/start?x=1');
  expect(seen.urls()).toEqual(['http://harness.test/start?x=1']);
});

test('NFR-PRIV-03 NFR-OBS-05 (harness): server log capture returns only the lines written while it ran', async () => {
  const log = 'test-results/server.log';
  const before = readFileSync(log, 'utf8').split('\n').find((l) => l.trim() !== '');
  expect(before, 'the web server wrote nothing to test-results/server.log before the tests started').toBeTruthy();
  const capture = startServerLogCapture();
  appendFileSync(log, 'HARNESS-LINE-ONE\nHARNESS-LINE-TWO\n');
  const lines = await capture.stop();
  expect(lines.filter((l) => l.startsWith('HARNESS-LINE'))).toEqual(['HARNESS-LINE-ONE', 'HARNESS-LINE-TWO']);
  expect(lines).not.toContain(before);
  expectNoMarkersOrEmails(lines);
  expect(() => expectNoMarkersOrEmails(['fine', 'saved ZZMARK-name-3-QX for a@b.example'])).toThrow(/ZZMARK-name-3-QX[\s\S]*a@b\.example/);
  // Colour codes in the middle of a marker or an address must not hide it from the scan.
  expect(() => expectNoMarkersOrEmails(['\u001b[31mZZMARK-na\u001b[0mme-3-QX'])).toThrow(/ZZMARK-name-3-QX/);
  expect(() => expectNoMarkersOrEmails(['\u001b[31ma@b.example\u001b[0m'])).toThrow(/a@b\.example/);
});

test('NFR-OBS-05 (harness): a missing or empty server log is a failure, not an empty capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-log-'));
  try {
    const missing = join(dir, 'missing.log');
    expect(() => captureFrom(missing)).toThrow(/server log missing/);
    const empty = join(dir, 'empty.log');
    writeFileSync(empty, '');
    expect(() => captureFrom(empty)).toThrow(/server log empty/);

    const one = join(dir, 'one.log');
    writeFileSync(one, 'first line\n');
    const capture = captureFrom(one);
    appendFileSync(one, '\u001b[32mafter one\u001b[0m\nafter two');
    expect(await capture.stop()).toEqual(['after one', 'after two']);

    const shrunk = join(dir, 'shrunk.log');
    writeFileSync(shrunk, 'a line that is long enough\n');
    const truncated = captureFrom(shrunk);
    writeFileSync(shrunk, 'x\n');
    await expect(truncated.stop()).rejects.toThrow(/server log (truncated|shrank)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NFR-PERF-01 (harness): the Constrained profile slows a fetch', async ({ page }) => {
  const body = Buffer.alloc(200_000, 97);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/blob`;
    await page.setContent('<html lang="en"><body>profile</body></html>');
    const timeFetch = () =>
      page.evaluate(async (u) => {
        const t0 = performance.now();
        const r = await fetch(u, { cache: 'no-store' });
        const bytes = (await r.arrayBuffer()).byteLength;
        return { ms: performance.now() - t0, bytes };
      }, url);
    const open = await timeFetch();
    await applyNetworkProfile(page, 'Constrained');
    const slow = await timeFetch();
    expect(slow.bytes).toBe(200_000);
    // 200 KB at 1.6 Mbit/s (200 kB/s) is one second, plus 150 ms of latency.
    expect(slow.ms, `unthrottled ${open.ms.toFixed(0)} ms, Constrained ${slow.ms.toFixed(0)} ms`).toBeGreaterThan(900);
    expect(open.ms).toBeLessThan(slow.ms / 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('NFR-MNT-03 (harness): the fixture sign-in test sets its own 120 second timeout', () => {
  // R11-34: the 20 sign-ins took 26.5 s at a machine load of 8.3 and timed out once at 8.5 under the default 30 s.
  expect(readFileSync('e2e/fixtures/auth.setup.ts', 'utf8')).toMatch(/setup\.setTimeout\(120_000\)/);
});
