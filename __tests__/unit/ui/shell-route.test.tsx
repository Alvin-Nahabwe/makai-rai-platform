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
    expect(SHELL_PROJECT_COPY.stagesLead).toBe(PROJECT_COPY.overview.anyOrder);
    expect(stripTags(html)).toContain('You can work on the stages in any order.');
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

  it('UX-03: the four links in today\'s order and at today\'s addresses', () => {
    const nav = /<nav aria-label="Footer"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    const credit = readCreditLine();
    expect(linksOf(nav).map((l) => [l.text, /href="([^"]+)"/.exec(l.attrs)![1]])).toEqual([
      [credit.licence, credit.href], ['Terms and privacy', '/help#terms-and-privacy'], ['About', '/about'],
      ['Help and contact', '/about#help-and-contact'],
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
