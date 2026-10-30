import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchRetryingReset, isConnectionReset } from '../../e2e/helpers/retryFetch';

/**
 * NFR-MNT-03 (harness). e2e/csp.spec.ts fetches every request of a page itself (`route.fetch`) to add the production
 * policy to the response. A GET to the server that Playwright has just started was seen to fail once with ECONNRESET
 * ("socket hang up"), and CI runs the suite with --fail-on-flaky-tests, so one reset turned the job red. A GET is retried
 * once for that error and for no other; a write is never repeated, and anything else is rethrown.
 */

const reset = () => Object.assign(new Error('apiRequestContext.fetch: read ECONNRESET'), { code: 'ECONNRESET' });

/** A fetch that fails with the given errors in turn and then answers, counting its calls. */
function fake(failures: unknown[], answer = 'response') {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      if (failures.length > 0) throw failures.shift();
      return answer;
    },
  };
}

describe('fetchRetryingReset', () => {
  it('NFR-MNT-03 (harness): a GET that is reset is sent once more, and the second answer is the result', async () => {
    for (const failure of [reset(), new Error('socket hang up'), new Error('apiRequestContext.fetch: Socket Hang Up'), 'read ECONNRESET']) {
      const f = fake([failure]);
      await expect(fetchRetryingReset('GET', f.fetch), String(failure)).resolves.toBe('response');
      expect(f.calls(), String(failure)).toBe(2);
    }
    const lower = fake([reset()]);
    await expect(fetchRetryingReset('get', lower.fetch)).resolves.toBe('response'); // the method is compared without regard to case
    expect(lower.calls()).toBe(2);
  });

  it('NFR-MNT-03 (harness): it retries once and no more, so a second reset is the test\'s failure', async () => {
    const second = Object.assign(new Error('socket hang up'), { second: true });
    const f = fake([reset(), second]);
    await expect(fetchRetryingReset('GET', f.fetch)).rejects.toBe(second);
    expect(f.calls()).toBe(2);
  });

  it('NFR-MNT-03 (harness): a write is never repeated, whatever went wrong', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const f = fake([reset()]);
      await expect(fetchRetryingReset(method, f.fetch), method).rejects.toThrow('ECONNRESET');
      expect(f.calls(), method).toBe(1);
    }
  });

  it('NFR-MNT-03 (harness): any other error is rethrown at once, and a first answer is returned without a second call', async () => {
    for (const failure of [new Error('apiRequestContext.fetch: connect ECONNREFUSED'), new Error('Timeout 30000ms exceeded'), new Error('net::ERR_CONNECTION_RESET'), new TypeError('x'), 42, undefined]) {
      const f = fake([failure]);
      await expect(fetchRetryingReset('GET', f.fetch), String(failure)).rejects.toBe(failure);
      expect(f.calls(), String(failure)).toBe(1);
    }
    const ok = fake([]);
    await expect(fetchRetryingReset('GET', ok.fetch)).resolves.toBe('response');
    expect(ok.calls()).toBe(1);
  });

  it('NFR-MNT-03 (harness): isConnectionReset names the two shapes of a reset and nothing else', () => {
    expect(isConnectionReset(reset())).toBe(true);
    expect(isConnectionReset(new Error('socket hang up'))).toBe(true);
    expect(isConnectionReset(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionReset(new Error('ECONNREFUSED'))).toBe(false);
    expect(isConnectionReset(null)).toBe(false);
  });

  it('NFR-MNT-03 (harness): csp.spec.ts fetches through it, so no request of a page is fetched bare', () => {
    const spec = readFileSync('e2e/csp.spec.ts', 'utf8');
    expect(spec).toMatch(/fetchRetryingReset\(\s*route\.request\(\)\.method\(\)/);
    expect(spec.match(/route\.fetch\(/g)).toHaveLength(1); // the one inside the wrapper's callback
    expect(spec.match(/await route\.fetch\(/g)).toBeNull();
  });
});
