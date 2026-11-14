import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { tallyWords } from '@/lib/ui/copy';

/**
 * Lane 7 part 2, the question page's column (owner's decision "Route column", plan 1C decision C2), rendered from fixture
 * data without a database. vitest runs in `node` with no jsdom, so effects do not run: choosing in the select is driven in
 * a browser by e2e/route-column.spec.ts. The stage page's own markup (variant "page") is held against a file taken from
 * the base commit 5c917011, before the column existed.
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

const ROWS = [
  row('Q-PP-01', { kind: 'done', statusText: 'Done', versionNumber: 3, declaredDate: '2026-10', evidenceCount: 0, openFindings: 2 }),
  row('Q-PP-02', { kind: 'done', statusText: 'Done', versionNumber: 1, declaredDate: '2026-10-12', evidenceCount: 1 }),
  row('Q-PP-16', { questionType: 'checklist', kind: 'shortfall', statusText: 'Partly', inPlace: { n: 1, of: 4 }, versionNumber: 2 }),
  row('Q-PP-17', { kind: 'none', moduleId: 'M2', moduleTitle: 'Data Collection & Preparation', reworded: true }),
  row('Q-PP-18', { kind: 'none', moduleId: 'M2', moduleTitle: 'Data Collection & Preparation' }),
  row('Q-PP-30', { kind: 'done', statusText: 'Done', evidenceCount: 2, moduleId: 'M3', moduleTitle: 'Model Development' }),
];

type Show = Parameters<typeof StageWorkspace>[0]['show'];
const column = async (d: StagePageData, currentQuestionId: string, show: Show = 'all') => {
  const { RouteColumn } = await import('@/components/question/RouteColumn');
  return renderToStaticMarkup(createElement(RouteColumn, { data: d, currentQuestionId, show }));
};
/** The column's list (after the row of marks), its details and its plates. */
const listOf = (h: string) => h.slice(h.indexOf('stage-question-list'));
const detailsOf = (h: string) => [...listOf(h).matchAll(/<details([^>]*)><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
  .map((m) => ({ open: /\bopen=""/.test(m[1]), summary: m[2], body: m[3] }));
const platesOf = (h: string) => [...listOf(h).matchAll(/<li[^>]*data-question-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1], body: m[2] }));

describe('The route column: the open question', () => {
  it('the open question\'s plate is the kit\'s current plate (aria-current="step", "You are here"); no other plate is', async () => {
    const plates = platesOf(await column(data(ROWS), 'Q-PP-17'));
    const current = plates.filter((p) => p.body.includes('aria-current="step"'));
    expect(current.map((p) => p.id)).toEqual(['Q-PP-17']);
    expect(current[0].body).toContain('ui-plate--current');
    expect(current[0].body).toContain('You are here');
  });

  it('the open question\'s topic is open and every other topic closed, each summary with the topic\'s name and its tally in words', async () => {
    const d = data(ROWS);
    const ds = detailsOf(await column(d, 'Q-PP-17'));
    expect(ds.map((x) => x.open)).toEqual([false, true, false]);
    const tally = (ids: string[]) => tallyWords({ ...Object.fromEntries([...new Set(ids.map((i) => d.marks[i]))].map((k) => [k, ids.filter((i) => d.marks[i] === k).length])),
      ...(ids.some((i) => d.marks[i] === 'done' && ROWS.find((r) => r.questionId === i)!.evidenceCount === 0) ? { doneNoEvidence: ids.filter((i) => d.marks[i] === 'done' && ROWS.find((r) => r.questionId === i)!.evidenceCount === 0).length } : {}) });
    expect(ds[0].summary).toContain('>Problem Formulation<');
    expect(ds[0].summary).toContain(`>${tally(['Q-PP-01', 'Q-PP-02', 'Q-PP-16'])}<`);
    expect(ds[2].summary).toContain(`>${tally(['Q-PP-30'])}<`);
    // In words, not a second row of marks (ruling L7-10).
    for (const x of ds) expect(x.summary).not.toMatch(/ui-route-row|ui-mark/);
  });

  it('the row of marks has one stop per question of the stage and exactly one aria-current="step", the open question\'s', async () => {
    const h = await column(data(ROWS), 'Q-PP-16');
    const routeRow = h.slice(h.indexOf('ui-route-row'), h.indexOf('stage-question-list'));
    expect([...routeRow.matchAll(/class="ui-route-row__stop[ "]/g)]).toHaveLength(ROWS.length);
    expect([...routeRow.matchAll(/aria-current="step"/g)]).toHaveLength(1);
    expect(routeRow).toMatch(/ui-route-row__stop--current"[^>]*data-mark-kind="partly"/);
  });

  it('the column is a nav named by its heading, the stage\'s name, and ends with the link to all the stage\'s questions', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).toMatch(/^<nav class="route-column" aria-labelledby="route-column-heading"><h2 id="route-column-heading"[^>]*>Pre-processing<\/h2>/);
    expect(h).toMatch(/<a href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing">All questions in this stage<\/a><\/p><\/nav>$/);
  });

  it('the column\'s link reads the words ruled for the project page\'s link to a stage, not the strip\'s "All questions"', () => {
    expect(QUESTION_COPY.stage.allQuestionsInStage).toBe(PROJECT_COPY.stage.allQuestions);
    expect(QUESTION_COPY.stage.allQuestionsInStage).not.toBe(QUESTION_COPY.nav.allQuestions);
  });
});

