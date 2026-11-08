import type { APIRequest } from '@playwright/test';

/**
 * Keeps every request a spec sends from Playwright's Node side on this machine.
 *
 * An image config (V's, and playwright.perf-nginx.config.ts) points the browser at `https://makrai.org` and maps that
 * name to the local nginx with Chromium's `--host-resolver-rules`. Only Chromium honours the rule. `route.fetch()`,
 * `page.request`, `context.request`, the `request` fixture and `request.newContext()` send from Node, which resolves
 * makrai.org through DNS, to the public site: in V session 1 one synthetic POST most likely went there that way.
 *
 * All of those reach the network through one method, `APIRequestContext._innerFetch` (playwright-core 1.64.1,
 * node_modules/playwright-core/lib/coreBundle.js: `APIRequestContext.fetch` and `Route.fetch` both call it), so the
 * guard wraps that method on the class, which covers every context however it was made, and Node's global `fetch`.
 * Install it through e2e/helpers/loopbackOnly.ts's `test`; __tests__/lint/e2e-loopback-guard.test.ts requires that of
 * every file an image config runs. A refused request throws NonLoopbackRequestError before any connection, and is also
 * recorded, so a spec that catches the error still fails (loopbackOnly.ts).
 *
 * The rule is strict on purpose, because what Node does next cannot be seen from here:
 * - the URL must be absolute: a relative path resolves on Playwright's server against the context's own baseURL, which
 *   this side cannot read (a `test.use({ baseURL })` or `newContext({ baseURL })` may name makrai.org);
 * - its host must be 127.0.0.0/8, `localhost` or ::1;
 * - it must follow no redirect (`maxRedirects: 0`; `redirect: 'manual'` or `'error'` for fetch): the app redirects to
 *   its public origin (NEXTAUTH_URL https://makrai.org in the nginx and image runs), and Node would follow it out.
 *
 * Not covered: code that runs while a spec file loads, before the worker fixture; globalSetup and globalTeardown; a
 * `fetch` reference taken before the guard installed; a child process a spec starts (`curl`, `node`); Node's `http`,
 * `https`, `http2`, `net`, `tls` and `WebSocket`; a proxy. The lint test forbids the modules in those files.
 */

export class NonLoopbackRequestError extends Error {
  override name = 'NonLoopbackRequestError';
}

/** 127.0.0.0/8, `localhost` and ::1 (as URL.hostname writes it, in brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

type RequestCheck = {
  /** 0 when the request follows no redirect. */
  maxRedirects?: number;
  /** What sent it, for the message. */
  via: string;
};

const refusals: string[] = [];

function refuse(message: string): never {
  refusals.push(message);
  throw new NonLoopbackRequestError(message);
}

/** The refusals since the last call, emptied. loopbackOnly.ts fails a test that leaves any. */
export function takeRefusals(): string[] {
  return refusals.splice(0);
}

/** Throws, and records the refusal, unless a request sent from Node can only reach this machine. */
export function assertNodeSideRequestStaysLocal(target: string, check: RequestCheck): void {
  if (!URL.canParse(target)) {
    refuse(`${check.via}: ${target} is not an absolute URL; its host would be the context's baseURL, which may be makrai.org. Give an absolute loopback URL.`);
  }
  const url = new URL(target);
  if (!isLoopbackHost(url.hostname)) {
    refuse(
      `${check.via}: ${url.origin} is not this machine. Playwright's Node side ignores --host-resolver-rules and would ` +
        'resolve it through DNS, to the real host. Send it from the page (fetch inside page.evaluate) or let the browser ' +
        'make it (route.continue, or CDP Fetch for a lost reply).',
    );
  }
  if (check.maxRedirects !== 0) {
    refuse(`${check.via}: ${url.origin} may redirect off this machine (the app redirects to its public origin), and Node would follow: pass maxRedirects: 0 (redirect: 'manual' for fetch).`);
  }
}

type InnerFetchOptions = { url?: string; request?: { url(): string }; maxRedirects?: number };
type InnerFetch = (this: unknown, options?: InnerFetchOptions) => Promise<unknown>;

const VIA_PLAYWRIGHT = "A request from Playwright's Node side (route.fetch, page.request, the request fixture)";
const VIA_FETCH = "Node's fetch";

function fetchTarget(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  // Anything else is refused by the absolute-URL rule rather than guessed at.
  return '';
}

/**
 * Wraps `APIRequestContext._innerFetch` and `globalThis.fetch` for this process. Returns the function that puts both
 * back. Throws, and so stops the run, if this Playwright has no `_innerFetch`: a guard that cannot install must not
 * pass silently.
 */
export async function installLoopbackGuard(apiRequest: APIRequest): Promise<() => void> {
  const probe = await apiRequest.newContext();
  const proto = Object.getPrototypeOf(probe) as { _innerFetch?: InnerFetch };
  await probe.dispose();
  const inner = proto._innerFetch;
  if (typeof inner !== 'function') {
    throw new Error(
      'APIRequestContext._innerFetch is missing (written for playwright-core 1.64.1): the loopback guard cannot install, ' +
        'so nothing would stop route.fetch or page.request from reaching a public host. Update e2e/helpers/loopbackGuard.ts.',
    );
  }
  proto._innerFetch = async function guardedInnerFetch(this: unknown, options?: InnerFetchOptions) {
    const target = options?.url !== undefined ? options.url : options?.request?.url();
    assertNodeSideRequestStaysLocal(typeof target === 'string' ? target : '', { maxRedirects: options?.maxRedirects, via: VIA_PLAYWRIGHT });
    return inner.call(this, options);
  };

  const nodeFetch = globalThis.fetch;
  // An async function's throw is a rejected promise, as fetch's own errors are.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    assertNodeSideRequestStaysLocal(fetchTarget(input), { maxRedirects: redirect === 'follow' ? undefined : 0, via: VIA_FETCH });
    return nodeFetch(input, init);
  }) as typeof fetch;

  return () => {
    proto._innerFetch = inner;
    globalThis.fetch = nodeFetch;
  };
}
