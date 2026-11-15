import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { runningContent } from '@/lib/content/loader';
import { QUESTION_COPY } from '@/lib/question/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';

/**
 * The question page's frame (plan 1C Task 4, cut to slice 1; decision C1 cut): the running question is the page's
 * `h1`, its code line follows it in small type, the form comes next in the main column, and "What good looks like"
 * and "Why this is asked" sit in an `<aside>` after it. `QuestionContent` is the REAL one here (s12-shell.test.tsx
 * mocks it to nothing), so the aside's place in the page is checked; the other slots record nothing and render
 * nothing, and the answer form is real, with the mocks s12-shell.test.tsx gives it.
 */
const empty = () => null;
vi.mock('@/components/decision/CurrentDecision', () => ({ CurrentDecision: empty }));
vi.mock('@/components/review/SealNote', () => ({ SealNote: empty }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: empty }));
vi.mock('@/components/findings/QuestionFindingLink', () => ({ QuestionFindingLink: empty }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),
  SuggestedControls: empty,
}));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn() }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: vi.fn() }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: vi.fn() }));

const { QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);

/** The version the current decision was answered against, and the running wording (FR-CNT-08): the h1 is the running one. */
const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you evaluated whether AI is the right approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Compare simpler options first.', whyAsked: 'A simpler tool may be safer.', reasonPrompt: 'z', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const RUNNING = { ...QUESTION, text: 'Have you checked whether AI is the best approach, compared with simpler options?' } as LoadedQuestion;
const CURRENT = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2,
  optionsInPlace: ['Alternatives analysis'], evidence: [{ id: 'e1' }],
  status: 'done', scopeAnswer: null, reasonCode: null, reason: 'r', decidedBy: null, declaredDate: null,
  enteredBy: { userId: 'u2', name: 'Joseph K.', formerMember: false },
} as unknown as DecisionVersionView;
const SEAL = { sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' };
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: QUESTION, runningQuestion: RUNNING, position: { index: 3, total: 22, previousId: 'Q-PP-03', nextId: 'Q-PP-05' },
  current: CURRENT, historyCount: 2, seals: [SEAL],
  reasonCodes: [], members: [{ userId: 'u1', name: 'Amina N.' }], viewer: { userId: 'u1', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: { findingId: 'f1' }, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};

const render = async (data: QuestionPanelData = PANEL): Promise<string> => renderToStaticMarkup(await QuestionPanelRegions({ data }));
const inOrder = (ns: number[]): boolean => ns.every((n, i) => n >= 0 && (i === 0 || n > ns[i - 1]));
const strip = (html: string): string => html.match(/<nav aria-label="Questions in this stage"[^>]*>([\s\S]*?)<\/nav>/)![1];
/** The visible texts of the strip's children, in order. */
const stripTexts = (html: string): string[] => [...strip(html).matchAll(/<(?:a|span)\b[^>]*>([^<]*)<\/(?:a|span)>/g)].map((m) => m[1]);

describe('the question page frame (slice 1)', () => {
  it('C1 (cut): DOM order is the strip, the h1, current decision, seal note, the form, the way on, the guidance aside, the finding link, the suggestions', async () => {
    const html = await render();
    expect([...html.matchAll(/data-region="([a-z-]+)"/g)].map((m) => m[1]))
      .toEqual(['question', 'current-decision', 'seal-note', 'answer-form', 'evidence-block', 'way-on', 'guidance', 'finding-link', 'suggestions']);
    const at = (s: string) => html.indexOf(s);
    expect(inOrder([
      at('<nav aria-label="Questions in this stage"'), at('<h1 id="question-heading"'), at('data-region="current-decision"'),
      at('data-region="seal-note"'), at('data-region="answer-form"'), at('<aside'), at('data-region="finding-link"'), at('data-region="suggestions"'),
    ]), html).toBe(true);
    // Two columns: the main one holds the question to the form, the guide one the aside, the finding link and the suggestions.
    const main = html.match(/<div class="question-workspace__main">([\s\S]*?)<div class="question-workspace__guide">/)![1];
    expect(main).toContain('data-region="answer-form"');
    expect(main).not.toContain('<aside');
    const guide = html.slice(html.indexOf('<div class="question-workspace__guide">'));
    for (const s of ['<aside', 'data-region="finding-link"', 'data-region="suggestions"']) expect(guide).toContain(s);
    // No inline style is left on the strip or the grid: workspace.css lays them out.
    expect(html).not.toMatch(/<nav[^>]*style=/);
    expect(html).not.toMatch(/<div style="display:grid/);
  });

  it('h1#question-heading is the running question\'s text; the code line is a separate smaller element after it; the question is printed once', async () => {
    const html = await render();
    expect(html).toContain(`<h1 id="question-heading" tabindex="-1" class="question-frame__title">${RUNNING.text}</h1>`);
    expect(html.split(RUNNING.text)).toHaveLength(2);
    expect(html).not.toContain(QUESTION.text);   // the question text the decision was answered against is printed nowhere (the reworded disclosure holds the earlier good practice, not the earlier question)
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // The code line: the page title's own words, in an element of its own directly after the h1 (FocusOnArrival renders nothing).
    expect(html).toMatch(/<\/h1><p class="question-frame__code">Q-PP-01 · Problem Formulation<\/p>/);
    expect(html).not.toMatch(/<h[1-6][^>]*>Q-PP-01 · /);
    // The old visible "Question" heading is gone.
    expect(html).not.toContain('s12-question');
    expect(html).not.toMatch(/<h2[^>]*>Question<\/h2>/);
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-frame__code \{[^}]*font-size: var\(--font-size-small\);[^}]*color: var\(--color-ink-muted\);/);
    expect(css).toMatch(/\.question-frame__title \{[^}]*font-size: var\(--font-size-h2\);/);
  });

  it('the guidance is an aside named by its first heading, with What good looks like and Why this is asked as h2; no heading level is skipped', async () => {
    const html = await render();
    const aside = html.match(/<aside class="question-content" data-region="guidance" aria-labelledby="([^"]+)">([\s\S]*?)<\/aside>/);
    expect(aside, html).not.toBeNull();
    const [, id, body] = aside!;
    expect(body.startsWith(`<h2 id="${id}">What good looks like</h2>`), body).toBe(true);
    const at = (s: string) => body.indexOf(s);
    expect(inOrder([at('What good looks like'), at(QUESTION.expectedPractice), at('<h2>Why this is asked</h2>'), at(QUESTION.whyAsked),
      at('Principle: Proportionality'), at('href="#suggestions">Ways teams address this (3)</a>')]), body).toBe(true);
    expect(html.match(/aria-labelledby="([^"]+)"/g)!.filter((a) => a === `aria-labelledby="${id}"`)).toHaveLength(1);
    // Every heading of the page, in order: the first is the h1, and none is more than one level below the one before.
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1), levels.join(',')).toBe(true);
    expect(html).not.toMatch(/<h3[^>]*>(What good looks like|Why this is asked)<\/h3>/);
  });

  it('a question in no seal has no seal-note section and no "Sealed reviews" heading; one in a seal has both', async () => {
    const none = await render({ ...PANEL, seals: [] });
    expect(none).not.toContain('data-region="seal-note"');
    expect(none).not.toContain('Sealed reviews');
    expect(none).not.toContain('s12-seal-note');
    const sealed = await render();
    expect(sealed).toContain('<section data-region="seal-note" aria-labelledby="s12-seal-note"><h2 id="s12-seal-note">Sealed reviews</h2>');
  });

  it('the strip reads Previous question, the position, Next question, All questions; question 1 has no Previous and the last has no Next; All questions links to the stage page', async () => {
    const stage = '/orgs/acme-health/projects/p1/stages/pre-processing';
    const middle = await render();
    expect(stripTexts(middle)).toEqual(['Previous question', 'Question 4 of 22 in Pre-processing', 'Next question', 'All questions']);
    expect(strip(middle)).toContain(`<a href="${stage}">All questions</a>`);
    expect(strip(middle).match(new RegExp(`href="${stage}"`, 'g'))).toHaveLength(1);
    expect(middle).not.toContain('Back to');
    const first = await render({ ...PANEL, position: { index: 0, total: 22, previousId: null, nextId: 'Q-PP-02' } });
    expect(stripTexts(first)).toEqual(['Question 1 of 22 in Pre-processing', 'Next question', 'All questions']);
    const last = await render({ ...PANEL, position: { index: 21, total: 22, previousId: 'Q-PP-21', nextId: null } });
    expect(stripTexts(last)).toEqual(['Previous question', 'Question 22 of 22 in Pre-processing', 'All questions']);
  });
});

