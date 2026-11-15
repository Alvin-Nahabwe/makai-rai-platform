import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const pathnameMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ usePathname: () => pathnameMock() }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import AppShell from '@/components/layout/AppShell';
import Rail from '@/components/layout/Rail';
import TopBar from '@/components/layout/TopBar';
import Footer from '@/components/layout/Footer';
import { ShellProjectSlot, RailProjectBlock, BarProjectContext } from '@/components/layout/ShellProject';
import { SHELL_PROJECT_COPY, stageStateLine } from '@/lib/shell/project/copy';
import { SHELL_COPY } from '@/lib/shell/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { readCreditLine } from '@/lib/credit';
import type { ShellData, ShellProject } from '@/lib/shell/types';

/**
 * Stage 1 "Route", lane 3 task 1: the rail's logo and project block (owner ruling R4), the narrow top bar's project context
 * and the footer with the MAK-AI and DSWB logos. Rendered on the server, as the first HTML is (S1).
 */

const shell: ShellData = {
  userId: 'u1', userName: 'A', platformLabel: null, roleLabels: { a: 'Assessor' },
  orgs: [{ slug: 'a', name: 'Alpha Lab' }], homeSlug: 'a',
};
const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const project: ShellProject = {
  id: ID, name: 'Antenatal Risk Triage Model',
  stages: [
    { stage: 'pre-processing', questions: 22, noDecision: 3 },
    { stage: 'in-processing', questions: 19, noDecision: 19 },
    { stage: 'post-processing', questions: 15, noDecision: 0 },
  ],
};

const at = (pathname: string) => pathnameMock.mockReturnValue(pathname);
const stripTags = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const linksOf = (html: string) => [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: stripTags(m[2]) }));
const slot = (stage: ShellProject['stages'][number]['stage'] | null) =>
  <ShellProjectSlot project={project} orgSlug="a" currentStage={stage} />;

beforeEach(() => pathnameMock.mockReset());

describe('the stage state lines (R4; spec 5 principle 7)', () => {
  it('R4: the stage in the address says "You are here" with its question count', () => {
    expect(stageStateLine({ stage: 'pre-processing', questions: 22, noDecision: 3 }, true)).toBe('You are here · 22 questions');
  });

  it('R4: another stage with no saved decision is "Not started"', () => {
    expect(stageStateLine({ stage: 'in-processing', questions: 19, noDecision: 19 }, false)).toBe('Not started');
  });

  it('R4: a started stage gives its questions and those with no decision yet, or only its questions when none is open', () => {
    expect(stageStateLine({ stage: 'pre-processing', questions: 22, noDecision: 3 }, false)).toBe('22 questions · 3 no decision yet');
    expect(stageStateLine({ stage: 'post-processing', questions: 15, noDecision: 0 }, false)).toBe('15 questions');
    expect(stageStateLine({ stage: 'post-processing', questions: 1, noDecision: 0 }, true)).toBe('You are here · 1 question');
  });

  it('spec 5 principle 7: no line is a percentage, a fill or a total across stages', () => {
    for (const s of project.stages) for (const current of [true, false]) expect(stageStateLine(s, current)).not.toMatch(/%|of \d|total/i);
  });
});

