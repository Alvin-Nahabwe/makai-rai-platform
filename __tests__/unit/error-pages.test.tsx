import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const headersMock = vi.hoisted(() => vi.fn());
const readSessionDeadlinesMock = vi.hoisted(() => vi.fn());
const tryResolveIdentityMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: readSessionDeadlinesMock }));
vi.mock('@/lib/auth/identity', () => ({ tryResolveIdentity: tryResolveIdentityMock }));

import ErrorPage from '@/app/error';
import GlobalError from '@/app/global-error';
import NotFound from '@/app/not-found';
import NotFoundInGroup from '@/app/(authenticated)/not-found';
import NotFoundCard from '@/components/layout/NotFoundCard';
import { ERRORS_COPY, supportReferenceLine } from '@/lib/errors/copy';
import { NOT_FOUND_COPY } from '@/lib/errors/not-found/copy';
import { MAKAI_LOGO } from '@/components/layout/logos';
import { GATE_LOOK } from '@/lib/errors/frame';
import { SHELL_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME, pageTitle } from '@/lib/ui/title';
import { escapeRe } from '../helpers/escapeRe';

/**
 * Plan 1B Task 14 (lane 7 D5): the error page, the last-resort error page and the two not-found pages. The root not-found
 * page is in the gate frame's look, drawn with lib/errors/frame.ts's inline role-token styles on the server, with no
 * stylesheet and no GateFrame: its entry is on every page's first load (the owner's ruling of 15 November, after lane 7's
 * measurement). The error and last-resort pages keep their look until a later release (a listed departure: in a client
 * boundary the same styles would be JavaScript on every page). T14.1: no path, slug or name is echoed, on all three pages.
 * T14.2: the support reference is Next's digest as is, once, on its own line, with no stack and no message.
 */

const SECRET_PATH = '/orgs/secret-org/projects/1/stages/2';
const SECRET_NAME = 'Secret Person';
const signedInIdentity = { userId: 'u1', email: 'secret.person@example.invalid', name: SECRET_NAME, platformRole: 'assessor', mustChangePassword: false };
const failure = (message: string, digest?: string) => Object.assign(new Error(message), digest === undefined ? {} : { digest });
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
const homeLink = new RegExp(`<a[^>]*href="/"[^>]*>${escapeRe(NOT_FOUND_COPY.home)}</a>`);
const signInLink = new RegExp(`<a[^>]*href="/login"[^>]*>${escapeRe(SHELL_COPY.public.signIn)}</a>`);

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  headersMock.mockReset();
  headersMock.mockResolvedValue(new Headers({ 'x-pathname': SECRET_PATH, referer: `https://example.invalid${SECRET_PATH}` }));
  readSessionDeadlinesMock.mockReset();
  readSessionDeadlinesMock.mockResolvedValue(null);
  tryResolveIdentityMock.mockReset();
  tryResolveIdentityMock.mockResolvedValue(null);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

/** The frame around the card: everything from the frame's root to the card's opening tag, and the card's closing tags. */
function frameOf(html: string): string {
  const start = html.indexOf('<div data-gate-look');
  const card = html.indexOf('<div data-gate-card', start);
  expect(start, 'frame root').toBeGreaterThanOrEqual(0);
  expect(card, 'frame card').toBeGreaterThan(start);
  return html.slice(start, html.indexOf('>', card) + 1);
}
const cardTagOf = (html: string) => html.match(/<div data-gate-card[^>]*>/)?.[0] ?? '';

describe('T14.1: neither page echoes the path, a slug or a name', () => {
  it('the root not-found page, signed in and signed out, holds nothing of the address or the person', async () => {
    for (const identity of [null, signedInIdentity]) {
      tryResolveIdentityMock.mockResolvedValue(identity);
      const html = renderToStaticMarkup(await NotFound());
      expect(html).toContain(NOT_FOUND_COPY.body);
      expect(html).not.toMatch(/secret-org|secret\.person|Secret Person|example\.invalid|stages\/2/);
    }
  });

  it('the signed-in group not-found page holds nothing of the address or the person', () => {
    const html = renderToStaticMarkup(<NotFoundInGroup />);
    expect(html).toContain(NOT_FOUND_COPY.body);
    expect(html).not.toMatch(/secret-org|Secret Person/);
  });

  it('the error page shows no part of a message that names the address or a person', () => {
    const html = renderToStaticMarkup(<ErrorPage error={failure(`render failed for ${SECRET_PATH} (${SECRET_NAME})`, 'abc123')} retry={() => {}} />);
    expect(html).not.toMatch(/secret-org|Secret Person|render failed/);
  });

  it('the error page reads no identity: no name, no Sign out, no idle warning (ruling 2)', () => {
    const src = stripComments(readFileSync('app/error.tsx', 'utf8'));
    for (const reader of ['@/lib/auth', 'tryResolveIdentity', 'useSession', 'IdleWarning', 'GateSignOut', 'signOut', 'headers(', 'cookies(', 'usePathname', 'useParams', 'useSearchParams']) {
      expect(src, reader).not.toContain(reader);
    }
    const html = renderToStaticMarkup(<ErrorPage error={failure('x', 'abc123')} retry={() => {}} />);
    expect(html).not.toContain(SHELL_COPY.signOut);
    expect(html).not.toContain('<dialog');
  });
});

