import type { Page } from '@playwright/test';

/**
 * Request capture for NFR-PRIV-04 (no personal data in a request address, no request to a third
 * party). `recordRequests` listens from the moment it is called; navigations, scripts, images and
 * `fetch` calls all appear, in the order the browser issued them.
 */
export function recordRequests(page: Page): { urls(): string[] } {
  const seen: string[] = [];
  page.on('request', (request) => {
    seen.push(request.url());
  });
  return { urls: () => [...seen] };
}

/**
 * Every run of valid `%XX` escapes decoded on its own. A malformed run (a stray `%zz`, or bytes that
 * are not UTF-8) stays as written instead of making the whole address undecodable, so a needle
 * elsewhere in the same address is still found.
 */
function decodeEscapes(url: string): string {
  return url.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** An address without its query string or fragment, for a message that must not repeat what leaked. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Fails when any address holds any needle, compared without regard to case, in the address as written
 * and with its escapes decoded (so `a%40b.example` matches `a@b.example`). Names the needle and the
 * address up to its path.
 */
export function expectNoPersonalData(urls: readonly string[], needles: readonly string[]): void {
  if (needles.some((n) => n === '')) {
    throw new Error('expectNoPersonalData: an empty needle matches every address');
  }
  const hits: string[] = [];
  for (const url of urls) {
    const forms = [url.toLowerCase(), decodeEscapes(url).toLowerCase()];
    for (const needle of needles) {
      if (forms.some((f) => f.includes(needle.toLowerCase()))) hits.push(`${needle} in ${withoutQuery(url)}`);
    }
  }
  if (hits.length > 0) throw new Error(`${hits.length} request(s) carry personal data\n${hits.join('\n')}`);
}

/**
 * Fails on any request that is not to the origin of `baseURL`. `data:` and `blob:` addresses are
 * allowed (they leave the page nowhere). An address that cannot be parsed is reported, not skipped.
 */
export function expectNoThirdPartyRequests(urls: readonly string[], baseURL: string): void {
  const base = new URL(baseURL).origin;
  const outside = urls.filter((url) => {
    if (/^(?:data|blob):/i.test(url)) return false;
    try {
      return new URL(url).origin !== base;
    } catch {
      return true;
    }
  });
  if (outside.length === 0) return;
  const named = [...new Set(outside.map((u) => withoutQuery(u)))];
  throw new Error(`${outside.length} request(s) leave ${base}\n${named.join('\n')}`);
}
