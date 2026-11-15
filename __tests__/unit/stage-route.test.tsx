import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { STATUS_MARK_COPY } from '@/lib/ui/copy';

/**
 * Plan 1C Task 3, the page variant of All questions, rendered from fixture data without a database: each question is the
 * kit's ItemPlate with its StatusMark in words, the stage is the kit's RouteRow over every question with its tally, and
 * the "Show" filter keeps its native radios. vitest runs in `node` with no jsdom, so effects do not run here: what the
 * list does after reading storage is driven in a browser by e2e/recording-loop.spec.ts.
 */
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
const { StageWorkspace } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page');

const row = (questionId: string, over: Partial<StageRow> = {}): StageRow => ({
  questionId, questionType: 'likert-5', text: `Question ${questionId} in words?`, moduleId: 'M1', moduleTitle: 'Problem Formulation', statusText: 'No decision',
  versionNumber: null, declaredDate: null, openFindings: 0, changedSinceSeal: false, reworded: false, inPlace: null, kind: 'none', evidenceCount: 0, ...over,
});
const KIND_MARK: Record<StageRow['kind'], StatusMarkKind> = {
  none: 'no_decision', shortfall: 'partly', done: 'done', not_applicable: 'not_applicable', scope: 'scope_answered', not_applicable_by_gate: 'does_not_apply',
};
const data = (rows: StageRow[], over: Partial<StagePageData> = {}): StagePageData => ({
  orgSlug: 'org-a', orgId: 'o1', projectId: 'p1', projectName: 'Project A', projectArchived: false, stage: 'pre-processing', viewerId: 'u1',
  rows, nothingRecorded: false, changed: null, review: null, followUp: { openFindings: 0, overdueMitigations: 0 },
  marks: Object.fromEntries(rows.map((r) => [r.questionId, KIND_MARK[r.kind]])), scopeAnswer: null, ...over,
});
const render = (d: StagePageData, show: Parameters<typeof StageWorkspace>[0]['show'] = 'all') =>
  renderToStaticMarkup(createElement(StageWorkspace, { data: d, show, shown: null }));
