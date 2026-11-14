import type { ReactElement, ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import ErrorPage from '../../app/error';
import GlobalError from '../../app/global-error';
import { ERRORS_COPY, errorBody, supportReferenceLine } from '../../lib/errors/copy';
import { pageTitle } from '../../lib/ui/title';
import { escapeRe } from '../helpers/escapeRe';

/**
 * NFR-OBS-05 and NFR-AVL-04 (unit H0). When a page fails on the server, the person sees what did not happen,
 * what is safe and what to do (SRS 7.5.7, line 2544), and a support reference they can read out; they never see
 * the error's text (H-S5), which for a server-side failure can name the database host and port. Next 16 hands
 * `app/error.tsx` the props `error` and `retry`; `error.digest` matches the server's own log line for the render.
 */

const SECRET = 'secret adapter text 127.0.0.1:5441';
const failure = (digest?: string) => Object.assign(new Error(SECRET), digest === undefined ? {} : { digest });

/** Finds the first element of type `type` in a rendered tree, without a DOM. */
function find(node: ReactNode, type: string): ReactElement<{ onClick?: () => void; children?: ReactNode }> | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map((n) => find(n, type)).find(Boolean) ?? null;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) return el as ReactElement<{ onClick?: () => void; children?: ReactNode }>;
  return find(el.props?.children, type);
}

it('NFR-OBS-05 NFR-AVL-04: the error page shows the reference and no error text', () => {
  const html = renderToStaticMarkup(<ErrorPage error={failure('1234567890')} retry={() => {}} />);
  expect(html).toContain(supportReferenceLine('1234567890'));
  expect(html).not.toContain('secret adapter text');
  expect(html).not.toContain('127.0.0.1');
  expect(html).toContain('<main id="main-content"');
  expect(html).toContain('tabindex="-1"');
  expect(html).toMatch(new RegExp(`<button[^>]*>${escapeRe(ERRORS_COPY.error.tryAgain)}</button>`));
});

it('NFR-OBS-05 NFR-AVL-04: the error page says what did not happen, what is safe and what to do, with the reference', () => {
  const html = renderToStaticMarkup(<ErrorPage error={failure('1234567890')} retry={() => {}} />);
  expect(html).toContain(ERRORS_COPY.error.heading);
  expect(html).toContain(errorBody(true, true));
  expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
  // The sentence for a failure in the browser (no reference) is not on this page: the two cases never mix.
  expect(html).not.toContain(errorBody(false, true));
});

it('NFR-OBS-05: Try again calls retry, once, and nothing else on the page is a control', () => {
  const retry = vi.fn();
  const tree = ErrorPage({ error: failure('1234567890'), retry }) as ReactElement;
  const button = find(tree, 'button');
  expect(button).not.toBeNull();
  button?.props.onClick?.();
  expect(retry).toHaveBeenCalledTimes(1);
  expect(find(tree, 'a')).toBeNull();
});

it('NFR-OBS-05: an error with no digest, or a value that is not an Error, gets the words of a failure in the browser, no reference and no error text', () => {
  // Owner default B41: the server-error words would be untrue for a failure that happened in the browser.
  for (const error of [failure(), 'a string was thrown', null, undefined, { message: SECRET, digest: 42 }, failure('has spaces and <b>markup</b>'), failure('x'.repeat(200))]) {
    const html = renderToStaticMarkup(<ErrorPage error={error} retry={() => {}} />);
    expect(html, String(error)).toContain(`<h1>${ERRORS_COPY.error.heading}</h1>`);
    expect(html, String(error)).toContain(errorBody(false, true));
    expect(html, String(error)).not.toContain(errorBody(true, true));
    expect(html, String(error)).not.toContain('Support reference');
    expect(html, String(error)).not.toContain('secret adapter text');
    expect(html, String(error)).not.toContain('<b>');
    expect(html, String(error)).toMatch(new RegExp(`<button[^>]*>${escapeRe(ERRORS_COPY.error.tryAgain)}</button>`));
  }
});

