import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { STATUS_MARK_COPY, tallyWords } from '@/lib/ui/copy';
import { TERM_STAGE_1 } from '@/lib/vocabulary/terms';
import { tallyOfRows } from '@/lib/question/route';

/**
 * All questions, the stage page, as the route's page variant (plan 1C Task 3; owner's answer R1, 15 November 2026; lane 1
 * Task 2), rendered from fixture data without a database: every question a row on one line (its mark, the question in
 * words, its code and its status in words), the topics quiet headings along the line, the stage's tally in words with
 * marks, and the "Show" filter keeping its native radios. vitest runs in `node` with no jsdom, so effects do not run here: what the
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

describe('All questions: a row per question on one line', () => {
  it('each row shows its StatusMark with words and its code after the question in words; no "v3" or other version number', () => {
    const rows = rowsOf(render(data(ROWS, { scopeAnswer: 'yes' })));
    expect([...rows.keys()]).toEqual(ROWS.map((r) => r.questionId));
    for (const r of ROWS) {
      const body = rows.get(r.questionId)!;
      expect([...body.matchAll(/class="ui-mark ui-mark--/g)], r.questionId).toHaveLength(1);
      // The mark is on the line, hidden from assistive technology; its words are read once, in the status label.
      expect(body).toMatch(/<span class="route-line__node" aria-hidden="true"><span class="ui-mark ui-mark--/);
      expect(body).toMatch(/class="status-label">[^<]*\p{L}/u);
      expect(body.indexOf(`>${r.text}<`)).toBeGreaterThan(-1);
      expect(body.indexOf(`>${r.questionId}<`)).toBeGreaterThan(body.indexOf(r.text));
      expect(body).not.toMatch(/\bv\d+\b|[Vv]ersion \d/);
    }
  });

  it('done with no evidence reads "Done, no evidence attached"; done with evidence reads "Done"; the personal data question reads "Answer: Yes"', () => {
    const rows = rowsOf(render(data(ROWS, { scopeAnswer: 'yes' })));
    expect(rows.get('Q-PP-01')).toContain('class="status-label">Done, no evidence attached<');
    expect(rows.get('Q-PP-02')).toContain('class="status-label">Done<');
    expect(rows.get('Q-PP-GATE-SENSITIVE')).toContain(`class="status-label">${STATUS_MARK_COPY.scope_answered('yes')}<`);
  });

  it('a gated question reads the kit\'s "Does not apply (from your answer to the personal data question)"', () => {
    const rows = rowsOf(render(data([row('Q-PP-13', { kind: 'not_applicable_by_gate', statusText: 'Does not apply' })])));
    expect(rows.get('Q-PP-13')).toContain(`class="status-label">${STATUS_MARK_COPY.does_not_apply}<`);
  });

  it('the state line: the decided-on date, "{n} of {m} in place", open findings only above zero, the seal and good-practice markers, with no leading separator', () => {
    const rows = rowsOf(render(data(ROWS, { changed: { sealNumber: 1, changedQuestions: ['Q-PP-16'], changedFindings: [] } })));
    /** The meta line after the code and the status words. */
    const state = (id: string) => rows.get(id)!.match(/class="route-line__meta"><code class="route-line__code">[^<]*<\/code> · <span class="status-label">[^<]*<\/span>([^<]*)<\/span>/)?.[1];
    expect(state('Q-PP-01')).toBe(' · Oct 2026 · 2 open findings');
    expect(state('Q-PP-02')).toBe(' · 12 Oct 2026');
    expect(state('Q-PP-16')).toBe(' · 1 of 4 in place · changed since seal 1');
    expect(state('Q-PP-17')).toBe(' · good practice changed');
    expect(state('Q-PP-GATE-SENSITIVE')).toBe('');
  });

  it('the whole plate is the link to its question', () => {
    const rows = rowsOf(render(data(ROWS)));
    expect(rows.get('Q-PP-02')).toMatch(/^<a[^>]*class="route-line__link"[^>]*href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-02"/);
    // Nothing on the page is "You are here", "Next question" or folded: the page shows every question.
    const h = render(data(ROWS));
    expect(h).not.toContain('aria-current="step"');
    expect(h).not.toContain(STAGE_LIST_COPY.line.next);
    expect(h).not.toContain('<details');
  });

  it('every question is on one line: one rule round all the topics, each topic a quiet heading with its count, no boxes', () => {
    const h = render(data(ROWS));
    expect([...h.matchAll(/class="route-line route-line--page"/g)]).toHaveLength(1);
    expect(h).toMatch(/<h2 id="module-M1" class="stage-route__topic">Problem Formulation<\/h2><p class="text-muted stage-route__topic-count">4 questions · 0 with no decision<\/p><ol class="route-line__list"/);
    expect(h).not.toMatch(/class="[^"]*\b(card|ui-plate)\b/);
  });
});