describe('the rail project block (R4)', () => {
  it('R4: the project name links to the project page, then the existing stage sentence, then the three stages in order', () => {
    const html = renderToStaticMarkup(<RailProjectBlock project={project} orgSlug="a" currentStage="pre-processing" />);
    const links = linksOf(html);
    expect(links.map((l) => l.text)).toEqual([
      'Antenatal Risk Triage Model',
      'Pre-processing You are here · 22 questions',
      'In-processing Not started',
      'Post-processing 15 questions',
    ]);
    expect(links[0].attrs).toContain(`href="/orgs/a/projects/${ID}"`);
    expect(links.slice(1).map((l) => /href="([^"]+)"/.exec(l.attrs)![1])).toEqual(
      ['pre-processing', 'in-processing', 'post-processing'].map((s) => `/orgs/a/projects/${ID}/stages/${s}`));
    // Fix round 4 (lead's ruling, rail fit): the stage sentence stays on the project page and leaves the rail's block.
    expect(stripTags(html)).not.toContain(PROJECT_COPY.overview.anyOrder);
    expect(html).not.toContain('shell-project__lead');
    expect(html).not.toContain('%');
  });

  it('R4: only the stage in the address carries aria-current="location" and the current class', () => {
    const html = renderToStaticMarkup(<RailProjectBlock project={project} orgSlug="a" currentStage="in-processing" />);
    const current = linksOf(html).filter((l) => l.attrs.includes('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0].attrs).toContain('aria-current="location"');
    expect(current[0].text).toBe('In-processing You are here · 19 questions');
    expect(html).not.toContain('aria-current="page"');
    expect([...html.matchAll(/shell-project__stage--current/g)]).toHaveLength(1);
  });

  it('R4: on a project-level page no stage is "You are here"; each shows its own line', () => {
    const html = renderToStaticMarkup(<RailProjectBlock project={project} orgSlug="a" currentStage={null} />);
    expect(html).not.toContain('aria-current');
    expect(stripTags(html)).not.toContain('You are here');
    expect(linksOf(html).slice(1).map((l) => l.text)).toEqual([
      'Pre-processing 22 questions · 3 no decision yet', 'In-processing Not started', 'Post-processing 15 questions',
    ]);
  });

  it('R4: the stage list is named by the project, and its line marks are hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<RailProjectBlock project={project} orgSlug="a" currentStage="pre-processing" />);
    const label = /<ul [^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(label).toBeTruthy();
    expect(html).toContain(`id="${label}"`);
    for (const svg of html.matchAll(/<svg[^>]*>/g)) expect(svg[0]).toContain('aria-hidden="true"');
  });
});

describe('the narrow top bar\'s project context', () => {
  it('a stage in the address: the stage, the project under it, and "All questions" to that stage\'s list', () => {
    const html = renderToStaticMarkup(<BarProjectContext project={project} orgSlug="a" currentStage="pre-processing" />);
    expect(stripTags(html)).toBe('Pre-processing Antenatal Risk Triage Model All questions');
    const all = linksOf(html).find((l) => l.text === SHELL_PROJECT_COPY.allQuestions);
    expect(all?.attrs).toContain(`href="/orgs/a/projects/${ID}/stages/pre-processing"`);
    expect(SHELL_PROJECT_COPY.allQuestions).toBe('All questions');
  });

  it('a project-level page: only the project name, and no "All questions"', () => {
    const html = renderToStaticMarkup(<BarProjectContext project={project} orgSlug="a" currentStage={null} />);
    expect(stripTags(html)).toBe('Antenatal Risk Triage Model');
    expect(html).not.toContain('All questions');
  });

  it('the project name is whole in the markup (the ellipsis is CSS), so the accessible name keeps it', () => {
    const long = { ...project, name: 'A very long project name that will not fit beside the Menu button at 320 pixels' };
    const html = renderToStaticMarkup(<BarProjectContext project={long} orgSlug="a" currentStage="pre-processing" />);
    expect(stripTags(html)).toContain(long.name);
    expect(readFileSync('components/layout/shell.css', 'utf8')).toMatch(/\.shell-bar-project__name \{[^}]*text-overflow: ellipsis;/);
  });
});

describe('the shell places the project slot: the rail block in the rail, the context in the bar', () => {
  it('R4: with no project slot the rail has no block and the bar no context', () => {
    at('/orgs/a/dashboard');
    const html = renderToStaticMarkup(<AppShell shell={shell}><p>page</p></AppShell>);
    expect(html).not.toContain('shell-project');
    expect(html).not.toContain('shell-bar-project');
  });

  it('R4: a slot is rendered once as the rail block inside the rail\'s nav, and once as the bar context inside the header', () => {
    at(`/orgs/a/projects/${ID}/stages/pre-processing`);
    const html = renderToStaticMarkup(<AppShell shell={shell} project={slot('pre-processing')}><p>page</p></AppShell>);
    const header = /<header class="shell-topbar">([\s\S]*?)<\/header>/.exec(html)![1];
    const nav = /<nav class="shell-rail"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    expect(header).toContain('shell-bar-project');
    expect(header).not.toContain('class="shell-project"');
    expect(nav).toContain('class="shell-project"');
    expect(nav).not.toContain('shell-bar-project');
    // Still exactly one navigation landmark (L2-44).
    expect([...html.matchAll(/<nav\b/g)]).toHaveLength(1);
    // The block follows the rail's main items, before the lower group (the sketch's order).
    expect(nav.indexOf('shell-rail__main')).toBeLessThan(nav.indexOf('class="shell-project"'));
    expect(nav.indexOf('class="shell-project"')).toBeLessThan(nav.indexOf('shell-rail__lower'));
  });

  it('a slot rendered outside the shell\'s two places renders nothing', () => {
    expect(renderToStaticMarkup(slot('pre-processing'))).toBe('');
  });
});

describe('the rail\'s brand: the MAK-AI logo and the platform name, one link to Home', () => {
  it('the logo (decorative beside the name) and "MAK-AI RAI Platform" are one link to the organisation\'s Home', () => {
    at('/orgs/a/projects');
    const html = renderToStaticMarkup(<Rail shell={shell} />);
    const brand = /<a [^>]*class="shell-rail__brand"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(brand).not.toBeNull();
    expect(brand![0]).toContain('href="/orgs/a/dashboard"');
    expect(stripTags(brand![1])).toBe('MAK-AI RAI Platform');
    const img = /<img [^>]*>/.exec(brand![1])![0];
    expect(img).toContain('alt=""');
    expect(img).toContain('src="/logo-makai-white-154.webp"');
    expect(img).toContain('srcSet="/logo-makai-white-154.webp 1x, /logo-makai-white-308.webp 2x"');
    expect(img).toMatch(/width="154"/);
    expect(img).toMatch(/height="36"/);
    expect(img).toContain('decoding="async"');
    expect(img).not.toMatch(/loading=|fetchpriority/i);
    // It comes first in the rail, before the switcher and the items.
    expect(html.indexOf('shell-rail__brand')).toBeLessThan(html.indexOf('shell-rail__org'));
  });

  it('with no organisation the brand links to /', () => {
    at('/explore/framework');
    const html = renderToStaticMarkup(<Rail shell={{ ...shell, orgs: [], roleLabels: {}, homeSlug: null }} />);
    expect(/<a [^>]*class="shell-rail__brand"[^>]*>/.exec(html)![0]).toContain('href="/"');
  });

  it('spec 7.5: the rail\'s Organisation item reads "Organisation"', () => {
    expect(SHELL_COPY.items.organisation).toBe('Organisation');
  });
});

describe('the narrow top bar\'s brand', () => {
  it('without a project the bar shows the logo linking Home, named "MAK-AI RAI Platform", beside the Menu button', () => {
    at('/orgs/a/dashboard');
    const html = renderToStaticMarkup(<TopBar shell={shell} />);
    const header = /<header class="shell-topbar">([\s\S]*?)<\/header>/.exec(html)![1];
    const brand = /<a [^>]*class="shell-topbar__brand"[^>]*>([\s\S]*?)<\/a>/.exec(header);
    expect(brand![0]).toContain('href="/orgs/a/dashboard"');
    expect(/<img [^>]*>/.exec(brand![1])![0]).toContain('alt="MAK-AI RAI Platform"');
    expect(header.indexOf('shell-topbar__menu-button')).toBeLessThan(header.indexOf('shell-topbar__brand'));
  });
});

describe('the footer: a navy band with the MAK-AI and DSWB logos (owner, 15 November 09:14)', () => {
  const html = renderToStaticMarkup(<Footer />);

  it('both logos, named "MAK-AI" and "Data Science Without Borders", sized and loaded lazily', () => {
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toContain('alt="MAK-AI"');
    expect(imgs[1]).toContain('alt="Data Science Without Borders"');
    for (const img of imgs) {
      expect(img).toContain('loading="lazy"');
      expect(img).toMatch(/width="\d+"/);
      expect(img).toMatch(/height="\d+"/);
      expect(img).not.toMatch(/fetchpriority/i);
    }
    expect(imgs[1]).toContain('srcSet="/logo-dswb-white-125.webp 1x, /logo-dswb-white-250.webp 2x"');
  });

  it('NFR-SEC-11: the credit line is the text of lib/credit.ts, as text', () => {
    expect(stripTags(html)).toContain(readCreditLine().text);
    expect(readFileSync('components/layout/Footer.tsx', 'utf8')).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('UX-03: the four links in today\'s order; Help and contact goes to Help\'s contact section (spec 8 line 271)', () => {
    const nav = /<nav aria-label="Footer"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    const credit = readCreditLine();
    expect(linksOf(nav).map((l) => [l.text, /href="([^"]+)"/.exec(l.attrs)![1]])).toEqual([
      [credit.licence, credit.href], ['Terms and privacy', '/help#terms-and-privacy'], ['About', '/about'],
      ['Help and contact', '/help#contact'],
    ]);
  });
});

describe('the logo files are sized WebP copies, no larger than drawn at 1x and 2x', () => {
  /** Width and height from a WebP file's header: VP8X (extended, with alpha), VP8L (lossless) or VP8 (lossy). */
  function webpSize(path: string) {
    const b = readFileSync(path);
    expect(b.subarray(0, 4).toString('latin1') + b.subarray(8, 12).toString('latin1')).toBe('RIFFWEBP');
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, bytes: b.length };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, bytes: b.length };
    }
    expect(chunk).toBe('VP8 ');
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, bytes: b.length };
  }
  // The byte ceilings hold the coordinator's ruling of 15 November 2026 (lossy WebP q70 for both logos): with the footer
  // in the first view, S-04's first visit fetches both 1x files, and S-04 had about 2.6 KB to find (NFR-PERF-02).
  it.each([
    ['public/logo-makai-white-154.webp', 154, 36, 2_000], ['public/logo-makai-white-308.webp', 308, 72, 4_500],
    ['public/logo-dswb-white-125.webp', 125, 40, 2_000], ['public/logo-dswb-white-250.webp', 250, 80, 4_500],
  ])('%s is %i x %i, and under %i bytes', (path, width, height, ceiling) => {
    const size = webpSize(path);
    expect(size).toMatchObject({ width, height });
    expect(size.bytes).toBeLessThan(ceiling);
  });
});

