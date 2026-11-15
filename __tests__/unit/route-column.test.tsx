import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { UI_COPY } from '@/lib/ui/copy';
import { TERM_STAGE_1 } from '@/lib/vocabulary/terms';
import { readFileSync } from 'node:fs';

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; owner's answer R1, 15 November 2026: the
 * stage's questions as one line, lane 1 Task 2), rendered from fixture data without a database. vitest runs in `node` with
 * no jsdom, so effects do not run: choosing in the select and opening a folded run are driven in a browser by
 * e2e/route-column.spec.ts.
 */
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));

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

type Show = 'all' | 'no_decision' | 'shortfalls' | 'done_without_evidence' | 'changed_since_seal' | 'reworded' | 'drafts';
const column = async (d: StagePageData, currentQuestionId: string, show: Show = 'all') => {
  const { RouteColumn } = await import('@/components/question/RouteColumn');
  return renderToStaticMarkup(createElement(RouteColumn, { data: d, currentQuestionId, show }));
};
/** The column's list (after the filter). */
const listOf = (h: string) => h.slice(h.indexOf('stage-question-list'));
const detailsOf = (h: string) => [...listOf(h).matchAll(/<details([^>]*)><summary([^>]*)>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
  .map((m) => ({ open: /\bopen=""/.test(m[1]), summary: m[3], body: m[4] }));
/** Each question's row, by id, in document order. A row holds no nested <li>, so the lazy match ends at its own. */
const rowsIn = (fragment: string) => [...fragment.matchAll(/<li[^>]*data-question-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1], body: m[2] }));
const rowsOf = (h: string) => [...listOf(h).matchAll(/<li[^>]*data-question-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1], body: m[2] }));
/** The parts of the line at its top level: a row's id, or a run's title. */
const partsOf = (h: string) => {
  const line = listOf(h);
  const out: string[] = [];
  const re = /<li class="route-line__item route-line__item--run">[\s\S]*?class="route-line__title">([^<]*)<[\s\S]*?<\/details><\/li>|<li[^>]*data-question-id="([^"]+)"[^>]*>[\s\S]*?<\/li>/g;
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
};

/** A 22-question stage, as Pre-processing holds: Q-01 to Q-22, two topics, a mix of statuses. */
const STAGE22 = Array.from({ length: 22 }, (_, i) => {
  const id = `Q-${String(i + 1).padStart(2, '0')}`;
  const kinds: StageRow['kind'][] = ['done', 'done', 'done', 'shortfall', 'shortfall', 'not_applicable', 'none'];
  return row(id, { kind: kinds[i % kinds.length], evidenceCount: 1, moduleId: i < 7 ? 'M1' : 'M2', moduleTitle: i < 7 ? 'Problem Formulation' : 'Data Collection & Preparation' });
});