describe('All questions: the page\'s head', () => {
  it('a breadcrumb of the project and the stage, then the h1 with the stage\'s plain meaning, then the topics as a quiet line', () => {
    const h = render(data(ROWS));
    expect(h).toMatch(/<nav class="ui-breadcrumb" aria-label="Breadcrumb"><ol[^>]*>[\s\S]*?href="\/orgs\/org-a\/projects\/p1"[^>]*>Project A<\/a>[\s\S]*?aria-current="page">Pre-processing<\/span>/);
    expect(h).toMatch(new RegExp(`<h1[^>]*>Pre-processing</h1><p class="ui-definition" data-definition="${TERM_STAGE_1.id}">${TERM_STAGE_1.definition}</p><p class="stage-route__topics">Problem Formulation · Data Collection &amp; Preparation</p>`));
    expect([...h.matchAll(/<h1/g)]).toHaveLength(1);
  });

  it('the stage\'s count and its tally in words, each kind with its mark; no row of marks, no <progress>, no "%"', () => {
    const d = data(ROWS, { scopeAnswer: 'yes' });
    const h = render(d);
    expect(h).toContain(`<p class="stage-route__count" data-stage-summary="">${ROWS.length} questions</p>`);
    const parts = [...h.matchAll(/<li class="stage-route__tally-part" data-mark-kind="([a-z_]+)"><svg class="ui-mark__shape" width="16"[\s\S]*?<\/svg>([^<]*)<\/li>/g)].map((m) => m[2]);
    expect(parts.join(', ')).toBe(tallyWords(tallyOfRows(ROWS, d.marks)));
    expect(h).not.toContain('ui-route-row');
    expect(h).not.toContain('<progress');
    expect(h).not.toMatch(/\d\s?%/);
  });

  it('the open findings and overdue mitigations are links only above zero', () => {
    const none = render(data(ROWS));
    expect(none).not.toContain('stage-route__followup');
    expect(none).not.toMatch(/\b0 (open finding|overdue mitigation)/);
    const some = render(data(ROWS, { followUp: { openFindings: 3, overdueMitigations: 0 } }));
    expect(some).toMatch(/<a[^>]*href="\/orgs\/org-a\/projects\/p1\/findings"[^>]*>3 open findings<\/a>/);
    expect(some).not.toContain('overdue mitigation');
    expect(some).not.toMatch(/\b0 (open finding|overdue mitigation)/);
    const both = render(data(ROWS, { followUp: { openFindings: 1, overdueMitigations: 2 } }));
    expect(both).toMatch(/>1 open finding<\/a>/);
    expect(both).toMatch(/<a[^>]*href="\/orgs\/org-a\/projects\/p1#pre-processing"[^>]*>2 overdue mitigations<\/a>/);
  });

  it('the seal banner shows only when a seal changed, the review named before it', () => {
    expect(render(data(ROWS))).not.toContain('stage-seal-banner');
    const h = render(data(ROWS, { changed: { sealNumber: 2, changedQuestions: ['Q-PP-16'], changedFindings: [] }, review: { id: 'r1', name: 'Review A' } }));
    expect(h).toMatch(/<div class="stage-route__seal"><strong>Review A:<\/strong> <p class="stage-seal-banner">/);
  });

  it('the head comes in the brief\'s order: breadcrumb, h1, meaning, topics, count and tally, filter, line', () => {
    const h = render(data(ROWS, { followUp: { openFindings: 1, overdueMitigations: 0 } }));
    const order = ['ui-breadcrumb', '<h1', 'data-definition', 'stage-route__topics', 'data-stage-summary', 'stage-route__tally-parts', 'stage-route__followup', 'name="show"', 'route-line--page'].map((s) => h.indexOf(s));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('All questions: the Show filter', () => {
  it('the filters in order with their counts, each a native radio followed by one text node; Changed since seal only with a seal', () => {
    const labels = (h: string) => [...h.matchAll(/<input type="radio" name="show"[^>]*value="([a-z_]+)"[^>]*\/>([^<]*)<\/label>/g)].map((m) => [m[1], m[2]]);
    expect(labels(render(data(ROWS)))).toEqual([
      ['all', ' All 5'], ['no_decision', ' No decision 1'], ['shortfalls', ' Partly or not yet 1'], ['done_without_evidence', ' Done, no evidence attached 1'],
      ['reworded', ' Good practice changed since the decision 1'], ['drafts', ' Not saved in this browser '],
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