describe('the shell\'s frame (route task 1, fix round 2)', () => {
  const shellCss = readFileSync('components/layout/shell.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    const at = shellCss.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return shellCss.slice(at, shellCss.indexOf('}', at));
  };

  it('one gutter: a page root that brings its own padding drops its inline and top padding inside the shell\'s main', () => {
    const body = rule('.shell__main > :is(.page-content, .help)');
    expect(body).toMatch(/padding-inline: 0;/);
    expect(body).toMatch(/padding-block-start: 0;/);
    // The bottom padding stays: the decision form's fixed Save bar sets it (components/decision/DecisionForm.css).
    expect(body).not.toMatch(/padding(-block-end)?:/);
  });

  it('one gutter: the page\'s first block drops its top margin, so the first view starts one gutter down', () => {
    expect(rule('.shell__main > :is(.page-content, .help) > :first-child')).toMatch(/margin-block-start: 0;/);
  });

  it('the rail\'s column has an inline-end edge and the bar a bottom edge (an inset shadow), in the container border role', () => {
    const wide = shellCss.slice(shellCss.indexOf('@media (min-width: 1024px)'));
    const panel = wide.slice(wide.indexOf('.shell-topbar__panel {'), wide.indexOf('}', wide.indexOf('.shell-topbar__panel {')));
    expect(panel).toMatch(/border-inline-end: 1px solid var\(--color-border-container\);/);
    // The bar's edge is an inset shadow, so the bar keeps its 60 px height (the panel opens at 3.75rem without scripts).
    expect(rule('.shell-topbar')).toMatch(/box-shadow: inset 0 -1px 0 var\(--color-border-container\);/);
    expect(rule('.shell-topbar')).not.toMatch(/border(-[a-z-]+)?:/);
  });
});