/** Each question row's markup, by question id. */
const rowsOf = (h: string) => new Map([...h.matchAll(/<li[^>]*data-question-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => [m[1], m[2]]));

const ROWS = [
  row('Q-PP-01', { kind: 'done', statusText: 'Done', versionNumber: 3, declaredDate: '2026-10', evidenceCount: 0, openFindings: 2 }),
  row('Q-PP-02', { kind: 'done', statusText: 'Done', versionNumber: 1, declaredDate: '2026-10-12', evidenceCount: 1 }),
  row('Q-PP-GATE-SENSITIVE', { questionType: 'gate', kind: 'scope', statusText: 'Answer: Yes', versionNumber: 1 }),
  row('Q-PP-16', { questionType: 'checklist', kind: 'shortfall', statusText: 'Partly', inPlace: { n: 1, of: 4 }, versionNumber: 2, changedSinceSeal: true }),
  row('Q-PP-17', { kind: 'none', moduleId: 'M2', moduleTitle: 'Data Collection & Preparation', reworded: true }),
];

describe('All questions: a plate per question', () => {
  it('each row shows its StatusMark with words and its code after the question in words; no "v3" or other version number', () => {
    const rows = rowsOf(render(data(ROWS, { scopeAnswer: 'yes' })));
    expect([...rows.keys()]).toEqual(ROWS.map((r) => r.questionId));
    for (const r of ROWS) {
      const body = rows.get(r.questionId)!;
      expect([...body.matchAll(/class="ui-mark ui-mark--/g)], r.questionId).toHaveLength(1);
      expect(body).toMatch(/class="ui-mark__words">[^<]*\p{L}/u);
      expect(body.indexOf(r.text)).toBeGreaterThan(-1);
      expect(body.indexOf(`>${r.questionId}<`)).toBeGreaterThan(body.indexOf(r.text));
      expect(body).not.toMatch(/\bv\d+\b|[Vv]ersion \d/);
      expect(body).not.toContain('status-label');   // the words are the mark's own, in ink: no legacy label, no warning class
    }
  });

  it('done with no evidence reads "Done, no evidence attached"; done with evidence reads "Done"; the personal data question reads "Answer: Yes"', () => {
    const rows = rowsOf(render(data(ROWS, { scopeAnswer: 'yes' })));
    expect(rows.get('Q-PP-01')).toContain('class="ui-mark__words">Done, no evidence attached<');
    expect(rows.get('Q-PP-02')).toContain('class="ui-mark__words">Done<');
    expect(rows.get('Q-PP-GATE-SENSITIVE')).toContain(`class="ui-mark__words">${STATUS_MARK_COPY.scope_answered('yes')}<`);
  });

  it('a gated question reads the kit\'s "Does not apply (from your answer to the personal data question)"', () => {
    const rows = rowsOf(render(data([row('Q-PP-13', { kind: 'not_applicable_by_gate', statusText: 'Does not apply' })])));
    expect(rows.get('Q-PP-13')).toContain(`class="ui-mark__words">${STATUS_MARK_COPY.does_not_apply}<`);
  });

  it('the state line: the decided-on date, "{n} of {m} in place", open findings only above zero, the seal and good-practice markers, with no leading separator', () => {
    const rows = rowsOf(render(data(ROWS, { changed: { sealNumber: 1, changedQuestions: ['Q-PP-16'], changedFindings: [] } })));
    const state = (id: string) => rows.get(id)!.match(/class="ui-plate__state">([\s\S]*?)<\/div>/)?.[1];
    expect(state('Q-PP-01')).toBe('Oct 2026 · 2 open findings');
    expect(state('Q-PP-02')).toBe('12 Oct 2026');
    expect(state('Q-PP-16')).toBe('1 of 4 in place · changed since seal 1');
    expect(state('Q-PP-17')).toBe('good practice changed');
    expect(state('Q-PP-GATE-SENSITIVE')).toBeUndefined();
  });

  it('the whole plate is the link to its question', () => {
    const rows = rowsOf(render(data(ROWS)));
    expect(rows.get('Q-PP-02')).toMatch(/<a[^>]*class="[^"]*ui-plate__link[^"]*"[^>]*href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-02"/);
  });
});

describe('All questions: the stage as a row of marks', () => {
  it('one stop per question of the stage in question order, also when the list is paged, and the tally in words; no <progress>, no "%"', () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`Q-${String(i).padStart(2, '0')}`, i < 3 ? { kind: 'done', evidenceCount: i } : {}));
    const h = render(data(many));
    expect(rowsOf(h).size).toBe(50);   // the list shows a page (LIST_PAGE_SIZE)
    const stops = [...h.matchAll(/<li class="ui-route-row__stop[^"]*" data-mark-kind="([a-z_]+)"/g)].map((m) => m[1]);
    expect(stops).toHaveLength(60);
    expect(stops.slice(0, 4)).toEqual(['done', 'done', 'done', 'no_decision']);
    // The tally is the kit's list keyed by the marks (lane 4 Task B); read together its items are the tally in words.
    const tally = [...h.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    expect(tally.join(', ')).toBe('3 done (1 with no evidence attached), 57 no decision');
    expect(h).not.toContain('<progress');
    expect(h).not.toMatch(/\d\s?%/);
  });

  it('the row of marks is labelled with the stage\'s questions and its stops link to each question; the answered stop says the answer', () => {
    const h = render(data(ROWS, { scopeAnswer: 'yes' }));
    expect(h).toMatch(/<ol class="ui-route-row__stops" role="list" aria-label="Questions in this stage">/);
    // The kit writes a stop's title in an element of its own, then ": " and the status words (RouteRow).
    expect(h).toContain(`<span>Question Q-PP-GATE-SENSITIVE in words?</span>: ${STATUS_MARK_COPY.scope_answered('yes')}`);
    expect(h).toMatch(/<a[^>]*href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-01"[^>]*class="ui-route-row__point"|<a[^>]*class="ui-route-row__point"[^>]*href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-01"/);
  });

  it('the row of marks sits between the count line and the filter group', () => {
    const h = render(data(ROWS));
    const at = (s: string) => h.indexOf(s);
    expect(at('data-stage-summary')).toBeLessThan(at('ui-route-row'));
    expect(at('ui-route-row')).toBeLessThan(at('name="show"'));
  });
});

describe('All questions: the Show filter', () => {
  it('the filters in order with their counts, each a native radio followed by one text node; Changed since seal only with a seal', () => {
    const labels = (h: string) => [...h.matchAll(/<input type="radio" name="show"[^>]*value="([a-z_]+)"[^>]*\/>([^<]*)<\/label>/g)].map((m) => [m[1], m[2]]);
    expect(labels(render(data(ROWS)))).toEqual([
      ['all', ' All 5'], ['no_decision', ' No decision 1'], ['shortfalls', ' Partly or not yet 1'], ['done_without_evidence', ' Done, no evidence attached 1'],
      ['reworded', ' Good practice changed 1'], ['drafts', ' Not saved yet '],
    ]);
    const sealed = labels(render(data(ROWS, { changed: { sealNumber: 2, changedQuestions: ['Q-PP-16'], changedFindings: [] } })));
    expect(sealed.map((l) => l[0])).toContain('changed_since_seal');
    expect(sealed.find((l) => l[0] === 'changed_since_seal')![1]).toBe(' Changed since seal 2 1');
  });

  it('each option is a chip of the stage-route styles, inside the same GET form with the noscript submit', () => {
    const h = render(data(ROWS));
    expect(h).toMatch(/<form[^>]*method="get"[^>]*>[\s\S]*<noscript><button type="submit"[^>]*>Show<\/button><\/noscript><\/form>/);
    expect([...h.matchAll(/<label class="stage-route__chip">/g)]).toHaveLength(6);
  });

  it('the no-storage line is the decision form\'s ruled sentence, word for word', () => {
    expect(STAGE_LIST_COPY.noStorage).toBe(DECISION_FORM_COPY.noStorage);
  });
});
