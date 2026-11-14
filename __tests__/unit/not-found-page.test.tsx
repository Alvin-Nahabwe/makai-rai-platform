import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

const headersMock = vi.hoisted(() => vi.fn());
const readSessionDeadlinesMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: readSessionDeadlinesMock }));

import NotFound, { metadata } from '@/app/not-found';
import { ERRORS_COPY } from '@/lib/errors/copy';
import { pageTitle } from '@/lib/ui/title';
import NotFoundInGroup, { metadata as groupMetadata } from '@/app/(authenticated)/not-found';
import NotFoundCard from '@/components/layout/NotFoundCard';

/**
 * S-31, "Not found or no access" (SRS 7.1.5, line 1701; UX-05; M-27 at SRS
 * line 2574). One page for a missing page, a missing record and a non-member,
 * with the same words for all three, so it can never tell a non-member that an
 * organisation exists. Status 404 is the framework's: `notFound()` sends it
 * before streaming starts (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/not-found.md), which the e2e case checks on a real server.
 */

const M27 = ERRORS_COPY.notFound.body;

describe('S-31 not-found page', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A signed-out visitor is the ordinary case on an unknown address: no cookie, no deadlines.
    headersMock.mockReset();
    headersMock.mockResolvedValue(new Headers());
    readSessionDeadlinesMock.mockReset();
    readSessionDeadlinesMock.mockResolvedValue(null);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('FR-RM-03 UX-05 (S-31 part): the not-found page shows M-27 and a link home', async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain(M27);
    expect(html).toMatch(new RegExp(`<a[^>]*href="/"[^>]*>${ERRORS_COPY.notFound.home}</a>`));
    expect(html).toContain('<main id="main-content"');
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
  });

  it('FR-RM-03 UX-05 (S-31 part): the page title names the screen, then the product', () => {
    expect(metadata.title).toBe(pageTitle(ERRORS_COPY.titles.notFound));
  });

  it('1A-16c (A 13 to 17): the title and the heading say the same words, and the card says them from the copy module', () => {
    expect(ERRORS_COPY.titles.notFound).toBe('Page not found');
    expect(ERRORS_COPY.notFound.heading).toBe(ERRORS_COPY.titles.notFound);
    expect(renderToStaticMarkup(<NotFoundCard />)).toContain(`<h1>${ERRORS_COPY.notFound.heading}</h1>`);
  });

  it('FR-RM-03 UX-05 (S-31 part): the not-found page echoes nothing from the request', async () => {
    // It takes no props, so no segment, slug or search parameter can reach it ...
    expect(NotFound.length).toBe(0);
    // ... and it reads nothing from the request by any other route: the one headers() call is the
    // argument of readSessionDeadlines, whose result is two numbers (UX-43).
    const source = readFileSync('app/not-found.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const reader of ['useParams', 'usePathname', 'useSearchParams', 'cookies(', 'params', 'searchParams']) {
      expect(source, reader).not.toContain(reader);
    }
    expect([...source.matchAll(/\bheaders\(/g)]).toHaveLength(1);
    expect(source).toMatch(/readSessionDeadlines\(\s*await headers\(\)\s*\)/);
    // The text is the same whatever rendered it: two requests for different addresses give byte-identical markup,
    // for a signed-out visitor and for a signed-in one.
    for (const deadlines of [null, { secondsLeft: 600, absoluteSecondsLeft: 100000 }]) {
      readSessionDeadlinesMock.mockResolvedValue(deadlines);
      headersMock.mockResolvedValue(new Headers({ 'x-pathname': '/orgs/secret-org/dashboard', referer: 'https://example.invalid/a' }));
      const first = renderToStaticMarkup(await NotFound());
      headersMock.mockResolvedValue(new Headers({ 'x-pathname': '/no-such-page', referer: 'https://example.invalid/b' }));
      expect(renderToStaticMarkup(await NotFound())).toBe(first);
      expect(first).not.toMatch(/secret-org|no-such-page|example\.invalid/);
    }
  });

  it('UX-43 (S-31 part): a signed-in visitor gets the idle dialog on the not-found page', async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    const requestHeaders = new Headers({ cookie: 'authjs.session-token=x' });
    headersMock.mockResolvedValue(requestHeaders);
    const html = renderToStaticMarkup(await NotFound());
    expect([...html.matchAll(/<div class="shell-idle" data-seconds-left="\d+">/g)]).toHaveLength(1);
    expect([...html.matchAll(/<dialog[^>]*class="ui-dialog"[^>]*>/g)]).toHaveLength(1);
    expect(html).toContain('data-seconds-left="600"');
    expect(html).toContain(M27);
    expect(html).toMatch(new RegExp(`<a[^>]*href="/"[^>]*>${ERRORS_COPY.notFound.home}</a>`));
    expect(readSessionDeadlinesMock.mock.calls[0][0]).toBe(requestHeaders);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('UX-43 (S-31 part): a signed-out visitor gets no dialog and nothing is logged', async () => {
    readSessionDeadlinesMock.mockResolvedValue(null);
    const html = renderToStaticMarkup(await NotFound());
    expect(html).not.toContain('<dialog');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(html).toContain(M27);
  });

  it("FR-RM-03 UX-05 (S-31 part): the signed-in group's not-found page shows M-27 and a link home, with no main and no dialog of its own", () => {
    const html = renderToStaticMarkup(<NotFoundInGroup />);
    expect(html).toContain(M27);
    expect(html).toMatch(new RegExp(`<a[^>]*href="/"[^>]*>${ERRORS_COPY.notFound.home}</a>`));
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    // the group's layout supplies the one main (and, after the shell work, the one id) and the one dialog
    expect(html).not.toMatch(/<main|<dialog|shell-idle|id="main-content"/);
  });

  it('FR-RM-03 UX-05 (S-31 part): the two not-found pages show the same card and the same title', async () => {
    const card = renderToStaticMarkup(<NotFoundCard />);
    expect(renderToStaticMarkup(<NotFoundInGroup />)).toBe(card);
    expect(renderToStaticMarkup(await NotFound())).toContain(card); // readSessionDeadlines mocked to null in beforeEach
    expect(groupMetadata.title).toBe(metadata.title);
  });

  it("FR-RM-03 UX-05 (S-31 part): the signed-in group's not-found page reads nothing from the request", () => {
    expect(NotFoundInGroup.length).toBe(0);
    for (const file of ['app/(authenticated)/not-found.tsx', 'components/layout/NotFoundCard.tsx']) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      for (const reader of ['headers(', 'cookies(', 'useParams', 'usePathname', 'useSearchParams', 'params', 'searchParams', 'readSessionDeadlines', 'IdleWarning', '<main']) {
        expect(source, `${file} ${reader}`).not.toContain(reader);
      }
    }
  });

  it('UX-05 (S-31 part): the two S-31 files are the only not-found or no-access pages, with no experimental forbidden()', () => {
    // Owner question B21 default (contract owner question 9, E-21): an action page opened by
    // address shows M-26 in the page with status 200, so no 403 page and no authInterrupts flag.
    for (const f of ['app/forbidden.tsx', 'app/forbidden.js', 'app/unauthorized.tsx', 'app/unauthorized.js']) {
      expect(existsSync(f), f).toBe(false);
    }
    expect(readFileSync('next.config.ts', 'utf8')).not.toMatch(/authInterrupts/);

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/^(not-found|forbidden|unauthorized)\.(tsx|ts|jsx|js)$/.test(name)) found.push(path);
      }
    };
    walk('app');
    expect(found.sort()).toEqual(['app/(authenticated)/not-found.tsx', 'app/not-found.tsx']);
  });
});