describe('three faults every recorder meets (workshop walk S3, S9)', () => {
  const running = runningContent();
  const Q13 = running.questions.get('Q-PP-13')!;
  const Q01 = running.questions.get('Q-PP-01')!;
  const stagePage = '/orgs/acme-health/projects/p1/stages/pre-processing';
  const sentence = 'Your team answered No to the personal data question, so this question does not apply.';
  /** Q-PP-13, a question with the personal data condition, with the gate at `gateAnswer`. */
  const q13 = (gateAnswer: QuestionPanelData['gateAnswer']): QuestionPanelData =>
    ({ ...PANEL, question: Q13, runningQuestion: Q13, gateAnswer, current: null, historyCount: 0, seals: [] });
  const main = (html: string): string => html.match(/<div class="question-workspace__main">([\s\S]*?)<div class="question-workspace__guide">/)![1];

  it('S3 R1: with the gate at No, a question with the condition says it does not apply, under the code line and before the form; the form is still rendered', async () => {
    expect(Q13.condition, 'Q-PP-13 is conditional in the fixture').toBeDefined();
    const html = await render(q13('no'));
    expect(html.split(sentence)).toHaveLength(2);
    expect(html).toMatch(new RegExp(`<p class="question-frame__code">Q-PP-13 · [^<]*</p><p data-does-not-apply="true">${sentence}</p>`));
    const at = (s: string) => html.indexOf(s);
    expect(inOrder([at('class="question-frame__code"'), at('data-does-not-apply'), at('data-region="current-decision"'), at('data-region="answer-form"')]), html).toBe(true);
    expect(html).toContain('<section data-region="answer-form"');
    expect(html).toMatch(/<form\b/);
  });

  it('S3 R1: the sentence is absent for a question without the condition, for an unanswered gate, and for Yes', async () => {
    expect(Q01.condition).toBeUndefined();
    expect(await render({ ...PANEL, question: Q01, runningQuestion: Q01, gateAnswer: 'no' })).not.toContain('data-does-not-apply');
    for (const gate of [null, 'yes', 'not_sure'] as const) {
      const html = await render(q13(gate));
      expect(html, String(gate)).not.toContain('data-does-not-apply');
      expect(html, String(gate)).not.toContain(sentence);
    }
  });

  it('S3 R1: the finding page\'s closeGate starts with the question page\'s sentence, so the two cannot drift', () => {
    expect(QUESTION_COPY.doesNotApply).toBe(sentence);
    expect(FINDINGS_COPY.finding.closeGate.startsWith(QUESTION_COPY.doesNotApply)).toBe(true);
  });

  it('S9 R3: the foot is the last child of the main column, after the answer form: "Next question: {running text}" to that question, then All questions to the stage page', async () => {
    const html = await render();
    const m = main(html);
    const foot = m.match(/<p class="question-foot" data-region="way-on">([\s\S]*?)<\/p><\/div>$/);
    expect(foot, m.slice(-600)).not.toBeNull();
    expect(m.indexOf('data-region="answer-form"')).toBeLessThan(m.indexOf('data-region="way-on"'));
    const next = running.questions.get('Q-PP-05')!.text;
    expect(foot![1]).toBe(`<a href="${stagePage}/questions/Q-PP-05">Next question: ${next}</a><a href="${stagePage}">All questions</a>`);
    // One navigation landmark: the foot is a paragraph.
    expect(html.match(/<nav\b/g)).toHaveLength(1);
  });

  it('S9 R3: on the last question of the stage the foot says so, with no next link, then All questions', async () => {
    const html = await render({ ...PANEL, position: { index: 21, total: 22, previousId: 'Q-PP-21', nextId: null } });
    const foot = main(html).match(/<p class="question-foot" data-region="way-on">([\s\S]*?)<\/p><\/div>$/)![1];
    expect(foot).toBe(`<span>This is the last question in this stage.</span><a href="${stagePage}">All questions</a>`);
  });

  it('S9 R3: a nextId the running content lacks is a defect: the page throws naming it', async () => {
    await expect(render({ ...PANEL, position: { index: 3, total: 22, previousId: 'Q-PP-03', nextId: 'Q-NOPE-99' } })).rejects.toThrow(/Q-NOPE-99/);
  });

  it('S9 R4: the Findings section and heading are absent when there is no open finding and the person cannot raise one; present otherwise', async () => {
    const none = await render({ ...PANEL, openFinding: null, canRaiseFinding: false });
    expect(none).not.toContain('data-region="finding-link"');
    expect(none).not.toContain('s12-finding-link');
    expect(none).not.toMatch(/<h2[^>]*>Findings<\/h2>/);
    for (const over of [{ openFinding: { findingId: 'f1' }, canRaiseFinding: false }, { openFinding: null, canRaiseFinding: true }]) {
      const html = await render({ ...PANEL, ...over });
      expect(html).toContain('<section data-region="finding-link" aria-labelledby="s12-finding-link"><h2 id="s12-finding-link">Findings</h2>');
    }
  });
});
