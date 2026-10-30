/**
 * A connection reset on a request the test makes itself: Node reports it as `ECONNRESET`, and Playwright's request
 * client words it "socket hang up" or "read ECONNRESET". Nothing else counts, so a refused connection, a timeout or a
 * browser network error is not mistaken for it.
 */
export function isConnectionReset(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ''}` : String(e);
  return /ECONNRESET|socket hang up/i.test(text);
}

/**
 * Runs `fetch` and, when it fails with a connection reset and `method` is GET, runs it once more and returns that
 * result (or throws that error). e2e/csp.spec.ts fetches every request of a page itself, and a GET to the server that
 * Playwright had just started was seen to fail once with ECONNRESET; CI runs the suite with --fail-on-flaky-tests, so
 * one such reset turned the job red. A GET can be repeated without harm. A write is never repeated, whatever the error,
 * and any other error is rethrown at once.
 */
export async function fetchRetryingReset<T>(method: string, fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch();
  } catch (e) {
    if (method.toUpperCase() === 'GET' && isConnectionReset(e)) return fetch();
    throw e;
  }
}