it('NFR-OBS-05 NFR-AVL-04: the global error page is a whole document with the same words, and no error text', () => {
  const html = renderToStaticMarkup(<GlobalError error={failure('1234567890')} retry={() => {}} />);
  expect(html).toMatch(/^<html lang="en"[^>]*>/);
  expect(html).toContain('<body');
  expect(html).toContain('<main id="main-content"');
  expect(html).toContain(supportReferenceLine('1234567890'));
  expect(html).toContain(ERRORS_COPY.error.heading);
  // The document has no layout and so no footer: its sentence does not point at one.
  expect(html).toContain(errorBody(true, false));
  expect(html).not.toContain(errorBody(true, true));
  expect(html).not.toContain('at the bottom of the page');
  expect(html).not.toContain('secret adapter text');
  expect(html).toMatch(new RegExp(`<button[^>]*>${escapeRe(ERRORS_COPY.error.tryAgain)}</button>`));
  expect(html).toMatch(/<title>[^<]+<\/title>/); // a document title, because the root layout's metadata does not apply here
});

it('1A spec 7.5 (WCAG 2.4.2): the error page names itself in the tab, because a failed page has no metadata of its own', () => {
  const html = renderToStaticMarkup(<ErrorPage error={failure('1234567890')} retry={() => {}} />);
  expect(html).toContain(`<title>${pageTitle(ERRORS_COPY.titles.error)}</title>`);
  // The global error document takes its title from ErrorPage alone: exactly one <title>.
  const whole = renderToStaticMarkup(<GlobalError error={failure('1234567890')} retry={() => {}} />);
  expect(whole.match(/<title>/g)).toHaveLength(1);
  expect(whole).toContain(`<title>${pageTitle(ERRORS_COPY.titles.error)}</title>`);
});

it('1A-16c (A 8, 9 and the plan\'s note): the four sentences, word for word, by whether there is a reference and a footer', () => {
  const kept = 'If you were typing a decision or a mitigation, your text is kept in this browser.';
  expect(errorBody(false, true)).toBe(`This page did not load. ${kept} Select Try again. If this keeps happening, contact MAK-AI. Use the Help and contact link at the bottom of the page.`);
  expect(errorBody(false, false)).toBe(`This page did not load. ${kept} Select Try again. If this keeps happening, contact MAK-AI through Help and contact.`);
  expect(errorBody(true, true)).toBe(`Something went wrong on our side. Nothing on this page was changed. ${kept} Wait a minute, then select Try again. If this keeps happening, contact MAK-AI through Help and contact at the bottom of the page. Give them the support reference below.`);
  expect(errorBody(true, false)).toBe(`Something went wrong on our side. Nothing on this page was changed. ${kept} Wait a minute, then select Try again. If this keeps happening, contact MAK-AI through Help and contact. Give them the support reference below.`);
  expect(supportReferenceLine('abc-123')).toBe('Support reference: abc-123');
});

it('1A-16c: "your text is kept in this browser" is true of decisions and mitigations only: the draft store has exactly those two targets', () => {
  const src = readFileSync('lib/client/drafts.ts', 'utf8');
  const union = src.match(/export type DraftTarget =([\s\S]*?)\n\nexport/)?.[1] ?? '';
  expect([...union.matchAll(/kind: '(\w+)'/g)].map((m) => m[1])).toEqual(['question', 'mitigation']);
});

it('1A-16c: the page with a footer shows the footer sentence, and Try again is a native primary button, not the kit\'s', () => {
  const html = renderToStaticMarkup(<ErrorPage error={failure('1234567890')} retry={() => {}} />);
  expect(html).toContain(errorBody(true, true));
  expect(html).toMatch(/<button type="button" class="btn btn--primary">/);
  expect(html).not.toContain('ui-button');
  expect(readFileSync('app/error.tsx', 'utf8')).not.toContain('@/components/ui/Button');
});
