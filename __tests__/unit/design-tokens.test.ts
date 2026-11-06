import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceAttach, type EvidenceAttachProps } from '@/components/evidence/EvidenceAttach';

/**
 * UX-33 / NFR-A11Y-05 (SRS 7.6.3 D-1 to D-7, D-11). Each token pair the SRS
 * measured is computed from app/globals.css with the WCAG relative-luminance
 * formula and held to its minimum in the light theme and in BOTH dark blocks
 * (the `prefers-color-scheme` block and the explicit `[data-theme='dark']`
 * block). A ratio alone does not prove the page looks right: the same file's
 * rules must also USE the tokens under test, so each ratio test is paired with
 * a usage assertion (AGENTS.md section 2, the row on recording an obligation
 * as discharged).
 */

/**
 * The screen rules only: comments are stripped, and `@media print { ... }` is cut out, because the
 * print stylesheet legitimately drops link underlines and colours (UX-33 is about the screen).
 * Cutting it by brace depth, not by regular expression, keeps a nested rule from ending it early.
 */
function screenCss(source: string): string {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = noComments.indexOf('@media print');
  if (start === -1) return noComments;
  let depth = 0;
  for (let i = noComments.indexOf('{', start); i < noComments.length; i++) {
    if (noComments[i] === '{') depth++;
    if (noComments[i] === '}' && --depth === 0) return screenCss(noComments.slice(0, start) + noComments.slice(i + 1));
  }
  throw new Error('unbalanced braces after @media print');
}

const css = screenCss(readFileSync('app/globals.css', 'utf8'));

// ── minimal CSS reading ─────────────────────────────────────────────────

/** Every innermost `selector { declarations }` rule, selector list split on commas. */
function rules(source: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  }
  return out;
}

