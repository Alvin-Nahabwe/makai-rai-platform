import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import NotFound, { metadata } from '@/app/not-found';

/**
 * S-31, "Not found or no access" (SRS 7.1.5, line 1701; UX-05; M-27 at SRS
 * line 2574). One page for a missing page, a missing record and a non-member,
 * with the same words for all three, so it can never tell a non-member that an
 * organisation exists. Status 404 is the framework's: `notFound()` sends it
 * before streaming starts (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/not-found.md), which the e2e case checks on a real server.
 */

const M27 =
  'We cannot find this page, or you do not have access to it. If someone sent you this link, ask them to check it or to invite you.';

describe('S-31 not-found page', () => {
  it('FR-RM-03 UX-05 (S-31 part): the not-found page shows M-27 and a link home', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain(M27);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Go to your home page<\/a>/);
    expect(html).toContain('<main id="main-content"');
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
  });

  it('FR-RM-03 UX-05 (S-31 part): the page title names the screen, then the product', () => {
    expect(metadata.title).toBe('Not found - MAK-AI RAI Platform');
  });

  it('FR-RM-03 UX-05 (S-31 part): the not-found page echoes nothing from the request', () => {
    // It takes no props, so no segment, slug or search parameter can reach it ...
    expect(NotFound.length).toBe(0);
    // ... and it reads nothing from the request by any other route.
    const source = readFileSync('app/not-found.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const reader of ['useParams', 'usePathname', 'useSearchParams', 'headers(', 'cookies(', 'params', 'searchParams']) {
      expect(source, reader).not.toContain(reader);
    }
    // The text is the same whatever rendered it: two renders are byte-identical.
    expect(renderToStaticMarkup(<NotFound />)).toBe(renderToStaticMarkup(<NotFound />));
  });

  it('UX-05 (S-31 part): S-31 is the only not-found or no-access page, with no experimental forbidden()', () => {
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
    expect(found).toEqual(['app/not-found.tsx']);
  });
});