describe('T14.2: the support reference is the digest as is, once, on its own line', () => {
  it('the digest appears exactly once, alone in its own paragraph, and no stack or message is shown', () => {
    const error = failure('secret adapter text 127.0.0.1:5441', 'd1g3st-REF_42');
    const html = renderToStaticMarkup(<ErrorPage error={error} retry={() => {}} />);
    expect(html.split('d1g3st-REF_42')).toHaveLength(2);
    expect(html).toMatch(new RegExp(`<p[^>]*>${escapeRe(supportReferenceLine('d1g3st-REF_42'))}</p>`));
    expect(html).not.toContain('secret adapter text');
    expect(html).not.toContain(String(error.stack).split('\n')[1]?.trim() ?? 'at ');
  });

  it('the last-resort page shows it once too, and its tab title is the error title', () => {
    const html = renderToStaticMarkup(<GlobalError error={failure('boom', 'd1g3st-REF_42')} retry={() => {}} />);
    expect(html.split('d1g3st-REF_42')).toHaveLength(2);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${pageTitle(ERRORS_COPY.titles.error)}</title>`);
  });
});

describe('NotFoundCard({ signedIn })', () => {
  it('signed in, the action is the home page link; signed out, it is Sign in', () => {
    const inside = renderToStaticMarkup(<NotFoundCard signedIn />);
    expect(inside).toMatch(homeLink);
    expect(inside).not.toMatch(signInLink);
    const outside = renderToStaticMarkup(<NotFoundCard signedIn={false} />);
    expect(outside).toMatch(signInLink);
    expect(outside).not.toMatch(homeLink);
  });

  it('the root not-found page takes signedIn from the identity read, and the group page is always signed in', async () => {
    tryResolveIdentityMock.mockResolvedValue(null);
    expect(renderToStaticMarkup(await NotFound())).toMatch(signInLink);
    tryResolveIdentityMock.mockResolvedValue(signedInIdentity);
    expect(renderToStaticMarkup(await NotFound())).toMatch(homeLink);
    expect(tryResolveIdentityMock).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(<NotFoundInGroup />)).toMatch(homeLink);
  });

  it('the card is drawn from role tokens, not the old auth card', () => {
    for (const html of [renderToStaticMarkup(<NotFoundCard signedIn />), renderToStaticMarkup(<NotFoundInGroup />)]) {
      expect(html).not.toMatch(/auth-card|auth-container|auth-footer/);
      expect(cardTagOf(html)).toContain('var(--color-surface)');
    }
  });
});

describe('the gate frame look on the root pages', () => {
  it('the root not-found page sits in the frame inside its own main, with the platform name, signed in and out', async () => {
    for (const identity of [null, signedInIdentity]) {
      tryResolveIdentityMock.mockResolvedValue(identity);
      const html = renderToStaticMarkup(await NotFound());
      expect(html).toMatch(/<main id="main-content" tabindex="-1"><div data-gate-look/);
      expect(frameOf(html)).toContain(`>${PRODUCT_NAME}</p>`);
      expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
      expect(html.match(/<main/g)).toHaveLength(1);
      expect(html).not.toContain('public-layout');
    }
  });

  it('drift guard: the root page, NotFoundCard and the group page draw the same card from lib/errors/frame.ts', async () => {
    const root = renderToStaticMarkup(await NotFound());
    const card = cardTagOf(renderToStaticMarkup(<NotFoundCard signedIn={false} />));
    expect(card).toContain('style="');
    expect(cardTagOf(root)).toBe(card);
    expect(cardTagOf(renderToStaticMarkup(<NotFoundInGroup />))).toBe(card);
    for (const file of ['app/not-found.tsx', 'components/layout/NotFoundCard.tsx']) {
      expect(readFileSync(file, 'utf8'), file).toContain("from '@/lib/errors/frame'");
    }
  });

  it('the group not-found page has no frame, no main and no dialog of its own (the shell has them)', () => {
    const html = renderToStaticMarkup(<NotFoundInGroup />);
    expect(html).not.toMatch(/data-gate-look|<main|<dialog|id="main-content"/);
  });

  it('drift guard: the column draws the MAK-AI logo as GateFrame does, decorative, above the name, not a link', async () => {
    const html = renderToStaticMarkup(await NotFound());
    const img = frameOf(html).match(/<img [^>]*>/)?.[0] ?? '';
    expect(img).toContain(`src="${MAKAI_LOGO.src}"`);
    expect(img).toContain(`srcSet="${MAKAI_LOGO.srcSet}"`);
    expect(img).toContain(`width="${MAKAI_LOGO.width}"`);
    expect(img).toContain(`height="${MAKAI_LOGO.height}"`);
    expect(img).toContain('alt=""');
    expect(img).toContain('decoding="async"');
    expect(frameOf(html)).toMatch(new RegExp(`<img [^>]*/><p [^>]*>${escapeRe(PRODUCT_NAME)}</p>`));
    expect(frameOf(html)).not.toContain('<a ');
    // .gate__logo in gate.css: a block with var(--space-1) under it.
    const css = readFileSync('components/layout/gate.css', 'utf8');
    const rule = css.match(/\.gate__logo \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*block;/);
    expect(GATE_LOOK.logo).toEqual({ display: 'block', marginBlockEnd: rule.match(/margin-block-end:\s*([^;]+);/)?.[1] });
  });

  it("drift guard: the heading steps at gate.css's container widths (h2 below 24rem, h3 below 12rem)", () => {
    const css = readFileSync('components/layout/gate.css', 'utf8');
    const steps = [...css.matchAll(/@container \(width < ([\d.]+)rem\)\s*\{\s*\.gate__card h1 \{\s*font-size: var\((--font-size-h\d)\);/g)].map((m) => [Number(m[1]), m[2]]);
    expect(steps).toEqual([[24, '--font-size-h2'], [12, '--font-size-h3']]);
    const size = String(GATE_LOOK.heading.fontSize);
    for (const [width] of steps) expect(size).toContain(`(100cqi - ${(Number(width) - 0.01).toFixed(2)}rem)*99999`);
    expect(size).toBe('clamp(clamp(var(--font-size-h3),(100cqi - 11.99rem)*99999,var(--font-size-h2)),(100cqi - 23.99rem)*99999,var(--font-size-h1))');
  });

  it("drift guard: the card, the main area, the product name and the band copy gate.css's values, and the 1024 px and 320 px switches", () => {
    // The frame's rules live in two sheets since lane 5's lean S-04 build (319b9b0a): the public one and
    // gate-signed-in.css, which holds .gate__product. Read both, in the order GateFrame imports them.
    const css = (readFileSync('components/layout/gate.css', 'utf8') + '\n' + readFileSync('components/layout/gate-signed-in.css', 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Split the sheet into its top level and its at-rule blocks (brace matching; no at-rule here nests another).
    const blocks: Record<string, string> = {};
    let top = '';
    for (let i = 0; i < css.length; ) {
      const at = css.indexOf('@', i);
      const stop = at < 0 ? css.length : at;
      top += css.slice(i, stop);
      if (at < 0) break;
      const open = css.indexOf('{', at);
      let depth = 1;
      let j = open + 1;
      for (; depth > 0; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0;
      const key = css.slice(at, open).trim();
      blocks[key] = (blocks[key] ?? '') + css.slice(open + 1, j - 1);   // the same at-rule in both sheets: join them
      i = j;
    }
    const wideKey = Object.keys(blocks).find((k) => /^@media \(min-width: [\d.]+px\)$/.test(k)) ?? '';
    const WIDE = blocks[wideKey];
    const SMALL_BLOCK = blocks['@media (max-width: 19.98rem)'];
    expect(WIDE, 'the 1024 px switch').toBeDefined();
    expect(SMALL_BLOCK, 'the 320 px switch').toBeDefined();
    const narrowEnd = Object.keys(blocks).find((k) => /^@media \(max-width: [\d.]+px\)$/.test(k)) ?? '';
    const decls = (scope: string, selector: string) => {
      const rule = [...scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector);
      expect(rule, `${selector} in its scope`).toBeDefined();
      return Object.fromEntries(
        (rule?.[2] ?? '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
      ) as Record<string, string>;
    };
    const zero = (v: string) => (v === '0' ? '0px' : v);
    const pair = (v: string): [string, string] => {
      const [a, b = a] = v.split(/\s+(?![^()]*\))/);
      return [a, b];
    };
    const up = (narrow: string, wide: string, at: string) => `clamp(${narrow},(100vw - ${at})*99999,${wide})`;
    const down = (narrow: string, wide: string) => `clamp(${wide},(${px1023} - 100vw)*99999,${narrow})`;
    const switchPx = Number(/min-width: ([\d.]+)px/.exec(wideKey)?.[1]);
    const px1023 = `${(switchPx - 0.02).toFixed(2)}px`;
    const SMALL = /max-width: ([\d.]+rem)/.exec(Object.keys(blocks).find((k) => k.includes('19.98rem')) ?? '')?.[1] ?? '';
    const UP = (narrow: string, wide: string, at = px1023) => up(narrow, wide, at);
    expect(narrowEnd, 'the band below the switch').toBe(`@media (max-width: ${px1023})`);
    expect(SMALL).not.toBe('');

    const card = decls(top, '.gate__card');
    const cardWide = decls(WIDE, '.gate__card');
    const cardSmall = decls(SMALL_BLOCK, '.gate__card');
    const [cardPadBlock, cardPadInline] = pair(card.padding);
    expect(GATE_LOOK.card.maxInlineSize).toBe(`max(${card['max-inline-size']},(${px1023} - 100vw)*99999)`);
    expect(GATE_LOOK.card.paddingBlock).toBe(UP(cardPadBlock, pair(cardWide.padding)[0]));
    expect(GATE_LOOK.card.paddingInline).toBe(UP(UP(cardSmall['padding-inline'], cardPadInline, SMALL), pair(cardWide.padding)[1]));
    expect(GATE_LOOK.card.backgroundColor).toBe(card['background-color']);
    const [edgeWidth, ...edgeRest] = card.border.split(/\s+(?![^()]*\))/);
    const edge = edgeRest.join(' ');
    expect(GATE_LOOK.card.borderBlock).toBe(`${edgeWidth} ${edge}`);
    expect(GATE_LOOK.card.borderInline).toBe(`${UP(zero(cardSmall['border-inline']), edgeWidth, SMALL)} ${edge}`);
    expect(GATE_LOOK.card.borderRadius).toBe(UP(zero(cardSmall['border-radius']), card['border-radius'], SMALL));

    const main = decls(top, '.gate__main');
    const mainWide = decls(WIDE, '.gate__main');
    const mainSmall = decls(SMALL_BLOCK, '.gate__main');
    expect(GATE_LOOK.area.paddingBlock).toBe(UP(main.padding, mainWide.padding));
    expect(GATE_LOOK.area.paddingInline).toBe(UP(UP(zero(mainSmall['padding-inline']), main.padding, SMALL), mainWide.padding));

    const product = decls(top, '.gate__product');
    expect(GATE_LOOK.product).toMatchObject({ color: product.color, fontSize: product['font-size'], fontWeight: product['font-weight'] });

    const header = decls(top, '.gate__header');
    const headerWide = decls(WIDE, '.gate__header');
    expect(GATE_LOOK.column.backgroundColor).toBe(header['background-color']);
    expect(GATE_LOOK.column.color).toBe(header.color);
    const [bandWidth, ...bandEdge] = header['border-block-end'].split(/\s+(?![^()]*\))/);
    const [colWidth, ...colEdge] = headerWide['border-inline-end'].split(/\s+(?![^()]*\))/);
    expect(bandEdge.join(' ')).toBe(colEdge.join(' '));
    expect(GATE_LOOK.column.borderBlockEnd).toBe(`${down(bandWidth, zero(headerWide['border-block-end']))} ${bandEdge.join(' ')}`);
    expect(GATE_LOOK.column.borderInlineEnd).toBe(`${UP('0px', colWidth)} ${colEdge.join(' ')}`);
  });

  it('no stylesheet and no GateFrame: the root not-found page, the card and the frame styles import no CSS and nothing of the gate frame', () => {
    for (const file of ['app/not-found.tsx', 'components/layout/NotFoundCard.tsx', 'lib/errors/frame.ts']) {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(src, file).not.toMatch(/import\s+['"][^'"]+\.css['"]/);
      expect(src, file).not.toMatch(/GateFrame|layout\/gate|GateSignOut/);
    }
  });

  it('colours are role tokens: no literal colour in the root not-found page, the card or the frame styles', () => {
    for (const file of ['app/not-found.tsx', 'components/layout/NotFoundCard.tsx', 'lib/errors/frame.ts']) {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|navy)\b/);
    }
    expect(stripComments(readFileSync('lib/errors/frame.ts', 'utf8'))).toContain('var(--color-');
  });

  it('every token the frame styles read is defined in app/globals.css', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const used = new Set([...stripComments(readFileSync('lib/errors/frame.ts', 'utf8')).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(root, name).toMatch(new RegExp(`${escapeRe(name)}:`));
  });
});
