import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import LegalKindPage from '@/app/(public)/legal/[kind]/page';

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
/** The shell's own stylesheet (plan 1A Task 11): the rail, the top bar and its Menu button are drawn there. */
const shellCss = screenCss(readFileSync('components/layout/shell.css', 'utf8'));

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

/** The `property: value` declarations of a rule body. */
function declarationsOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(^|;|\s)([a-z-]+)\s*:\s*([^;]+);/g)) out[m[2]] = m[3].trim();
  return out;
}

/** Names defined inside the `LEGACY ALIASES` block of :root (raw source, the comment marks its start). */
function legacyNames(raw: string): string[] {
  const start = raw.indexOf('/* LEGACY ALIASES');
  if (start === -1) return [];
  const end = raw.indexOf('}', start);
  return Object.keys(declarations(raw.slice(start, end + 1)));
}

/** The colour roles of the plan's token table. Every dark block defines each one. */
const COLOUR_ROLES = [
  'shell', 'shell-ink', 'shell-muted', 'shell-hover', 'action', 'action-hover', 'on-action', 'action-text', 'selected',
  'ground', 'surface', 'tint', 'ink', 'ink-muted', 'heading', 'link', 'border-container', 'border-control',
  'saved', 'saved-tint', 'overdue', 'mark', 'focus',
].map((r) => `--color-${r}`);

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
      // Values of the 1A palette (spec 7.1), as the plan computed them.
      ['#FFFFFF', '#9A4D10', 6.1],
      ['#9A4D10', '#1A1F36', 2.66],
      ['#1B1B1F', '#F2F4F8', 15.59],
      ['#4A5060', '#F2F4F8', 7.31],
      ['#6B7385', '#F2F4F8', 4.32],
      ['#B85F14', '#1A1F36', 3.62],
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

  it('1A NFR-A11Y-05: the 35 colour pairs meet their minimum in light and in both dark blocks', () => {
    // [name, foreground role, background role, minimum ratio]. 4.5 is text, 3 is a non-text mark (WCAG 1.4.3, 1.4.11).
    const pairs: Array<[string, string, string, number]> = [
      ['ink', 'color-ink', 'color-ground', 4.5], ['ink', 'color-ink', 'color-surface', 4.5], ['ink', 'color-ink', 'color-tint', 4.5],
      ['ink-muted', 'color-ink-muted', 'color-ground', 4.5], ['ink-muted', 'color-ink-muted', 'color-surface', 4.5], ['ink-muted', 'color-ink-muted', 'color-tint', 4.5],
      ['link', 'color-link', 'color-ground', 4.5], ['link', 'color-link', 'color-surface', 4.5], ['link', 'color-link', 'color-tint', 4.5],
      ['heading', 'color-heading', 'color-ground', 4.5], ['heading', 'color-heading', 'color-surface', 4.5],
      ['on-action', 'color-on-action', 'color-action', 4.5], ['on-action', 'color-on-action', 'color-action-hover', 4.5],
      ['shell-ink', 'color-shell-ink', 'color-shell', 4.5], ['shell-ink', 'color-shell-ink', 'color-shell-hover', 4.5],
      ['shell-muted', 'color-shell-muted', 'color-shell', 4.5],
      ['action-text', 'color-action-text', 'color-surface', 4.5], ['action-text', 'color-action-text', 'color-ground', 4.5],
      ['saved', 'color-saved', 'color-surface', 4.5], ['saved', 'color-saved', 'color-ground', 4.5], ['saved', 'color-saved', 'color-saved-tint', 4.5],
      ['ink on saved-tint', 'color-ink', 'color-saved-tint', 4.5],
      ['overdue', 'color-overdue', 'color-surface', 4.5], ['overdue', 'color-overdue', 'color-ground', 4.5],
      ['border-control', 'color-border-control', 'color-surface', 3], ['border-control', 'color-border-control', 'color-ground', 3], ['border-control', 'color-border-control', 'color-tint', 3],
      ['mark', 'color-mark', 'color-surface', 3], ['mark', 'color-mark', 'color-ground', 3], ['mark', 'color-mark', 'color-tint', 3],
      ['selected', 'color-selected', 'color-surface', 3],
      ['focus', 'color-focus', 'color-surface', 3], ['focus', 'color-focus', 'color-ground', 3], ['focus', 'color-focus', 'color-shell', 3], ['focus', 'color-focus', 'color-tint', 3],
    ];
    expect(pairs).toHaveLength(35);
    for (const [name, fg, bg, min] of pairs) {
      for (const theme of THEMES) {
        expect(contrast(theme, fg, bg), `${name} (${fg} on ${bg}), ${theme}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('1A: the colour roles of spec 7.1 hold their exact light values', () => {
    const spec: Record<string, string> = {
      '--color-shell': '#1A1F36', '--color-action': '#9A4D10', '--color-ground': '#F2F4F8', '--color-surface': '#FFFFFF',
      '--color-ink': '#1B1B1F', '--color-ink-muted': '#4A5060', '--color-border-container': '#D5DAE3',
      '--color-border-control': '#6B7385', '--color-saved': '#1F7A4D', '--color-overdue': '#B42318',
    };
    for (const [token, hex] of Object.entries(spec)) expect(ROOT[token]?.toUpperCase(), token).toBe(hex);
  });

  it('1A: each dark block defines every colour role and no legacy name', () => {
    const legacy = legacyNames(readFileSync('app/globals.css', 'utf8'));
    expect(legacy.length).toBeGreaterThan(20);
    for (const [label, block] of [['media', DARK_MEDIA], ['attribute', DARK_ATTR]] as const) {
      for (const role of COLOUR_ROLES) expect(block[role], `dark (${label}) defines ${role}`).toBeDefined();
      expect(Object.keys(block).filter((k) => legacy.includes(k)), `dark (${label}) legacy names`).toEqual([]);
    }
  });

  it('1A (usage): the focus ring is drawn with the focus colour and width tokens, on every focusable element', () => {
    const rule = declarationsOf(ruleFor(css, ':focus-visible'));
    expect(rule['outline']).toBe('var(--focus-width) solid var(--color-focus)');
    expect(rule['outline-offset']).toBe('var(--focus-offset)');
  });

  it('1A (usage): the page is drawn on the ground colour in the ink colour', () => {
    const body = declarationsOf(ruleFor(css, 'body'));
    expect(body['background']).toBe('var(--color-ground)');
    expect(body['color']).toBe('var(--color-ink)');
  });

  it('1A (usage): native controls use the page family, and no rule sets the font shorthand on them', () => {
    // A native button, input, select or textarea computes the browser's own family unless a rule says otherwise, so
    // "one family, Overpass" is not true on screen without this. Only the family is inherited: the `font` shorthand
    // would also reset the size of every native control.
    for (const selector of ['button', 'input', 'select', 'textarea']) {
      const rule = declarationsOf(ruleFor(css, selector));
      expect(rule['font-family'], `${selector} font-family`).toBe('inherit');
      expect(rule['font'], `${selector} font shorthand`).toBeUndefined();
    }
  });

  it('1A (usage): no rule paints text with the action colour, which is a fill; text uses --color-action-text', () => {
    const offenders = rules(css)
      .filter((r) => /(?<![-\w])color:\s*var\(--color-action\)/.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(offenders).toEqual([]);
  });

  it('1A: the legacy block is in :root and is marked for deletion', () => {
    expect(readFileSync('app/globals.css', 'utf8')).toContain('/* LEGACY ALIASES: deleted by Task 21 */');
  });

  it('UX-33 NFR-A11Y-05 (legacy, until Task 21): the legacy names the rules still read hold the minimums the SRS 7.6.3 pairs set', () => {
    // The 35 role pairs test the new roles; these tie each old name to a role that was tested.
    const pairs: Array<[string, string, string, number]> = [
      ['D-1 field border', 'form-field-border', 'surface-card', 3],
      ['D-3 link on cards', 'link', 'surface-card', 4.5],
      ['D-3 link on the page', 'link', 'surface-base', 4.5],
      ['D-3 focus ring on cards', 'focus-ring', 'surface-card', 3],
      ['D-3 focus ring on the page', 'focus-ring', 'surface-base', 3],
      ['D-5 stage label', 'stage-fg', 'stage-bg', 4.5],
      ['D-6 moderate text', 'tint-moderate-fg', 'tint-moderate-bg', 4.5],
    ];
    for (const [id, fg, bg, min] of pairs) {
      for (const theme of THEMES) {
        expect(contrast(theme, fg, bg), `${id} (${fg} on ${bg}), ${theme}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('1A: no legacy alias resolves to the overdue red or the saved green, which each mean one thing', () => {
    const legacy = legacyNames(readFileSync('app/globals.css', 'utf8'));
    const valueOf = (theme: Theme, name: string): string | undefined => {
      const tokens = tokensFor(theme);
      let value = tokens[name];
      for (let hops = 0; value !== undefined && hops < 10; hops++) {
        const ref = /^var\((--[\w-]+)\)$/.exec(value);
        if (!ref) break;
        value = tokens[ref[1]];
      }
      return value?.toUpperCase();
    };
    for (const theme of THEMES) {
      const reserved = new Set([valueOf(theme, '--color-overdue'), valueOf(theme, '--color-saved')]);
      expect(reserved.has(undefined)).toBe(false);
      const offenders = legacy.filter((name) => reserved.has(valueOf(theme, name)));
      expect(offenders, `${theme}: legacy names that resolve to overdue or saved`).toEqual([]);
    }
  });

  it('1A: the focus ring is exactly 3 px wide', () => {
    expect(ROOT['--focus-width']).toBe('3px');
  });

  it('1A (usage): a visually-hidden class clips to 1 x 1 px and never uses display:none', () => {
    const rule = declarationsOf(ruleFor(css, '.visually-hidden'));
    expect(rule['clip-path']).toBe('inset(50%)');
    expect(rule['width']).toBe('1px');
    expect(rule['height']).toBe('1px');
    expect(rule['display']).toBeUndefined();
  });

  it('UX-33 NFR-A11Y-05: the Menu button\'s text, shell ink on the shell navy, holds 4.5:1 in every theme', () => {
    for (const theme of THEMES) {
      expect(contrast(theme, 'color-shell-ink', 'color-shell'), `Menu button text, ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('UX-33 1A Task 11: the Menu button draws its text with the shell ink, on the shell navy tested above (components/layout/shell.css)', () => {
    const rule = ruleFor(shellCss, '.shell-topbar__menu-button');
    expect(rule).toMatch(/(?<![-\w])color:\s*var\(--color-shell-ink\)/);
    expect(rule).toMatch(/background-color:\s*var\(--color-shell\)/);
    // No later rule for the button paints it in another colour.
    for (const r of rules(shellCss).filter((x) => x.selectors.some((sel) => sel.startsWith('.shell-topbar__menu-button')))) {
      for (const m of r.body.matchAll(/(?<![-\w])(color|background-color|background):\s*([^;]+);/g)) {
        expect(['var(--color-shell-ink)', 'var(--color-shell)', 'var(--color-shell-hover)'], `${r.selectors.join(', ')} ${m[1]}`).toContain(m[2].trim());
      }
    }
  });

  it('UX-33 (D-1, D-3, D-5): the rules that draw fields, links, the ring and stage labels read the tokens tested above', () => {
    // The .form-group field rules are gone from app/globals.css with their last writer (the stage list's filter, now
    // chips): every field is the kit's, whose border the next case pins. The token keeps its pair in the colour case.
    expect(rules(css).flatMap((r) => r.selectors).filter((s) => s.includes('.form-group'))).toEqual([]);
    expect(ruleFor(css, 'a')).toMatch(/color:\s*var\(--link\)/);
    for (const stage of ['pre', 'in', 'post', 'cross']) {
      const rule = ruleFor(css, `.stage-indicator--${stage}`);
      expect(rule, `.stage-indicator--${stage}`).toMatch(/color:\s*var\(--stage-fg\)/);
      expect(rule, `.stage-indicator--${stage}`).toMatch(/background-color:\s*var\(--stage-bg\)/);
    }
    // 14 pixels at the 16-pixel root: the label was 12 pixels (D-5).
    expect(ruleFor(css, '.stage-indicator')).toMatch(/font-size:\s*var\(--font-size-sm\)/);
  });

  it('UX-33 (D-1, D-2, D-3): the sign-in and reset fields and the links under them follow the same tokens', () => {
    // Found live: the .form-group rules the SRS measured are not the only field rules. The auth pages drew their fields
    // with .auth-card, which had the same faint border and a switched-off ring. Since plan 1A Task 16 the sign-in, reset
    // and change-password fields are the kit's TextInput, so the kit's field rule carries the property: the control
    // border token (3:1, pinned by the colour pairs case above), no outline switched off, and the border following the
    // ring. The .auth-card field rules are gone from app/globals.css, where they would have outranked it.
    const kit = readFileSync('components/ui/TextInput.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ruleFor(kit, '.ui-input')).toMatch(/border:\s*1px solid var\(--color-border-control\)/);
    expect(ruleFor(kit, '.ui-input:focus-visible')).not.toMatch(/outline:\s*none/);
    expect(ruleFor(kit, '.ui-input:focus-visible')).toMatch(/border-color:/);
    for (const type of ['text', 'email', 'password']) {
      expect(css, `${type}: no .auth-card field rule is left to outrank the kit`).not.toContain(`.auth-card input[type="${type}"]`);
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
    // No rule of app/globals.css that names a field switches the ring off (the .form-group rules, which this case read,
    // are gone; the kit's own field rule is read in the sign-in case above).
    const ringOff = rules(css)
      .filter((r) => r.selectors.some((s) => /\b(input|select|textarea)\b/.test(s)) && /outline:\s*none/.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(ringOff).toEqual([]);
    expect(ruleFor(css, 'a')).not.toMatch(/text-decoration:\s*none/);
    for (const selector of ['p a', 'li a', 'td a']) {
      expect(ruleFor(css, selector), selector).toMatch(/text-decoration:\s*underline/);
    }
    // Navigation and buttons are the exception SRS 7.6.3 D-4 names.
    for (const selector of ['.btn']) {
      expect(ruleFor(css, selector), selector).toMatch(/text-decoration:\s*none/);
    }
    // The rail's items are navigation (components/layout/shell.css, plan 1A Task 11).
    expect(ruleFor(shellCss, '.shell-rail__item'), '.shell-rail__item').toMatch(/text-decoration:\s*none/);
    expect(css).not.toMatch(/html\s*\{\s*font-size:\s*14px/);
    expect(ruleFor(css, 'html')).toMatch(/font-size:\s*16px/);
  });
});

// ── D-6 and D-11 live in components, so they are read from what the components render ─────

describe('buttons', () => {
  it('UX-33 NFR-A11Y-05: a hovered secondary button reads the page colour on the text colour, and that pair is at least 4.5:1 in every theme', () => {
    const hover = declarationsOf(ruleFor(css, '.btn--secondary:hover'));
    expect(hover['background-color']).toBe('var(--text-primary)');
    expect(hover['color']).toBe('var(--surface-base)');
    for (const theme of THEMES) {
      expect(contrast(theme, 'surface-base', 'text-primary'), theme).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('component defects', () => {
  // The stale-list notice D-6 was measured on lived in the dead EvidenceAttach (deleted, defect 25); S-06's note is the
  // live element drawn with the same pair.
  it("UX-33 NFR-A11Y-05 (D-6): a tinted note on S-06 (the retired text's) is the kit's Callout, ink on its tint, never the yellow risk colour", async () => {
    const html = renderToStaticMarkup(await LegalKindPage({ params: Promise.resolve({ kind: 'organisation-agreement' }) }));
    // Since plan 1A Task 16 the note is the kit's Callout (ink on the tint panel, Callout.css), kept in a role="note" wrapper.
    const notice = /<div[^>]*role="note"[^>]*>.*?<div class="ui-callout ui-callout--note">/.exec(html)?.[0] ?? '';
    expect(notice).not.toBe('');
    expect(notice).not.toContain('style=');
    expect(html).not.toContain('--color-risk-moderate');
    expect(readFileSync('components/ui/Callout.css', 'utf8')).toMatch(/\.ui-callout\s*\{[^}]*background-color:\s*var\(--color-tint\);[^}]*color:\s*var\(--color-ink\)/);
    for (const theme of THEMES) expect(contrast(theme, 'color-ink', 'color-tint'), `note text on its tint, ${theme}`).toBeGreaterThanOrEqual(4.5);
  });
});