describe('fix round 3: the rail fits a laptop (D4, D5) and the minor design items', () => {
  const css = readFileSync('components/layout/shell.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const wide = css.slice(css.indexOf('@media (min-width: 1024px)'));
  /** Every rule body for `selector` in `source`, joined (a selector can have a base rule and a wide one). */
  const ruleIn = (source: string, selector: string) => {
    const bodies: string[] = [];
    for (let at = source.indexOf(`${selector} {`); at >= 0; at = source.indexOf(`${selector} {`, at + 1)) {
      bodies.push(source.slice(at, source.indexOf('}', at)));
    }
    expect(bodies.length, selector).toBeGreaterThan(0);
    return bodies.join('\n');
  };

  it('D4 I1: the rail is a scrolling part, then the pinned lower group and the pinned foot; the foot holds the person, My account, Sign out and the theme switch', () => {
    at('/orgs/a/projects');
    const html = renderToStaticMarkup(<Rail shell={shell} />).replace(/^(<link rel="preload"[^>]*>)+/, '');
    const parts = /<div class="shell-rail__scroll">([\s\S]*)<\/div><ul class="shell-rail__lower">([\s\S]*?)<\/ul><div class="shell-rail__foot">/.exec(html);
    expect(parts, 'the scrolling part, then the lower group, then the foot').not.toBeNull();
    const [, scroll, lower] = parts!;
    for (const part of ['shell-rail__brand', 'shell-rail__org', 'shell-rail__main']) expect(scroll).toContain(part);
    const foot = html.slice(html.indexOf('<div class="shell-rail__foot">'));
    for (const part of ['shell-rail__person', 'href="/account"', 'shell-rail__signout', 'shell-theme']) expect(foot, part).toContain(part);
    expect(scroll).not.toContain('shell-rail__person');
    // I1 (final review): Members and Organisation sit outside the scrolling part, so a tall project block cannot push them
    // out of view; they stay in reading order between the project block and the foot.
    expect(scroll).not.toContain('settings/members');
    expect(lower).toContain('/orgs/a/settings/members');
    expect(lower).toContain('/orgs/a/settings/organisation');
  });

  it('D4 D5: from 1024 px only the upper part scrolls, with a thin navy scrollbar and a cue at each edge with more beyond', () => {
    // Fix round 4 (M3): the panel scrolls as a whole only when the foot alone outgrows it (a window under ~230 px tall).
    expect(ruleIn(wide, '.shell-topbar__panel')).toMatch(/overflow-y: auto;/);
    expect(ruleIn(wide, '.shell-topbar__panel')).not.toMatch(/overflow: hidden;/);
    const scroll = ruleIn(wide, '.shell-rail__scroll');
    expect(scroll).toMatch(/overflow-y: auto;/);
    expect(scroll).toMatch(/scrollbar-width: thin;/);
    expect(scroll).toMatch(/scrollbar-color: var\(--color-shell-muted\) transparent;/);
    expect(scroll).toMatch(/container-type: scroll-state;/);
    expect(ruleIn(wide, '.shell-rail__foot')).toMatch(/flex: none;/);
    expect(css).toMatch(/@container scroll-state\(scrollable: block-end\)/);
    expect(css).toMatch(/@container scroll-state\(scrollable: block-start\)/);
    // Browsers without scroll-state queries: the same cue from a scroll-driven animation.
    expect(css).toMatch(/animation-timeline: scroll\(\);/);
  });

  it('D4 (a)(c): the items sit at a 44 px pitch with no gap, and the rail\'s padding and group gaps are 8 px', () => {
    expect(ruleIn(css, '.shell-rail__nav ul')).toMatch(/gap: 0;/);
    expect(ruleIn(css, '.shell-rail__item')).toMatch(/min-block-size: var\(--target-primary\);/);
    expect(ruleIn(css, '.shell-rail__scroll')).toMatch(/gap: var\(--space-2\);/);
    expect(ruleIn(css, '.shell-rail__scroll')).toMatch(/padding: var\(--space-2\) var\(--space-3\);/);
    expect(ruleIn(css, '.shell-rail__nav')).toMatch(/gap: var\(--space-2\);/);
  });

  it('D20 D21 D26: the Menu button shows it is open; the bar keeps one inline padding; the footer\'s top rule is the rail\'s edge token', () => {
    expect(ruleIn(css, '.shell-topbar__menu-button[aria-expanded="true"]')).toMatch(/background-color: var\(--color-shell-hover\);/);
    expect(ruleIn(css, '.shell-topbar')).toMatch(/padding: var\(--space-2\) var\(--space-3\);/);
    expect(css).not.toMatch(/\.shell-topbar:has\(\.shell-bar-project\) \{\s*padding-inline/);
    const footerCss = readFileSync('components/layout/footer.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ruleIn(footerCss, '.shell-footer')).toMatch(/border-block-start: 1px solid var\(--color-border-container\);/);
  });

  it('D13: hovering a stage underlines its name; the lighter plate stays the current stage\'s alone', () => {
    expect(ruleIn(css, '.shell-project__stage--current')).toMatch(/background-color: var\(--color-shell-hover\);/);
    expect(css).not.toMatch(/\.shell-project__stage:hover,\s*\.shell-project__stage--current/);
    expect(ruleIn(css, '.shell-project__stage:hover .shell-project__stage-name')).toMatch(/text-decoration: underline;/);
  });
});

describe('fix round 4: the footer in the content column (D23, coordinator\'s option iii), the cue on the real edge, the rail fits', () => {
  const css = readFileSync('components/layout/shell.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const wide = css.slice(css.indexOf('@media (min-width: 1024px)'));
  const ruleIn = (source: string, selector: string) => {
    const bodies: string[] = [];
    for (let at = source.indexOf(`${selector} {`); at >= 0; at = source.indexOf(`${selector} {`, at + 1)) {
      bodies.push(source.slice(at, source.indexOf('}', at)));
    }
    expect(bodies.length, selector).toBeGreaterThan(0);
    return bodies.join('\n');
  };

  it('D23: the root layout puts the page and its one footer in one frame, after the skip link; the offline banner is the frame\'s first box (lane 8 I2)', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8');
    expect(layout).toMatch(/<SkipLink \/>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<div className="page-frame">\s*<OfflineBanner \/>\s*\{children\}\s*<Footer \/>\s*<\/div>/);
    expect([...layout.matchAll(/<Footer \/>/g)]).toHaveLength(1);
  });

  it('D23: from 1024 px the frame of a shell page is the one content scroller, 32 px of end padding for lane 2\'s pinned row; main no longer scrolls', () => {
    const frame = ruleIn(wide, '.page-frame:has(> .shell)');
    expect(frame).toMatch(/overflow-y: auto;/);
    expect(frame).toMatch(/block-size: 100vh;/);
    expect(frame).toMatch(/padding-block-end: var\(--space-8\);/);
    expect(frame).toMatch(/grid-template-columns: var\(--rail-width\) minmax\(0, 1fr\);/);
    // No smooth scroll of its own: scroll-behavior is not inherited from html, and nothing here sets it.
    expect(css).not.toMatch(/[\s;{]scroll-behavior:/);
    const main = ruleIn(wide, '.shell__main');
    expect(main).not.toMatch(/overflow-y: auto;/);
    expect(main).not.toMatch(/max-height: 100vh;/);
    expect(main).toMatch(/padding: var\(--space-8\);/);
  });

  it('I2: from 1024 px the frame of a shell page is the containing block of its clipped absolute content, so none of it scrolls the window', () => {
    // overflow alone does not make the frame a containing block: without a position, the evidence uploader's clipped
    // file input took the initial containing block and its place below the fold made the document scroll (lane 8 I2).
    expect(ruleIn(wide, '.page-frame:has(> .shell)')).toMatch(/position: relative;/);
  });

  it('D23: the shell is a subgrid of the frame, the rail spans main\'s row and the footer\'s, the footer takes the content column', () => {
    expect(ruleIn(wide, '.page-frame > .shell')).toMatch(/grid-template-rows: subgrid;/);
    expect(ruleIn(wide, '.page-frame > .shell')).toMatch(/grid-template-columns: subgrid;/);
    expect(ruleIn(wide, '.page-frame > .shell')).toMatch(/grid-row: shell-start \/ shell-end;/);
    expect(ruleIn(wide, '.shell-topbar__panel')).toMatch(/grid-row: 1 \/ -1;/);
    const footer = ruleIn(wide, '.page-frame > .shell ~ .shell-footer');
    expect(footer).toMatch(/grid-column: 2;/);
    expect(footer).toMatch(/grid-row: footer-start \/ shell-end;/);
    // It and the rail take back the frame's end padding, so the band ends on the screen's foot with the rail whole beside it.
    expect(footer).toMatch(/margin-block-end: calc\(-1 \* var\(--space-8\)\);/);
    expect(ruleIn(wide, '.shell-topbar__panel')).toMatch(/margin-block-end: calc\(-1 \* var\(--space-8\)\);/);
  });

  it('D24: in the content column the band\'s content starts at the page\'s gutter, not centred', () => {
    const footer = ruleIn(wide, '.page-frame > .shell ~ .shell-footer');
    expect(footer).toMatch(/padding-inline: var\(--space-8\);/);
    expect(ruleIn(wide, '.page-frame > .shell ~ .shell-footer .shell-footer__inner')).toMatch(/margin-inline: 0;/);
  });

  it('I2: the scroll-driven fallback applies only where animation-timeline exists; with neither feature there is no cue', () => {
    expect(css).toMatch(/@supports \(animation-timeline: scroll\(\)\) and \(not \(container-type: scroll-state\)\) \{/);
    expect(css).not.toMatch(/@supports not \(container-type: scroll-state\)/);
  });

  it('I3 M2 I1: each cue sits on the scroller\'s real edge, past its 8 px padding, with the same hairline at either edge', () => {
    expect(ruleIn(wide, '.shell-rail__scroll::before')).toMatch(/inset-block-start: calc\(-1 \* var\(--space-2\)\);/);
    expect(ruleIn(wide, '.shell-rail__scroll::after')).toMatch(/inset-block-end: calc\(-1 \* var\(--space-2\)\);/);
    // Final review I1: the bottom edge now meets the lower group's rule (1.2:1 on the navy), which alone does not show that
    // stage lines lie below it; the bottom cue carries the top cue's hairline, shown only while more is below.
    expect(ruleIn(wide, '.shell-rail__scroll::before')).toMatch(/border-block-start: 1px solid var\(--color-shell-muted\);/);
    expect(ruleIn(wide, '.shell-rail__scroll::after')).toMatch(/border-block-end: 1px solid var\(--color-shell-muted\);/);
    expect(ruleIn(css, '.shell-rail__foot')).toMatch(/border-block-start: 1px solid var\(--color-border-container\);/);
  });

  it('rail fit: Sign out and the theme switch share one row; the switch is a 44 px square whose words are its accessible name', () => {
    expect(ruleIn(css, '.shell-rail__actions')).toMatch(/flex-direction: row;/);
    const square = ruleIn(css, '.shell-rail__actions .shell-theme');
    expect(square).toMatch(/inline-size: var\(--target-primary\);/);
    expect(ruleIn(css, '.shell-rail__actions .shell-theme__label')).toMatch(/clip-path: inset\(50%\);/);
    at('/orgs/a/projects');
    const html = renderToStaticMarkup(<Rail shell={shell} />);
    expect(html).toMatch(/<span class="shell-theme__to-dark"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="shell-theme__label">Switch to dark theme<\/span><\/span>/);
  });

  it('I1: the shell reads --color-on-shell-accent, which globals.css defines, with the shell ink as its fallback', () => {
    expect(readFileSync('app/globals.css', 'utf8')).toMatch(/--color-on-shell-accent:\s*#F4B983;/);
    expect(ruleIn(css, '.shell-project__stage--current .shell-project__state')).toMatch(/color: var\(--color-on-shell-accent, var\(--color-shell-ink\)\);/);
  });
});
