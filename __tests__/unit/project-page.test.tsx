import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StageCounts } from '@/types/api';
import { STAGES, type Stage } from '@/types/record';
import { projectActions } from '@/lib/projects/can';
import { PROJECT_COPY } from '@/lib/project/copy';
import { UI_COPY } from '@/lib/ui/copy';
import type { ProjectOverviewData } from '@/lib/data/projects';

/**
 * Slice 2 of the redesign (spec 9.2, 7.2): S-10 shows each stage as a plain block, in this order: the name and its
 * lines, "Still open in this stage", "Recorded so far", the stage reviews and one link to the stage page. The stage
 * reviews summary is the real one here (prj-components.test.tsx mocks it away), so its place in the order is proven.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));

const { ProjectOverview } = await import('@/components/project/ProjectOverview');
const { stageTally } = await import('@/components/project/StageColumn');

const S = PROJECT_COPY.stage;

const COUNTS: StageCounts = {
  questions: 24, noDecision: 9, byStatus: { done: 7, partly: 3, not_yet: 2, not_applicable: 2 }, doneWithoutEvidence: 2,
  openFindings: 3, openFindingsWithoutMitigation: 1, openMitigations: 2, overdueMitigations: 1, acceptedRisks: 1, documentsIssued: 1,
  notApplicableByGate: 0,
};
const ZERO: StageCounts = {
  questions: 24, noDecision: 24, byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 0,
  openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0, overdueMitigations: 0, acceptedRisks: 0, documentsIssued: 0,
  notApplicableByGate: 0,
};

function data(counts: Partial<Record<Stage, StageCounts>> = {}): ProjectOverviewData {
  return {
    orgSlug: 'o', orgName: 'Org', project: { id: 'p1', name: 'Maternal-risk triage', descriptiveLine: '', archived: false },
    counts: { 'pre-processing': counts['pre-processing'] ?? COUNTS, 'in-processing': counts['in-processing'] ?? COUNTS, 'post-processing': counts['post-processing'] ?? COUNTS },
    followUp: { 'pre-processing': { items: [], cannotAct: [] }, 'in-processing': { items: [], cannotAct: [] }, 'post-processing': { items: [], cannotAct: [] } },
    reviews: { 'pre-processing': [], 'in-processing': [], 'post-processing': [] },
    can: projectActions('owner', false),
  };
}
const render = (counts: Partial<Record<Stage, StageCounts>> = {}) => renderToStaticMarkup(<ProjectOverview data={data(counts)} />);

/** Each stage's block, from its opening tag to the next block (or the end of the stage list). */
function blocks(html: string): Record<Stage, string> {
  const out = {} as Record<Stage, string>;
  for (const [i, s] of STAGES.entries()) {
    const start = html.indexOf(`<section class="stage-column" id="${s}"`);
    expect(start, `${s}: its block`).toBeGreaterThan(-1);
    const next = i + 1 < STAGES.length ? html.indexOf(`<section class="stage-column" id="${STAGES[i + 1]}"`) : html.indexOf(PROJECT_COPY.overview.shareLine);
    out[s] = html.slice(start, next);
  }
  return out;
}
/** The text of each `<li>` of the list right after the heading `h3` with these words. */
function itemsAfter(block: string, heading: string): string[] {
  const at = block.indexOf(`>${heading}</h3>`);
  expect(at, `the heading "${heading}"`).toBeGreaterThan(-1);
  const rest = block.slice(at);
  const ul = rest.indexOf('<ul');
  const nextHeading = rest.indexOf('<h', 4);
  if (ul === -1 || (nextHeading !== -1 && nextHeading < ul)) return [];
  const list = rest.slice(ul, rest.indexOf('</ul>', ul));
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
}

