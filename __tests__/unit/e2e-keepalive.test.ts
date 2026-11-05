import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Playwright's API request context pools a keep-alive socket and has no client idle timer, and Node's server
 * destroys an idle socket 6 s after its last response (keepAliveTimeout 5000 plus a 1000 ms buffer). A request
 * sent within milliseconds of that instant while the server's loop is busy is reset (`read ECONNRESET`), which
 * --fail-on-flaky-tests turns red. A context that makes sparse requests while the browser works therefore sends
 * `connection: close`, so no socket idles. No retry, no sleep.
 */
describe('e2e request contexts that idle between requests', () => {
  it('NFR-MNT-01: the crawls\' API contexts and the CSP sweep\'s fetch send connection: close', () => {
    const claims = readFileSync('e2e/claims-crawl.spec.ts', 'utf8');
    const noScore = readFileSync('e2e/no-score-crawl.spec.ts', 'utf8');
    const csp = readFileSync('e2e/csp.spec.ts', 'utf8');
    expect(claims).toMatch(/pwRequest\.newContext\(\{[^}]*extraHTTPHeaders: \{ connection: 'close' \}/);
    expect(noScore).toMatch(/pwRequest\.newContext\(\{[^}]*extraHTTPHeaders: \{ connection: 'close' \}/);
    expect(csp).toMatch(/route\.fetch\(\{[\s\S]*?connection: 'close'/);
  });

  it('NFR-MNT-01: no retry helper stands in for the header', () => {
    const csp = readFileSync('e2e/csp.spec.ts', 'utf8');
    expect(csp).not.toMatch(/retryFetch|fetchRetryingReset/);
  });
});