describe('The route column: one line of the stage\'s questions', () => {
  it('a short stage is one row per question, in stage order, each one link to its question, with no topic disclosure and no row of marks', async () => {
    const h = await column(data(ROWS), 'Q-PP-17');
    expect(rowsOf(h).map((r) => r.id)).toEqual(ROWS.map((r) => r.questionId));
    expect(detailsOf(h)).toHaveLength(0);
    expect(h).not.toContain('ui-route-row');
    expect(h).not.toContain('ui-plate');
    for (const r of rowsOf(h)) {
      expect([...r.body.matchAll(/<a /g)], r.id).toHaveLength(1);
      expect(r.body).toMatch(new RegExp(`^<a [^>]*href="/orgs/org-a/projects/p1/stages/pre-processing/questions/${r.id}"`));
    }
  });

  it('the open question is "You are here" with aria-current="step", and no other row is; its mark sits in the ring', async () => {
    const rows = rowsOf(await column(data(ROWS), 'Q-PP-17'));
    const current = rows.filter((r) => r.body.includes('aria-current="step"'));
    expect(current.map((r) => r.id)).toEqual(['Q-PP-17']);
    expect(current[0].body).toContain(`class="route-line__pin">${STAGE_LIST_COPY.line.youAreHere}<`);
    expect(current[0].body).toMatch(/class="route-line__node route-line__node--here"/);
    expect(rows.filter((r) => r.body.includes(STAGE_LIST_COPY.line.youAreHere)).map((r) => r.id)).toEqual(['Q-PP-17']);
    expect(STAGE_LIST_COPY.line.youAreHere).toBe(UI_COPY.plate.youAreHere);
  });

  it('the open question\'s meta line gives its code, its status in words and its version', async () => {
    const rows = rowsOf(await column(data(ROWS), 'Q-PP-16'));
    const here = rows.find((r) => r.id === 'Q-PP-16')!;
    expect(here.body).toMatch(/class="route-line__meta"><code class="route-line__code">Q-PP-16<\/code> · <span class="status-label">Partly<\/span> · version 2/);
    // Only the open question names its version, as the sketch draws it.
    expect(rows.find((r) => r.id === 'Q-PP-01')!.body).not.toMatch(/version \d/);
  });

  it('the next question that applies leads its meta line with "Next question"; a question switched off by the personal data answer is passed over', async () => {
    const gated = [...ROWS.slice(0, 3), row('Q-PP-15', { kind: 'not_applicable_by_gate', statusText: 'Does not apply' }), ...ROWS.slice(3)];
    const rows = rowsOf(await column(data(gated), 'Q-PP-02'));
    const next = rows.filter((r) => r.body.includes(STAGE_LIST_COPY.line.next));
    expect(next.map((r) => r.id)).toEqual(['Q-PP-16']);
    expect(next[0].body).toMatch(new RegExp(`class="route-line__meta"><span class="route-line__next">${STAGE_LIST_COPY.line.next}</span> · <code`));
    // The last question has no next.
    expect((await column(data(ROWS), 'Q-PP-30')).includes(STAGE_LIST_COPY.line.next)).toBe(false);
  });

  it('every row\'s mark is the kit\'s StatusMark at 24 px (the open one inside the ring), hidden from assistive technology beside the status words', async () => {
    for (const r of rowsOf(await column(data(ROWS), 'Q-PP-17'))) {
      expect(r.body, r.id).toMatch(/<span class="route-line__node[^"]*" aria-hidden="true"><span class="ui-mark ui-mark--[a-z_]+" data-mark-kind="[a-z_]+"><svg class="ui-mark__shape" width="24" height="24"/);
      expect(r.body, r.id).toMatch(/<span class="status-label">[^<]*\p{L}/u);
    }
  });

  it('each question\'s words are clamped to two lines by its own class, the whole text still in the markup', () => {
    const css = readFileSync('components/question/route-line.css', 'utf8');
    expect(css).toMatch(/\.route-line__title\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*\}/);
    expect(css).toMatch(/\.route-line__title\s*\{[^}]*overflow:\s*hidden;[^}]*\}/);
  });

  it('design fix 1: every mark on the line has a ground halo of at least 3 px round its shape, the no-decision dot a 16 px disc (S2-1)', () => {
    const css = readFileSync('components/question/route-line.css', 'utf8');
    const radius = (sel: string) => Number(css.match(new RegExp(`${sel}\\s*\\{[^}]*radial-gradient\\(circle closest-side, var\\(--color-ground\\) (\\d+(?:\\.\\d+)?)px`))?.[1]);
    // The kit's ring shapes reach about 9.5 px from their centre at 24 px; the no-decision dot 3.5 px.
    expect(radius('\\.route-line__node')).toBeGreaterThanOrEqual(9.5 + 3);
    expect(radius('\\.route-line__node--dot')).toBeGreaterThanOrEqual(8);
  });

  it('design fix 1: the column starts on the main column\'s top edge (no top padding of its own, S1a-1)', () => {
    const css = readFileSync('components/question/route-column.css', 'utf8');
    expect(css).toMatch(/\.route-column\s*\{[^}]*padding-block-start:\s*0;/);
  });

  it('design fix 1: the filter is a small control: an auto-width select, 14 px, at least 24 px tall (S2-2)', () => {
    const css = readFileSync('components/question/route-column.css', 'utf8');
    const select = css.match(/\.route-filter__select\s*\{([^}]*)\}/)![1];
    expect(select).toMatch(/inline-size:\s*auto;/);
    expect(select).toMatch(/font-size:\s*var\(--font-size-small\);/);
    expect(Number(select.match(/min-block-size:\s*(\d+)px;/)![1])).toBeGreaterThanOrEqual(24);
    expect(css).not.toMatch(/\.route-filter__wrap\s*\{[^}]*flex:\s*1/);
  });

  it('design fix 1: the meta line and a run\'s tally are 14 px (spec 7.4: 13 only for legal small print, S2-5)', () => {
    const css = readFileSync('components/question/route-line.css', 'utf8');
    expect(css).not.toContain('--font-size-legal');
    // Fix round 3 (S1a-6's remainder): no 15 px left on the line; 14 and 16 are the ramp's steps here.
    expect(css).not.toMatch(/0\.9375rem|15px/);
    for (const sel of ['route-line__meta', 'route-line__tally-words']) {
      expect(css).toMatch(new RegExp(`\\.${sel}\\s*\\{[^}]*font-size:\\s*var\\(--font-size-small\\);`));
    }
  });

  it('the small filter keeps 16 px text on a touch screen, so a phone does not zoom on it; 14 px elsewhere', () => {
    const css = readFileSync('components/question/route-column.css', 'utf8');
    expect(css).toMatch(/\.route-filter__select\s*\{[^}]*font-size:\s*var\(--font-size-small\);/);
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.route-filter__select\s*\{[^}]*font-size:\s*var\(--font-size-body\);[^}]*\}\s*\}/);
  });

  it('the column is a nav named by its heading, the stage\'s name, and ends with the link to all the stage\'s questions', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).toMatch(/^<nav class="route-column" aria-labelledby="route-column-heading"><h2 id="route-column-heading"[^>]*>Pre-processing<\/h2>/);
    expect(h).toMatch(/<a href="\/orgs\/org-a\/projects\/p1\/stages\/pre-processing">All questions in this stage<\/a><\/p><\/nav>$/);
  });

  it('under the heading, the stage\'s plain meaning (its first-use definition) and the line\'s one sentence, which never says "stop" or "line"', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).toMatch(new RegExp(`</h2><p class="ui-definition" data-definition="${TERM_STAGE_1.id}">${TERM_STAGE_1.definition}</p><p class="route-column__intro">${QUESTION_COPY.stage.routeIntro}</p>`));
    const text = h.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\b(stop|stops|line)\b/i);
  });

  it('the column\'s link reads the words ruled for the project page\'s link to a stage, not the strip\'s "All questions"', () => {
    expect(QUESTION_COPY.stage.allQuestionsInStage).toBe(PROJECT_COPY.stage.allQuestions);
    expect(QUESTION_COPY.stage.allQuestionsInStage).not.toBe(QUESTION_COPY.nav.allQuestions);
  });
});