describe('the project page, each stage a plain block (slice 2)', () => {
  it('9.2: per stage, in order: Still open in this stage, Recorded so far, Stage reviews, All questions in this stage', () => {
    for (const block of Object.values(blocks(render()))) {
      const at = [`>${S.stillOpen}</h3>`, `>${PROJECT_COPY.followUp.heading}</h4>`, `>${S.recorded}</h3>`, '>Stage reviews</h3>', `>${S.allQuestions}</a>`].map((w) => block.indexOf(w));
      expect(at.every((n) => n > -1), at.join(',')).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(block.indexOf('<h2')).toBeLessThan(at[0]);
    }
  });

  it('9.2: each stage is a section named by its heading, not a details element; the three ids are the stages', () => {
    const html = render();
    expect(html).not.toMatch(/<details|<summary/);
    expect(html).not.toContain('stage-column__todo-line');
    const sections = [...html.matchAll(/<section class="stage-column" id="([^"]+)" data-stage="([^"]+)" aria-labelledby="([^"]+)">/g)];
    expect(sections.map((m) => m[1])).toEqual([...STAGES]);
    expect(sections.map((m) => m[2])).toEqual([...STAGES]);
    for (const [i, m] of sections.entries()) {
      expect(html).toContain(`<h2 id="${m[3]}">${PROJECT_COPY.stageNames[STAGES[i]]}</h2>`);
    }
    expect(new Set(sections.map((m) => m[3])).size).toBe(3);
    expect(html).toContain('<div class="stage-list__columns">');
  });

  it('9.2: Still open lists only the counts above zero, in words, with the open findings as a link to that stage\'s findings; all zero reads "Nothing is open in this stage."', () => {
    const b = blocks(render({ 'in-processing': { ...COUNTS, noDecision: 1, openFindings: 1, openFindingsWithoutMitigation: 0, overdueMitigations: 2 }, 'post-processing': { ...ZERO, noDecision: 0 } }));
    expect(itemsAfter(b['pre-processing'], S.stillOpen)).toEqual(['9 questions with no decision', '3 open findings (1 of them with no mitigation yet)', '1 overdue mitigation']);
    expect(b['pre-processing']).toContain('<a href="/orgs/o/projects/p1/findings#g-pre-processing">3 open findings</a> (1 of them with no mitigation yet)');
    expect(itemsAfter(b['in-processing'], S.stillOpen)).toEqual(['1 question with no decision', '1 open finding', '2 overdue mitigations']);
    expect(b['in-processing']).toContain('<a href="/orgs/o/projects/p1/findings#g-in-processing">1 open finding</a>');
    expect(itemsAfter(b['post-processing'], S.stillOpen)).toEqual([]);
    expect(b['post-processing']).toContain(`<p>${S.nothingOpen}</p>`);
    expect(S.nothingOpen).toBe('Nothing is open in this stage.');
    expect(b['pre-processing']).not.toContain(S.nothingOpen);
    // Zero counts are left out, not printed as "0 ...".
    const some = blocks(render({ 'pre-processing': { ...COUNTS, noDecision: 0, overdueMitigations: 0 } }))['pre-processing'];
    expect(itemsAfter(some, S.stillOpen)).toEqual(['3 open findings (1 of them with no mitigation yet)']);
    // An open mitigation that is not overdue keeps "Nothing is open" away: the follow-up list below names it.
    const mitigationOnly = blocks(render({ 'pre-processing': { ...ZERO, noDecision: 0, openMitigations: 1 } }))['pre-processing'];
    expect(mitigationOnly).not.toContain(S.nothingOpen);
  });

  it('7.2: Recorded so far is the tally in the kit\'s words, one item per kind above zero, with "with no evidence attached" on done; no total across stages', () => {
    const html = render({ 'in-processing': { ...COUNTS, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 0, noDecision: 22, notApplicableByGate: 1 } });
    const b = blocks(html);
    expect(itemsAfter(b['pre-processing'], S.recorded)).toEqual(['7 done (2 with no evidence attached)', '3 partly', '2 not yet', '2 not applicable', '1 answered']);
    // 24 - 22 - 1 - 1 = 0 answered: "1 done" and "1 does not apply" only.
    expect(itemsAfter(b['in-processing'], S.recorded)).toEqual(['1 done', '1 does not apply']);
    // Each item carries the kit's shape, hidden from assistive technology, so the words are heard once.
    const list = b['pre-processing'].slice(b['pre-processing'].indexOf(`>${S.recorded}</h3>`));
    const items = [...list.slice(0, list.indexOf('</ul>')).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item).toMatch(/^<svg class="ui-mark__shape"[^>]*aria-hidden="true"/);
      expect(item).not.toMatch(/ui-mark__words|status-label|Done|Partly|Not yet|Not applicable/);
    }
    expect(b['pre-processing']).toContain('<p>1 accepted risk, 1 document issued</p>');
    expect(html).not.toMatch(/\b(total|overall|in all)\b|%/i);
    // The tally is per stage: no number adds the three stages (7 done each, never 21).
    expect(html).not.toMatch(/\b21 done\b/);
  });

  it('7.2: the personal data question is counted as "1 answered", derived from the loader\'s counts; the kinds and the no-decision count add up to the stage\'s questions', () => {
    expect(stageTally(COUNTS)).toEqual({ done: 7, partly: 3, not_yet: 2, not_applicable: 2, does_not_apply: 0, scope_answered: 1, doneNoEvidence: 2 });
    expect(stageTally(ZERO)).toEqual({ done: 0, partly: 0, not_yet: 0, not_applicable: 0, does_not_apply: 0, scope_answered: 0, doneNoEvidence: 0 });
    // Counts that over-add (24 - 9 - 2 - 14 = -1): never below zero.
    expect(stageTally({ ...COUNTS, notApplicableByGate: 2 }).scope_answered).toBe(0);
    // A consistent fixture: 6 gated, the gate answered, 5 with no decision, 12 with a status.
    const consistent: StageCounts = { ...COUNTS, questions: 24, noDecision: 5, notApplicableByGate: 6, byStatus: { done: 4, partly: 4, not_yet: 2, not_applicable: 2 } };
    const t = stageTally(consistent);
    expect(t.scope_answered).toBe(1);
    expect((t.done ?? 0) + (t.partly ?? 0) + (t.not_yet ?? 0) + (t.not_applicable ?? 0) + (t.does_not_apply ?? 0) + (t.scope_answered ?? 0) + consistent.noDecision).toBe(consistent.questions);
    expect(itemsAfter(blocks(render({ 'pre-processing': consistent }))['pre-processing'], S.recorded)).toEqual(['4 done (2 with no evidence attached)', '4 partly', '2 not yet', '2 not applicable', '6 do not apply', '1 answered']);
  });

  it('barely started: each stage reads "24 questions with no decision" and "No decisions recorded yet"', () => {
    const html = render({ 'pre-processing': ZERO, 'in-processing': ZERO, 'post-processing': ZERO });
    for (const block of Object.values(blocks(html))) {
      expect(itemsAfter(block, S.stillOpen)).toEqual(['24 questions with no decision']);
      expect(itemsAfter(block, S.recorded)).toEqual([]);
      expect(block).toContain(`<p>${UI_COPY.tally.none}</p>`);
      expect(block).not.toMatch(/accepted risk|issued/);
    }
    expect(html.split(UI_COPY.tally.none)).toHaveLength(4);
  });

  it('All questions in this stage links to the stage page and is described by the stage\'s heading', () => {
    const html = render();
    for (const [s, block] of Object.entries(blocks(html))) {
      const heading = /<h2 id="([^"]+)">/.exec(block)?.[1];
      expect(heading).toBeDefined();
      const link = new RegExp(`<a ([^>]*)>${S.allQuestions}</a>`).exec(block)?.[1] ?? '';
      expect(link).toContain(`href="/orgs/o/projects/p1/stages/${s}"`);
      expect(link).toContain(`aria-describedby="${heading}"`);
    }
    expect(html.split(`>${S.allQuestions}</a>`)).toHaveLength(4);
    expect(S.allQuestions).toBe('All questions in this stage');
  });
});