describe('The route column: after a save', () => {
  /** The list element RouteColumn renders, found in its returned tree (keys do not reach static markup). */
  const listElement = async (d: StagePageData) => {
    const { RouteColumn } = await import('@/components/question/RouteColumn');
    const { StageQuestionList } = await import('@/components/decision/StageQuestionList');
    const find = (n: unknown): { key: string | null } | null => {
      if (n === null || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (const c of n) { const f = find(c); if (f) return f; } return null; }
      const el = n as { type?: unknown; key: string | null; props?: { children?: unknown } };
      if (el.type === StageQuestionList) return el;
      return find(el.props?.children);
    };
    const found = find(RouteColumn({ data: d, currentQuestionId: 'Q-PP-17', show: 'all' }));
    expect(found).not.toBeNull();
    return found!;
  };
  it('a new version of any question of the stage gives the list a new key, so it mounts again and reads the drafts again (review F1)', async () => {
    const before = await listElement(data(ROWS));
    const same = await listElement(data(ROWS.map((r) => ({ ...r }))));
    const saved = await listElement(data(ROWS.map((r) => (r.questionId === 'Q-PP-17' ? { ...r, versionNumber: 1, kind: 'done' as const } : r))));
    expect(before.key).not.toBeNull();
    expect(same.key).toBe(before.key);
    expect(saved.key).not.toBe(before.key);
  });
});

describe('The route column: the filter', () => {
  it('a <select> labelled "Show", one option per filter "{label} {count}" in the stage page\'s order, the given filter chosen; no count on "Not saved yet"', async () => {
    const h = await column(data(ROWS), 'Q-PP-01', 'no_decision');
    expect(h).toMatch(/<label[^>]*for="route-column-show"[^>]*>Show<\/label>/);
    const options = [...h.matchAll(/<option value="([a-z_]+)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], m[2] !== undefined]);
    expect(options).toEqual([
      ['all', 'All 6', false], ['no_decision', 'No decision 2', true], ['shortfalls', 'Partly or not yet 1', false],
      ['done_without_evidence', 'Done, no evidence attached 1', false], ['reworded', 'Good practice changed 1', false], ['drafts', STAGE_LIST_COPY.filters.drafts, false],
    ]);
    expect(h).not.toMatch(/Not saved yet 0/);
  });

  it('the select sits in the GET form with the noscript submit, so ?show works with scripts off', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).toMatch(/<form (?=[^>]*method="get")(?=[^>]*aria-label="Show questions")[^>]*>[\s\S]*<select[^>]*name="show"[\s\S]*<noscript>[\s\S]*<\/form>/);
  });

  it('with a filter given, the matching plates are one flat list and there is no <details>; the empty filter gives the stage page\'s line', async () => {
    const h = await column(data(ROWS), 'Q-PP-01', 'no_decision');
    expect(detailsOf(h)).toHaveLength(0);
    expect(platesOf(h).map((p) => p.id)).toEqual(['Q-PP-17', 'Q-PP-18']);
    expect([...listOf(h).matchAll(/<ul /g)]).toHaveLength(1);
    const none = await column(data(ROWS.filter((r) => r.kind !== 'none')), 'Q-PP-01', 'no_decision');
    expect(none).toContain(STAGE_LIST_COPY.noMatch('No decision').replaceAll("'", '&#x27;'));
    expect(platesOf(none)).toHaveLength(0);
  });

  it('no "Save all", no breadcrumb, no <progress>, no "%"', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).not.toContain('Save all');
    expect(h).not.toContain('data-retry-all');
    expect(h).not.toMatch(/breadcrumb/i);
    expect(h).not.toContain('<progress');
    expect(h).not.toContain('%');
  });

  it('each question\'s text is the whole text of its own element (the claims crawl\'s allow-list rule), never in an attribute', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    for (const r of ROWS) {
      expect(h).toContain(`>${r.text}<`);
      expect(h).not.toMatch(new RegExp(`="[^"]*${r.text.replace(/[?]/g, '\\?')}`));
    }
  });
});

describe('The stage page is unchanged', () => {
  it('variant "page" (the default) renders the stage page\'s markup as the base commit did, byte for byte', async () => {
    const fixtures: Array<[StagePageData, Show]> = [
      [data(ROWS), 'all'],
      [data(ROWS, { changed: { sealNumber: 2, changedQuestions: ['Q-PP-16', 'Q-GONE'], changedFindings: [] }, review: { id: 'r1', name: 'Review A' } }), 'changed_since_seal'],
      [data(ROWS.filter((r) => r.kind !== 'none')), 'no_decision'],
    ];
    const html = fixtures.map(([d, show]) => renderToStaticMarkup(createElement(StageWorkspace, { data: d, show, shown: null }))).join('\n');
    await expect(html).toMatchFileSnapshot('./__snapshots__/route-column.stage-page-5c917011.html');
  });
});