describe('The route column: its open and next question', () => {
  it('an open question that is not among the stage\'s rows is a mistake in the page: it fails loudly outside production, never a column with no "You are here" (silent-failure review F1)', async () => {
    await expect(column(data(ROWS), 'Q-NOT-HERE')).rejects.toThrow(/RouteColumn: the open question is not in the stage's rows/);
  });

  it('the page may give the next question itself (the panel\'s position.nextId, the Next button\'s own); the column then marks that one (review F2)', async () => {
    const { RouteColumn } = await import('@/components/question/RouteColumn');
    const h = renderToStaticMarkup(createElement(RouteColumn, { data: data(ROWS), currentQuestionId: 'Q-PP-01', show: 'all', nextQuestionId: 'Q-PP-16' }));
    expect(rowsOf(h).filter((r) => r.body.includes(STAGE_LIST_COPY.line.next)).map((r) => r.id)).toEqual(['Q-PP-16']);
  });
});

describe('The route column: fix round 5, no first-use tips in the column', () => {
  it('a row whose words use a defined term gets no (i) in the column: it is a <nav>, which the first-use rule does not read, and a tip there could repeat one the page shows (lead\'s ruling R2)', async () => {
    const MC = 'Have you created or updated a model card for this model?';
    const h = await column(data([row('Q-PP-01'), row('Q-PP-02', { text: MC }), row('Q-PP-03')]), 'Q-PP-01');
    expect(h).not.toContain('ui-term-tip');
    expect(h).not.toContain('route-line__tips');
  });
});

describe('The route column: folded runs', () => {
  it('in a 22-question stage, the questions away from the open one fold into one run before and one after; the open and the next show', async () => {
    const h = await column(data(STAGE22), 'Q-04');
    expect(partsOf(h)).toEqual(['Questions 1 and 2', 'Q-03', 'Q-04', 'Q-05', 'Q-06', 'Questions 7 to 22']);
  });

  it('a run is a disclosure that opens in place (works without script): every question of the stage stays one link away, in stage order', async () => {
    const h = await column(data(STAGE22), 'Q-04');
    const runs = detailsOf(h);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => !r.open)).toBe(true);
    expect(rowsIn(runs[1].body).map((r) => r.id)).toEqual(STAGE22.slice(6).map((r) => r.questionId));
    expect(rowsOf(h).map((r) => r.id)).toEqual(STAGE22.map((r) => r.questionId));
  });

  it('a run\'s summary: its questions\' numbers in bold words, one small mark per question in order (16 px), and its tally in words', async () => {
    const d = data(STAGE22);
    const run = detailsOf(await column(d, 'Q-04'))[1];
    expect(run.summary).toContain('class="route-line__title">Questions 7 to 22<');
    // Read aloud (or as text) the label and the tally are two phrases, not one run of numbers: "Questions 7 to 22, 4 done".
    expect(run.summary).toMatch(/class="route-line__title">Questions 7 to 22<\/span><span class="visually-hidden">, <\/span><span class="route-line__tally">/);
    const marks = [...run.summary.matchAll(/<svg class="ui-mark__shape" width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(marks).toEqual(Array(16).fill(16));
    const runRows = STAGE22.slice(6);
    const { tallyOfRows, lineTallyWords } = await import('@/lib/question/route');
    expect(run.summary).toContain(`class="route-line__tally-words">${lineTallyWords(tallyOfRows(runRows, d.marks))}<`);
    expect(lineTallyWords(tallyOfRows(runRows, d.marks))).toContain(' · ');
  });

  it('the open and the next question are never folded; a short stage folds nothing', async () => {
    for (const at of [1, 7, 15, 21, 22]) {
      const cur = `Q-${String(at).padStart(2, '0')}`;
      const nxt = at < 22 ? `Q-${String(at + 1).padStart(2, '0')}` : null;
      const top = partsOf(await column(data(STAGE22), cur));
      expect(top, cur).toContain(cur);
      if (nxt !== null) expect(top, cur).toContain(nxt);
    }
    expect(detailsOf(await column(data(STAGE22.slice(0, 8)), 'Q-04'))).toHaveLength(0);
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
  it('a small <select> labelled "Show", one option per filter "{label} {count}" in spec 8\'s words and the stage page\'s order; no count on "Not saved in this browser"', async () => {
    const h = await column(data(ROWS), 'Q-PP-01', 'no_decision');
    expect(h).toMatch(/<label[^>]*for="route-column-show"[^>]*>Show<\/label>/);
    expect(h).toMatch(/<select[^>]*class="route-filter__select"[^>]*id="route-column-show"|<select[^>]*id="route-column-show"[^>]*class="route-filter__select"/);
    const options = [...h.matchAll(/<option value="([a-z_]+)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], m[2] !== undefined]);
    expect(options).toEqual([
      ['all', 'All 6', false], ['no_decision', 'No decision 2', true], ['shortfalls', 'Partly or not yet 1', false],
      ['done_without_evidence', 'Done, no evidence attached 1', false], ['reworded', 'Good practice changed since the decision 1', false],
      ['drafts', 'Not saved in this browser', false],
    ]);
    expect(STAGE_LIST_COPY.filters.drafts).toBe('Not saved in this browser');
    expect(h).not.toMatch(/Not saved in this browser 0/);
  });

  it('the select sits in the GET form with the noscript submit, so ?show works with scripts off', async () => {
    const h = await column(data(ROWS), 'Q-PP-01');
    expect(h).toMatch(/<form (?=[^>]*method="get")(?=[^>]*aria-label="Show questions")[^>]*>[\s\S]*<select[^>]*name="show"[\s\S]*<noscript>[\s\S]*<\/form>/);
    // The filter comes before the line.
    expect(h.indexOf('name="show"')).toBeLessThan(h.indexOf('data-question-id'));
  });

  it('with a filter given, the matching plates are one flat list and there is no <details>; the empty filter gives the stage page\'s line', async () => {
    const h = await column(data(STAGE22), 'Q-04', 'no_decision');
    expect(detailsOf(h)).toHaveLength(0);
    expect(rowsOf(h).map((p) => p.id)).toEqual(STAGE22.filter((r) => r.kind === 'none').map((r) => r.questionId));
    expect([...listOf(h).matchAll(/<ol /g)]).toHaveLength(1);
    const none = await column(data(ROWS.filter((r) => r.kind !== 'none')), 'Q-PP-01', 'no_decision');
    expect(none).toContain(STAGE_LIST_COPY.noMatch('No decision').replaceAll("'", '&#x27;'));
    expect(rowsOf(none)).toHaveLength(0);
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