/** The declarations of every rule whose selector list contains `selector`, joined. */
function ruleFor(source: string, selector: string): string {
  return rules(source)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join('\n');
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = declarations(ruleFor(css, ':root'));
const DARK_MEDIA = declarations(ruleFor(css, ":root:not([data-theme='light'])"));
const DARK_ATTR = declarations(ruleFor(css, ":root[data-theme='dark']"));

type Theme = 'light' | 'dark (media)' | 'dark (attribute)';
const THEMES: Theme[] = ['light', 'dark (media)', 'dark (attribute)'];

function tokensFor(theme: Theme): Record<string, string> {
  if (theme === 'light') return ROOT;
  return { ...ROOT, ...(theme === 'dark (media)' ? DARK_MEDIA : DARK_ATTR) };
}

function resolveHex(theme: Theme, token: string): string {
  const tokens = tokensFor(theme);
  let value = tokens[token.startsWith('--') ? token : `--${token}`];
  for (let hops = 0; value !== undefined && hops < 10; hops++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = tokens[ref[1]];
  }
  if (value === undefined || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${theme}: ${token} does not resolve to a #rrggbb value (got ${value})`);
  }
  return value.toUpperCase();
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrastOfHex(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(theme: Theme, fg: string, bg: string): number {
  return contrastOfHex(resolveHex(theme, fg), resolveHex(theme, bg));
}

// ── the formula reproduces SRS 7.6.3's measured figures ────────────────

describe('contrast function (helper)', () => {
  it('UX-33 (helper): reproduces the ratios SRS 7.6.3 measured', () => {
    const cases: Array<[string, string, number]> = [
      ['#D1D5DB', '#FFFFFF', 1.47],
      ['#767C88', '#FFFFFF', 4.19],
      ['#3B4358', '#1A1F2E', 1.66],
      ['#7A8396', '#1A1F2E', 4.31],
      ['#9A4D10', '#FFF5EB', 5.67],
      ['#E8935A', '#2A1C0E', 6.89],
      ['#A16207', '#FEF9C3', 4.58],
      ['#FACC15', '#FFFFFF', 1.53],
      ['#9A4D10', '#414042', 1.69],
    ];
    for (const [fg, bg, expected] of cases) {
      expect(Number(contrastOfHex(fg, bg).toFixed(2)), `${fg} on ${bg}`).toBe(expected);
    }
  });
});

// ── the token pairs ────────────────────────────────────────────────────

describe('design tokens', () => {
  it('UX-33 NFR-A11Y-05: the dark theme has one set of values in both of its blocks', () => {
    // The two blocks are written out twice in the file; a fix made in one and not the other
    // would pass every ratio below for whichever theme the test happened to read.
    expect(Object.keys(DARK_MEDIA).length).toBeGreaterThan(0);
    expect(DARK_ATTR).toEqual(DARK_MEDIA);
  });

  it('UX-33 NFR-A11Y-05: every 7.6.3 token pair meets its minimum in every theme', () => {
    // [defect, tokens read as foreground and background, minimum ratio, themes]
    const pairs: Array<[string, string, string, number, Theme[]]> = [
      ['D-1 field border', 'form-field-border', 'surface-card', 3, THEMES],
      ['D-3 link on cards', 'link', 'surface-card', 4.5, THEMES],
      ['D-3 link on the page', 'link', 'surface-base', 4.5, THEMES],
      ['D-3 focus ring on cards', 'focus-ring', 'surface-card', 3, THEMES],
      ['D-3 focus ring on the page', 'focus-ring', 'surface-base', 3, THEMES],
      ['D-5 stage label', 'stage-fg', 'stage-bg', 4.5, THEMES],
      ['D-6 moderate text', 'tint-moderate-fg', 'tint-moderate-bg', 4.5, THEMES],
    ];
    for (const [id, fg, bg, min, themes] of pairs) {
      for (const theme of themes) {
        expect(contrast(theme, fg, bg), `${id} (${fg} on ${bg}), ${theme}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('UX-33 (D-1, D-3, D-5): the rules that draw fields, links, the ring and stage labels read the tokens tested above', () => {
    expect(ruleFor(css, '.form-group input')).toMatch(/border:\s*1px solid var\(--form-field-border\)/);
    expect(ruleFor(css, 'a')).toMatch(/color:\s*var\(--link\)/);
    expect(ruleFor(css, '*:focus-visible')).toMatch(/outline:\s*3px solid var\(--focus-ring\)/);
    expect(ruleFor(css, 'button:focus-visible')).toMatch(/outline:\s*3px solid var\(--focus-ring\)/);
    for (const stage of ['pre', 'in', 'post', 'cross']) {
      const rule = ruleFor(css, `.stage-indicator--${stage}`);
      expect(rule, `.stage-indicator--${stage}`).toMatch(/color:\s*var\(--stage-fg\)/);
      expect(rule, `.stage-indicator--${stage}`).toMatch(/background-color:\s*var\(--stage-bg\)/);
    }
    // 14 pixels at the 16-pixel root: the label was 12 pixels (D-5).
    expect(ruleFor(css, '.stage-indicator')).toMatch(/font-size:\s*var\(--font-size-sm\)/);
  });

  it('UX-33 (D-1, D-2, D-3): the sign-in and reset fields and the links under them follow the same tokens', () => {
    // Found live: the .form-group rules the SRS measured are not the only field rules. The auth
    // pages draw their fields with .auth-card, which had the same faint border, the same switched-off
    // ring and a dark-theme link at 2.69:1. The Email field of /login is the field the e2e focus check uses.
    for (const type of ['text', 'email', 'password']) {
      expect(ruleFor(css, `.auth-card input[type="${type}"]`), type).toMatch(/border:\s*1px solid var\(--form-field-border\)/);
      const focus = ruleFor(css, `.auth-card input[type="${type}"]:focus`);
      expect(focus, `${type} focus`).not.toMatch(/outline:\s*none/);
      expect(focus, `${type} focus`).toMatch(/border-color:\s*var\(--focus-ring\)/);
    }
    expect(ruleFor(css, '.auth-footer a')).toMatch(/color:\s*var\(--link\)/);
  });

  it('UX-33 NFR-A11Y-05 (D-3): no rule paints text with --color-primary, which is 2.69:1 on dark cards; text uses --link', () => {
    // --color-primary stays for backgrounds and borders (a white label on it is fine in both themes).
    const offenders = rules(css)
      .filter((r) => /(?<![-\w])color:\s*var\(--color-primary\)/.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(offenders).toEqual([]);
  });

  it('UX-33 (D-2, D-4, D-7): the focus ring stays on form fields, links in running text are underlined, the root font stays 16 pixels', () => {
    expect(ruleFor(css, '.form-group input:focus')).not.toMatch(/outline:\s*none/);
    expect(ruleFor(css, '.form-group select:focus')).not.toMatch(/outline:\s*none/);
    expect(ruleFor(css, '.form-group textarea:focus')).not.toMatch(/outline:\s*none/);
    expect(ruleFor(css, 'a')).not.toMatch(/text-decoration:\s*none/);
    for (const selector of ['p a', 'li a', 'td a']) {
      expect(ruleFor(css, selector), selector).toMatch(/text-decoration:\s*underline/);
    }
    // Navigation and buttons are the exception SRS 7.6.3 D-4 names.
    for (const selector of ['.sidebar-link', '.btn', '.btn-primary']) {
      expect(ruleFor(css, selector), selector).toMatch(/text-decoration:\s*none/);
    }
    expect(css).not.toMatch(/html\s*\{\s*font-size:\s*14px/);
    expect(ruleFor(css, 'html')).toMatch(/font-size:\s*16px/);
  });
});

// ── D-6 and D-11 live in components, so they are read from what the components render ─────

const evidenceProps: EvidenceAttachProps = {
  questionId: 'Q-PP-01',
  orgSlug: 'org-a',
  items: [],
  loading: false,
  loadError: false,
  stale: true,
  canCreate: true,
  canDelete: true,
  busy: false,
  error: null,
  onUpload: () => {},
  onDelete: () => {},
};

describe('component defects', () => {
  it('UX-33 NFR-A11Y-05 (D-6): the stale-list notice is moderate-tint text on its tint, never the yellow risk colour', () => {
    const html = renderToStaticMarkup(createElement(EvidenceAttach, evidenceProps));
    const notice = /<p[^>]*role="status"[^>]*>/.exec(html)?.[0] ?? '';
    expect(notice).not.toBe('');
    expect(notice).toContain('color:var(--tint-moderate-fg)');
    expect(notice).toContain('var(--tint-moderate-bg)');
    expect(notice).not.toContain('--color-risk-moderate');
  });
});
