import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { HOME_COPY } from '@/lib/home/copy';
import { positionWords } from '@/lib/ui/copy';
import type { NextStep } from '@/lib/home/types';
import type { DashboardData } from '@/lib/data/projects';
import { decode, textOf } from '../../helpers/markup';
import { HOSTILE_STRINGS } from '../../helpers/hostile';

/**
 * Plan 1B Task 10, slice 3 cut: Home's "Your next step" card, as static markup (as prj-components.test.tsx renders
 * DashboardView). The card is a server component; LocalTime writes the UTC day on the server render.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));

const { NextStepCard } = await import('@/components/home/NextStepCard');
const { DashboardView } = await import('@/components/project/DashboardView');

const NEXT: NextStep = {
  projectId: 'p1', projectName: 'Antenatal risk triage', stage: 'pre-processing', questionId: 'Q-PP-05',
  questionText: 'Have you written down who the system is for?', position: { n: 5, of: 22 }, rule: 'next-open',
  lastSavedOn: '2026-11-03T09:15:00.000Z',
};
const html = (el: ReactElement) => renderToStaticMarkup(el);
const card = (next: Partial<NextStep> = {}) => html(<NextStepCard orgSlug="org-a" next={{ ...NEXT, ...next }} />);
/** The links of the markup, by their text: [text, href]. */
const links = (h: string): Array<[string, string]> =>
  [...h.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [textOf(m[2]).trim(), decode(m[1])]);
const linksNamed = (h: string, names: string[]) => links(h).filter(([t]) => names.includes(t));

const DASHBOARD: DashboardData = {
  orgSlug: 'org-a', orgName: 'Org', role: 'assessor', welcome: false, canCreate: true, projects: [], mine: [], projectNames: new Map(), archivedCount: 0,
};

describe('NextStepCard', () => {
  it('recorder: names the question in words with its reason, position and two controls; the code is not alone at a line end', () => {
    const h = card();
    expect(textOf(h)).toContain(HOME_COPY.reasonNextOpen('Pre-processing', '3 Nov 2026'));
    expect(linksNamed(h, [HOME_COPY.continueRecording, HOME_COPY.chooseAnother])).toHaveLength(2);
    expect(textOf(h)).toContain(positionWords(5, 22));
    // The plan's "code not alone at a line's end" is held by the indexOf case below: stripped markup has no line ends.
    expect(textOf(h)).toContain(HOME_COPY.nextStepHeading);
    expect(textOf(h)).toContain(HOME_COPY.projectOf('Antenatal risk triage'));
    expect(textOf(h)).toContain('Pre-processing');
  });

  it('F2: the project line and the stage name are separate lines, never joined as text', () => {
    const h = card();
    // Text as a block-aware reader takes it: each closing block tag ends a line, an inline one does not.
    const lines = textOf(h.replace(/<\/(p|div|h2|section)>/g, '\n')).split('\n').map((l) => l.trim());
    expect(lines).toContain(HOME_COPY.projectOf('Antenatal risk triage'));
    expect(lines).toContain('Pre-processing');
    expect(lines.join('\n')).not.toMatch(/Antenatal risk triage[^\n]*Pre-processing/);
    expect(h).toMatch(/<p[^>]*>Project: <bdi>Antenatal risk triage<\/bdi><\/p>\s*<p[^>]*>Pre-processing<\/p>/);
  });

  it('is a section labelled by its h2 #next-step', () => {
    const h = card();
    expect(h).toMatch(/^<section[^>]*aria-labelledby="next-step"/);
    expect(h).toContain(`<h2 id="next-step">${HOME_COPY.nextStepHeading}</h2>`);
  });

  it('the question in words comes first, its code after it', () => {
    const t = textOf(card());
    expect(t.indexOf(NEXT.questionText)).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('Q-PP-05')).toBeGreaterThan(t.indexOf(NEXT.questionText));
  });

  it('the day in the reason is a <time> carrying the instant', () => {
    expect(card()).toContain('<time dateTime="2026-11-03T09:15:00.000Z">3 Nov 2026</time>');
  });

  it('each rule gives its own reason', () => {
    expect(textOf(card({ rule: 'last-saved' }))).toContain(HOME_COPY.reasonLastSaved('3 Nov 2026'));
    expect(textOf(card({ rule: 'first-open', lastSavedOn: null }))).toContain(HOME_COPY.reasonFirstOpen);
    expect(textOf(card({ rule: 'first-open', lastSavedOn: null }))).not.toContain('You last saved');
    expect(textOf(card({ rule: 'last-saved' }))).not.toContain('with no decision');
  });

  it('Continue recording opens the question; Choose another question opens the stage', () => {
    const h = card({ stage: 'in-processing', questionId: 'Q-IP-07' });
    expect(linksNamed(h, [HOME_COPY.continueRecording])).toEqual([[HOME_COPY.continueRecording, '/orgs/org-a/projects/p1/stages/in-processing/questions/Q-IP-07']]);
    expect(linksNamed(h, [HOME_COPY.chooseAnother])).toEqual([[HOME_COPY.chooseAnother, '/orgs/org-a/projects/p1/stages/in-processing']]);
  });

  it('C7: Continue recording is the primary button and Choose another question the secondary one, in that order', () => {
    const h = card();
    const controls = [...h.matchAll(/<a\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [textOf(m[2]).trim(), m[1]]);
    expect(controls.map(([t]) => t)).toEqual([HOME_COPY.continueRecording, HOME_COPY.chooseAnother]);
    expect(controls[0][1].split(/\s+/)).toContain('ui-button--primary');
    expect(controls[1][1].split(/\s+/)).toContain('ui-button--secondary');
  });

  it('principle 7: no %, no total, no progress element, no tick, the position the only count', () => {
    const h = card();
    expect(h).not.toMatch(/%|<progress|role="progressbar"|in all|total|✓|✔/i);
    expect(textOf(h).match(/\d+ of \d+/g)).toEqual([positionWords(5, 22).match(/\d+ of \d+/)![0]]);
  });

  it('a hostile project name and question text come out as text', () => {
    for (const s of HOSTILE_STRINGS) {
      const h = card({ projectName: s, questionText: s });
      expect(h).not.toContain(s.startsWith('<') ? '<script>' : '<img');
      expect(textOf(h)).toContain(HOME_COPY.projectOf(s));
      expect(textOf(h)).toContain(s);
    }
  });

  it('the project name and the question text are isolated in <bdi>', () => {
    const h = card();
    expect(h).toContain('<bdi>Antenatal risk triage</bdi>');
    expect(h).toContain(`<bdi>${NEXT.questionText}</bdi>`);
  });
});

