import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import ErrorPage from '../../app/error';
import GlobalError from '../../app/global-error';

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
  expect(html).toContain('Support reference: 1234567890');
  expect(html).not.toContain('secret adapter text');
  expect(html).not.toContain('127.0.0.1');
  expect(html).toContain('<main id="main-content"');
  expect(html).toContain('tabindex="-1"');
  expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
});

it('NFR-OBS-05 NFR-AVL-04: the error page says what did not happen, what is safe and what to do, with the reference', () => {
  const html = renderToStaticMarkup(<ErrorPage error={failure('1234567890')} retry={() => {}} />);
  expect(html).toContain('This page could not be loaded');
  expect(html).toContain(
    'The server had a problem, so nothing on this page was changed. Answers you typed on this device are kept. Try again in a minute. If it keeps happening, write to MAK-AI through Help and contact and give this support reference: 1234567890.',
  );
  expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
  // The sentence for a failure in the browser (no reference) is not on this page: the two cases never mix.
  expect(html).not.toContain('Something went wrong while showing this page');
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
    expect(html, String(error)).toContain('<h1>This page could not be loaded</h1>');
    expect(html, String(error)).toContain(
      'Something went wrong while showing this page. Answers you typed on this device are kept. Try again. If it keeps happening, write to MAK-AI through Help and contact.',
    );
    expect(html, String(error)).not.toContain('The server had a problem');
    expect(html, String(error)).not.toContain('nothing on this page was changed');
    expect(html, String(error)).not.toContain('Support reference');
    expect(html, String(error)).not.toContain('give this support reference');
    expect(html, String(error)).not.toContain('secret adapter text');
    expect(html, String(error)).not.toContain('<b>');
    expect(html, String(error)).toMatch(/<button[^>]*>Try again<\/button>/);
  }
});

it('NFR-OBS-05 NFR-AVL-04: the global error page is a whole document with the same words, and no error text', () => {
  const html = renderToStaticMarkup(<GlobalError error={failure('1234567890')} retry={() => {}} />);
  expect(html).toMatch(/^<html lang="en"[^>]*>/);
  expect(html).toContain('<body');
  expect(html).toContain('<main id="main-content"');
  expect(html).toContain('Support reference: 1234567890');
  expect(html).toContain('This page could not be loaded');
  expect(html).not.toContain('secret adapter text');
  expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
  expect(html).toMatch(/<title>[^<]+<\/title>/); // a document title, because the root layout's metadata does not apply here
});