describe('DashboardView with a next step', () => {
  it('puts the section after the page header and before Active projects', () => {
    const h = html(<DashboardView data={DASHBOARD} next={NEXT} />);
    const at = h.indexOf('id="next-step"');
    expect(at).toBeGreaterThan(h.indexOf(`>${HOME_COPY.heading}</h1>`));
    expect(at).toBeLessThan(h.indexOf('id="active-projects"'));
  });

  it('with next null, or no next, renders no #next-step and no Continue recording', () => {
    for (const h of [html(<DashboardView data={DASHBOARD} next={null} />), html(<DashboardView data={DASHBOARD} />)]) {
      expect(h).not.toContain('id="next-step"');
      expect(h).not.toContain(HOME_COPY.continueRecording);
      expect(h).not.toContain(HOME_COPY.nextStepHeading);
    }
  });

  it("with a next step, Home's header New project is secondary and Continue recording the page's only primary", () => {
    const h = html(<DashboardView data={DASHBOARD} next={NEXT} />);
    const controls = [...h.matchAll(/<a\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [textOf(m[2]).trim(), m[1].split(/\s+/)] as const);
    expect(controls.find(([t]) => t === HOME_COPY.newProject)?.[1]).toContain('ui-button--secondary');
    expect(controls.filter(([, c]) => c.includes('ui-button--primary')).map(([t]) => t)).toEqual([HOME_COPY.continueRecording]);
  });

  it("with no next step, or next null, Home's header New project stays primary", () => {
    for (const h of [html(<DashboardView data={DASHBOARD} next={null} />), html(<DashboardView data={DASHBOARD} />)]) {
      const link = [...h.matchAll(/<a\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].find((m) => textOf(m[2]).trim() === HOME_COPY.newProject);
      expect(link?.[1].split(/\s+/)).toContain('ui-button--primary');
    }
  });
});
