import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { QUESTION_COPY } from '@/lib/question/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { stageFixture } from '../helpers/stageFixture';

/**
 * The question page's frame, rebuilt to the Route sketch (lane 1 Task 1; assigned.html, workspace-phone-saved.html): the
 * top strip (breadcrumb and the stage's tally, shown from 1160px), the position strip (shown under 1160px), the question
 * in words as the `h1` with its code line after it, the seal note, the decision slot, then the guidance aside, the
 * finding link and the route column. `QuestionContent` and the decision card (through the slot) are the REAL ones here; the slots
 * inside them record nothing and render nothing, and the answer form is real, with the mocks s12-shell.test.tsx gives it.
 */
const empty = () => null;
vi.mock('@/components/decision/CurrentDecision', () => ({ CurrentDecision: empty }));
vi.mock('@/components/review/SealNote', () => ({ SealNote: empty }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: empty }));
vi.mock('@/components/findings/QuestionFindingLink', () => ({ QuestionFindingLink: () => <p>finding link</p> }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),
  SuggestedControls: () => <p data-suggested-controls>the list</p>,
}));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn() }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: vi.fn() }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: vi.fn() }));

const { QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);

const running = runningContent();
const inStage = questionsInStage(running, 'pre-processing');
const textOf = (id: string): string => running.questions.get(id)!.text;
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** The version the current decision was answered against, and the running wording (FR-CNT-08): the h1 is the running one. */
const QUESTION = { ...running.questions.get('Q-PP-04')!, text: 'Have you evaluated whether AI is the right approach?', expectedPractice: 'Compare simpler options first.', whyAsked: 'A simpler tool may be safer.' } as LoadedQuestion;
const RUNNING = { ...QUESTION, text: 'How could the system affect protected or vulnerable groups?' } as LoadedQuestion;
const CURRENT = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-04', versionNumber: 2,
  optionsInPlace: ['Alternatives analysis'], evidence: [{ id: 'e1' }],
  status: 'done', scopeAnswer: null, reasonCode: null, reason: 'r', decidedBy: null, declaredDate: null,
  enteredBy: { userId: 'u2', name: 'Joseph K.', formerMember: false }, receivedAt: '2026-11-10T08:30:00.000Z',
} as unknown as DecisionVersionView;
const SEAL = { sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' };
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: QUESTION, runningQuestion: RUNNING, position: { index: 3, total: 24, previousId: 'Q-PP-03', nextId: 'Q-PP-05' },
  current: CURRENT, historyCount: 2, seals: [SEAL],
  reasonCodes: [], members: [{ userId: 'u1', name: 'Amina N.' }], viewer: { userId: 'u1', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: { findingId: 'f1' }, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const STAGE_HREF = '/orgs/acme-health/projects/p1/stages/pre-processing';
const STAGE = stageFixture({
  marks: { 'Q-PP-01': 'done', 'Q-PP-02': 'done', 'Q-PP-03': 'done', 'Q-PP-04': 'partly', 'Q-PP-05': 'partly', 'Q-PP-06': 'not_yet', 'Q-PP-07': 'not_applicable', 'Q-PP-GATE-SENSITIVE': 'scope_answered' },
  followUp: { openFindings: 11, overdueMitigations: 1 },
});

const render = async (data: QuestionPanelData = PANEL, stage = STAGE): Promise<string> =>
  renderToStaticMarkup(await QuestionPanelRegions({ data, stage, route: <nav aria-label="route">the route</nav> }));
const inOrder = (ns: number[]): boolean => ns.every((n, i) => n >= 0 && (i === 0 || n > ns[i - 1]));
const between = (html: string, start: string, end: string): string => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)) + end.length);
const top = (html: string): string => html.slice(html.indexOf('<div class="question-top"'), html.indexOf('<nav class="position-strip"'));
const strip = (html: string): string => between(html, '<nav class="position-strip"', '</nav>');
/** A link's accessible name as its content gives it: its text, tags dropped (the marks and icons are aria-hidden SVGs). */
const nameOf = (link: string): string => link.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

describe('the question page frame: DOM order', () => {
  it('strip/breadcrumb, h1, code, seal note, the decision card (with the writer\'s finding link in its foot), guidance, route; nothing reordered by CSS', async () => {
    const html = await render();
    const at = (s: string) => html.indexOf(s);
    expect(inOrder([
      at('<div class="question-top"'), at('<nav class="position-strip"'), at('<h1 id="question-heading"'), at('class="question-frame__code"'),
      at('data-region="seal-note"'), at('data-region="answer-form"'), at('class="decision-card__raise"'), at('<aside'), at('<div class="question-workspace__route">'),
    ]), html).toBe(true);
    // The card replaced the stub: no separate region for the slot, the current decision, the finding link or the way on.
    for (const gone of ['data-region="decision-slot"', 'data-region="current-decision"', 'data-region="finding-link"', 'data-region="way-on"']) expect(html, gone).not.toContain(gone);
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).not.toMatch(/^\s*order\s*:/m);
    expect(css).not.toMatch(/flex-direction:\s*(row|column)-reverse/);
  });

  it('the main column holds the question, the seal note and the decision card (the finding link inside it); the guide column the aside alone; the route its own', async () => {
    const html = await render();
    const main = between(html, '<div class="question-workspace__main">', '<div class="question-workspace__guide">');
    for (const s of ['data-region="question"', 'data-region="seal-note"', 'data-region="answer-form"']) expect(main).toContain(s);
    expect(main).not.toContain('<aside');
    const guide = between(html, '<div class="question-workspace__guide">', '<div class="question-workspace__route">');
    expect(guide).toContain('<aside');
    expect(guide).not.toContain('finding link');
    expect(main.slice(main.indexOf('data-region="answer-form"'))).toContain('finding link');
    expect(html.slice(html.indexOf('<div class="question-workspace__route">'))).toContain('the route');
    expect(html).not.toMatch(/<(nav|div)[^>]*style=/);
  });
});

describe('the heading', () => {
  it('h1#question-heading is the running question\'s text, printed once; the code line is a separate smaller element after it', async () => {
    const html = await render();
    expect(html).toContain(`<h1 id="question-heading" tabindex="-1" class="question-frame__title">${RUNNING.text}</h1>`);
    expect(html.split(RUNNING.text)).toHaveLength(2);
    expect(html).not.toContain(QUESTION.text);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`</h1><p class="question-frame__code">Q-PP-04 · ${esc(QUESTION.moduleTitle)}</p>`));
  });

  it('R7: 22px (one ramp step below the sketch\'s 30), the heaviest loaded weight (700: the layout loads 400 to 700), balanced; the code line in 14px', () => {
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-frame__title \{[^}]*font-size: var\(--font-size-h2\);[^}]*font-weight: var\(--font-weight-bold\);[^}]*text-wrap: balance;/);
    expect(css).toMatch(/\.question-frame__code \{[^}]*font-size: var\(--font-size-small\);[^}]*color: var\(--color-ink-muted\);/);
  });

  it('no ring on a script focus at load: the heading draws the focus ring only after keyboard use (HeadingFocusCue marks it)', async () => {
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-frame__title:focus-visible \{\s*outline: none;/);
    expect(css).toMatch(/\.question-frame__title\[data-keyboard-focus\]:focus-visible \{\s*outline: var\(--focus-width\) solid var\(--color-focus\);/);
    const html = await render();
    expect(readFileSync('components/question/HeadingFocusCue.tsx', 'utf8')).toMatch(/^'use client';/);
    // The cue is mounted before FocusOnArrival, so its focus listener is in place when the heading takes focus.
    expect(html).toContain('<h1 id="question-heading"');
  });
});

describe('the top strip (R4), shown from 1160px', () => {
  it('the breadcrumb: project to the project page, stage to the stage page, then "Question n of N", the current page, as text', async () => {
    const html = top(await render());
    expect(html).toMatch(/<nav class="ui-breadcrumb" aria-label="Breadcrumb">/);
    const items = [...html.matchAll(/<li class="ui-breadcrumb__item">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/href="\/orgs\/acme-health\/projects\/p1"[^>]*>Antenatal Risk Triage Model<\/a>/);
    expect(items[1]).toMatch(new RegExp(`href="${STAGE_HREF}"[^>]*>Pre-processing</a>`));
    expect(items[2]).toBe('<span class="ui-breadcrumb__current" aria-current="page">Question 4 of 24</span>');
  });

  it('the tally: each kind above zero, in the kit\'s order, as its mark, the count in bold and the vocabulary\'s words; none at zero', async () => {
    const html = top(await render());
    const tally = between(html, '<ul class="question-top__tally"', '</ul>');
    const items = [...tally.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    /** An item's visible words: its tip (button and popover) and its mark left out. */
    const visible = (i: string) => i.replace(/<span class="ui-term-tip">[\s\S]*?<\/span><\/span><\/span>/, '').replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '');
    const words = items.map(visible);
    // 3 done, 2 partly, 1 not yet, 1 not applicable, the personal data question answered (its vocabulary term, lane 6), 16 with no decision.
    expect(words).toEqual(['3 done', '2 partly', '1 not yet', '1 not applicable', '1 personal data question answered', '16 no decision']);
    for (const i of items) expect(i).toMatch(/^<svg class="ui-mark__shape" data-shape-kind="[a-z_]+" width="16" height="16"[\s\S]*<\/svg><b>\d+<\/b> /);
    expect(tally).toContain('data-mark-kind="done"');
    // Named by a label, not a heading: no heading comes before the page's h1 (fix round 1, M2).
    expect(html).toContain(`<ul class="question-top__tally" role="list" aria-label="${esc(QUESTION_COPY.frame.tallyHeading)}">`);
    expect(html).not.toMatch(/<h[1-6]\b/);
    // The retired "scope question" never shows (vocabulary: personal-data-question-scope-question).
    expect(html).not.toMatch(/scope question/i);
    const few = top(await render(PANEL, stageFixture({ marks: Object.fromEntries(inStage.map((q) => [q.id, 'done'])) })));
    expect([...between(few, '<ul class="question-top__tally"', '</ul>').matchAll(/<li/g)]).toHaveLength(1);
  });

  it('the open findings and the overdue mitigations, each a link only above zero, to the targets StageFollowUpCounts uses; the overdue one with the clock', async () => {
    const html = top(await render());
    expect(html).toMatch(/<a[^>]*href="\/orgs\/acme-health\/projects\/p1\/findings"[^>]*>[\s\S]*?11 open findings[\s\S]*?<\/a>/);
    // Spec 7.1 (design fix S1a-5): an ink link; red only on the clock and the word "overdue".
    expect(html).toMatch(/<a[^>]*class="question-top__overdue"[^>]*href="\/orgs\/acme-health\/projects\/p1#pre-processing"[^>]*>[\s\S]*?<svg class="ui-icon"[\s\S]*?1 <span class="question-top__overdue-word">overdue<\/span> mitigation[\s\S]*?<\/a>/);
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-top__overdue \.ui-icon,\s*\.question-top__overdue-word \{\s*color: var\(--color-overdue\);/);
    expect(css).not.toMatch(/a\.question-top__overdue \{[^}]*color/);
    const one = top(await render(PANEL, stageFixture({ followUp: { openFindings: 1, overdueMitigations: 0 } })));
    expect(one).toContain('1 open finding<');
    expect(one).not.toMatch(/overdue mitigation/);
    const none = top(await render(PANEL, stageFixture({ followUp: { openFindings: 0, overdueMitigations: 0 } })));
    expect(none).not.toMatch(/open finding|overdue mitigation/);
    expect(none).not.toContain('question-top__follow');
  });

  it('owner 11:00 ruling: each defined word carries a TermTip with the vocabulary\'s sentence: finding, mitigation, the status words and the personal data question; not "no decision"', async () => {
    const html = top(await render());
    for (const id of ['finding', 'mitigation']) {
      expect(html).toMatch(new RegExp(`<a[^>]*aria-describedby="term-tip-${id}-def"[^>]*>[\\s\\S]*?<span data-term="${id}">`));
      expect(html).toContain(`aria-label="${esc(QUESTION_COPY.frame.whatIs(id))}"`);
    }
    for (const [id, term] of [['done', 'Done'], ['partly', 'Partly'], ['not-yet', 'Not yet'], ['not-applicable', 'Not applicable']]) {
      expect(html, id).toContain(`<span data-term="${id}">`);
      expect(html, id).toContain(`aria-label="${esc(QUESTION_COPY.frame.whatMeans(term))}"`);
      expect(html, id).toMatch(new RegExp(`<span class="ui-definition" id="term-tip-${id}-def" data-definition="${id}">`));
    }
    // One tip per defined word: seven here (two counts, four statuses, the personal data question); "no decision" has none.
    expect(html.match(/class="ui-term-tip__button"/g)).toHaveLength(7);
    const answered = between(html, 'data-mark-kind="scope_answered"', '</li>');
    expect(answered).toContain('<span data-term="personal-data-question-scope-question">personal data question</span> answered');
    expect(answered).toContain(`aria-label="${esc(QUESTION_COPY.frame.whatIsTerm('the personal data question'))}"`);
    expect(answered).toMatch(/<span class="ui-definition" id="term-tip-personal-data-question-scope-question-def" data-definition="personal-data-question-scope-question">If you answer No, the questions about consent and anonymisation do not apply\.<\/span>/);
    expect(html).not.toMatch(/scope question/i);
    expect(between(html, 'data-mark-kind="no_decision"', '</li>')).not.toContain('ui-term-tip');
  });

  it('a stage list without this question\'s row is a defect, said by name, never "nothing open"', async () => {
    const stage = stageFixture();
    await expect(render(PANEL, { ...stage, rows: stage.rows.filter((r) => r.questionId !== 'Q-PP-04') })).rejects.toThrow(/no row for Q-PP-04/);
  });

  it('fix round 1 (I1): the follow-up counts sit at the right end of the breadcrumb row; the tally is its own row after them', async () => {
    const html = top(await render());
    const at = (s: string) => html.indexOf(s);
    expect(inOrder([at('<nav class="ui-breadcrumb"'), at('<p class="question-top__follow">'), at('<ul class="question-top__tally"')]), html).toBe(true);
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-top \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/\.question-top__tally \{\s*grid-column: 1 \/ -1;/);
  });

});

describe('the position strip, under 1160px (phone sketch)', () => {
  it('previous: chevron, its mark and number; current: its mark and "Question n of N" in bold; next: number, mark, chevron; no All questions', async () => {
    const html = strip(await render());
    expect(html).toMatch(/^<nav class="position-strip" aria-label="Questions in this stage">/);
    const links = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain(`href="${STAGE_HREF}/questions/Q-PP-03"`);
    expect(nameOf(links[0])).toBe(esc(QUESTION_COPY.frame.previous(textOf('Q-PP-03'), 3, 'Done')));
    // The number shows; the words around it are visually hidden, so the shown number is part of the name (WCAG 2.5.3).
    expect(links[0]).toMatch(/data-mark-kind="done"[\s\S]*<span class="visually-hidden">[^<]*\(question <\/span>3<span class="visually-hidden">, Done\)<\/span>/);
    expect(links[0]).not.toContain('aria-label');
    expect(links[1]).toContain(`href="${STAGE_HREF}/questions/Q-PP-05"`);
    expect(nameOf(links[1])).toBe(esc(QUESTION_COPY.frame.next(textOf('Q-PP-05'), 5, 'Partly')));
    expect(html).toMatch(/<p class="position-strip__here" aria-current="step">[\s\S]*data-mark-kind="partly"[\s\S]*<b><span class="position-strip__word">Question <\/span>4 of 24<\/b>/);
    expect(html).toContain(esc(QUESTION_COPY.frame.hereStatus('Partly')));
    expect(html).not.toContain(QUESTION_COPY.nav.allQuestions);
    expect(html).not.toContain(`href="${STAGE_HREF}"`);
  });

  it('question 1 has no previous link and the last no next; previous and next skip a question the personal data answer switched off', async () => {
    const first = strip(await render({ ...PANEL, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' } }));
    expect([...first.matchAll(/<a\b/g)]).toHaveLength(1);
    expect(first).toContain('Next question: ');
    const last = strip(await render({ ...PANEL, position: { index: 23, total: 24, previousId: 'Q-PP-22', nextId: null } }));
    expect([...last.matchAll(/<a\b/g)]).toHaveLength(1);
    expect(last).toContain('Previous question: ');
    // The gate at No: the personal data question's next is Q-PP-15, the 16th of the stage, not the 14th (Q-PP-13 is off).
    const gate = running.questions.get('Q-PP-GATE-SENSITIVE')!;
    const at = inStage.findIndex((q) => q.id === 'Q-PP-15');
    const skip = strip(await render({ ...PANEL, question: gate, runningQuestion: gate, gateAnswer: 'no', current: null, seals: [], position: { index: 12, total: 24, previousId: 'Q-PP-12', nextId: 'Q-PP-15' } }));
    expect(nameOf([...skip.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0])[1])).toBe(esc(QUESTION_COPY.frame.next(textOf('Q-PP-15'), at + 1, 'No decision')));
    expect(at + 1).toBe(16);
  });
});

describe('design fix round 1', () => {
  const css = readFileSync('components/question/workspace.css', 'utf8');
  it('S1a-2: from 1440px the columns are the sketch\'s 312, 512 and 240px', () => {
    expect(css).toMatch(/@media \(width >= 90rem\) \{\s*\.question-workspace \{\s*grid-template-columns: minmax\(0, 312px\) minmax\(0, 512px\) minmax\(0, 240px\);/);
  });
  it('S1a-6 and owner 12:28 (a): the strip at 14px; each tally item one unbreakable unit, so a wrap falls only between items', () => {
    expect(css).toMatch(/\.question-top__tally \{[^}]*font-size: var\(--font-size-small\);/);
    expect(css).toMatch(/\.question-top__follow \{[^}]*font-size: var\(--font-size-small\);/);
    expect(css).toMatch(/\.question-top__tally > li \{[^}]*white-space: nowrap;/);
    expect(css).not.toMatch(/0\.9375rem/);
    expect(readFileSync('components/question/QuestionContent.css', 'utf8')).not.toMatch(/0\.9375rem|0\.8125rem/);
  });
  it('S1b-1: no length of line on a side with no neighbour', async () => {
    const first = strip(await render({ ...PANEL, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' } }));
    expect(first).toContain('class="position-strip__here position-strip__here--first"');
    const last = strip(await render({ ...PANEL, position: { index: 23, total: 24, previousId: 'Q-PP-22', nextId: null } }));
    expect(last).toContain('class="position-strip__here position-strip__here--last"');
    expect(strip(await render())).toContain('class="position-strip__here"');
    expect(css).toMatch(/\.position-strip__here--first::before,\s*\.position-strip__here--last::after \{\s*visibility: hidden;/);
  });
});

describe('fix round 3', () => {
  /** WCAG relative luminance of a #rrggbb colour, and the contrast of two. */
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  it('S1b-N5: the position strip\'s ring is at least 3:1 against the strip\'s surface in the light theme and both dark blocks', () => {
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.position-strip__ring \{[^}]*border: 3px solid var\(--color-action-text\);/);
    expect(css).toMatch(/\.position-strip \{[^}]*background: var\(--color-surface\);/);
    const globals = readFileSync('app/globals.css', 'utf8');
    const ring = [...globals.matchAll(/--color-action-text:\s*(#[0-9A-Fa-f]{6});/g)].map((m) => m[1]);
    const ground = [...globals.matchAll(/--color-surface:\s*(#[0-9A-Fa-f]{6});/g)].map((m) => m[1]);
    expect(ring.length).toBeGreaterThanOrEqual(3);
    expect(ground.length).toBe(ring.length);
    ring.forEach((r, i) => expect(ratio(r, ground[i]), `${r} on ${ground[i]}`).toBeGreaterThanOrEqual(3));
  });
});

describe('the guidance aside', () => {
  it('What good looks like, Why this is asked, the risk areas under it as linked labels (name, then code in small type), then Ways teams address this as one folded details with the list inside', async () => {
    const html = await render();
    const aside = between(html, '<aside', '</aside>');
    const at = (s: string) => aside.indexOf(s);
    const areas = running.questions.get('Q-PP-04')!.gaps;
    expect(areas.length).toBeGreaterThan(0);
    expect(inOrder([at('What good looks like'), at(esc(RUNNING.expectedPractice)), at('Why this is asked'), at(esc(RUNNING.whyAsked)),
      at('Risk areas'), at(`href="/explore/framework#area-card-${areas[0]}"`), at('<details class="question-content__ways"'), at('the list')]), aside).toBe(true);
    const name = running.areas.get(areas[0])!.name;
    expect(aside).toContain(`<a href="/explore/framework#area-card-${areas[0]}">${esc(name)} <small class="question-content__area-code">${areas[0]}</small></a>`);
    expect(aside).not.toContain('Principle:');
    const details = between(aside, '<details class="question-content__ways"', '</details>');
    expect(details).not.toMatch(/<details[^>]*\bopen\b/);
    expect(details).toMatch(/<summary class="question-content__ways-summary"><svg class="ui-icon"[\s\S]*?<\/svg>Ways teams address this \(\d+\)<\/summary>/);
    expect(details).toContain('the list');
    // No second copy of the list, and no section of its own outside the aside.
    expect(html.split('the list')).toHaveLength(2);
    expect(html).not.toContain('data-region="suggestions"');
  });

  it('the personal data question: no risk areas and nothing to suggest, so no list, no label and no folded control', async () => {
    const gate = running.questions.get('Q-PP-GATE-SENSITIVE')!;
    const html = await render({ ...PANEL, question: gate, runningQuestion: gate, current: null, seals: [] });
    const aside = between(html, '<aside', '</aside>');
    expect(aside).not.toContain('Risk areas');
    expect(aside).not.toContain('<details');
    expect(html).not.toContain('Ways teams address this');
  });

  it('coordinator\'s ruling on review S1a-4: the writer\'s finding link is in the decision card\'s foot, after the form; none in the guidance column and no separate Findings section for a writer', async () => {
    const html = await render();
    const card = between(html, 'data-region="answer-form"', 'class="decision-card__more"');
    expect(card.indexOf('<form')).toBeLessThan(card.indexOf('class="decision-card__raise"'));
    expect(card).toContain('finding link');
    expect(html.split('finding link')).toHaveLength(2);
    expect(html).not.toContain('data-region="finding-link"');
    expect(between(html, '<div class="question-workspace__guide">', '<div class="question-workspace__route">')).not.toContain('finding link');
  });
});

describe('the frame states', () => {
  const Q13 = running.questions.get('Q-PP-13')!;
  const sentence = 'Your team answered No to the personal data question, so this question does not apply.';
  const q13 = (gateAnswer: QuestionPanelData['gateAnswer']): QuestionPanelData =>
    ({ ...PANEL, question: Q13, runningQuestion: Q13, gateAnswer, current: null, historyCount: 0, seals: [] });

  it('S3 R1: with the gate at No, a question with the condition says it does not apply, under the code line and before the decision card; the form is still there', async () => {
    const html = await render(q13('no'));
    expect(html.split(sentence)).toHaveLength(2);
    // Design fix S5-N6: the switched-off mark beside the sentence, in ink and semibold (no orange, no red).
    expect(html).toMatch(new RegExp(`<p class="question-frame__code">Q-PP-13 · [^<]*</p><p data-does-not-apply="true" class="question-frame__does-not-apply"><svg class="ui-mark__shape"[^>]*>[\\s\\S]*?</svg>${sentence}</p>`));
    const css = readFileSync('components/question/workspace.css', 'utf8');
    expect(css).toMatch(/\.question-frame__does-not-apply \{[^}]*color: var\(--color-ink\);[^}]*font-weight: var\(--font-weight-semibold\);/);
    expect(html.indexOf('data-does-not-apply')).toBeLessThan(html.indexOf('data-region="answer-form"'));
    expect(html).toMatch(/<form\b/);
  });

  it('S3 R1: the sentence is absent for a question without the condition, for an unanswered gate, and for Yes', async () => {
    for (const gate of [null, 'yes', 'not_sure'] as const) expect(await render(q13(gate)), String(gate)).not.toContain('data-does-not-apply');
    expect(await render({ ...PANEL, gateAnswer: 'no' })).not.toContain('data-does-not-apply');
  });

  it('S3 R1: the finding page\'s closeGate starts with the question page\'s sentence, so the two cannot drift', () => {
    expect(QUESTION_COPY.doesNotApply).toBe(sentence);
    expect(FINDINGS_COPY.finding.closeGate.startsWith(QUESTION_COPY.doesNotApply)).toBe(true);
  });

  it('archived: the banner is at the top of the work area, above both strips', async () => {
    // A reader's page (lane 1 Task 3's ReadingDecision) reads the version's whole shape, so the version here is complete.
    const current = { ...CURRENT, reasonErased: null, withdrawalCode: null, evidence: [] } as unknown as DecisionVersionView;
    const html = await render({ ...PANEL, current, projectArchived: true, canWrite: false, canRaiseFinding: false });
    expect(html.indexOf('This project is archived')).toBeGreaterThan(-1);
    expect(html.indexOf('This project is archived')).toBeLessThan(html.indexOf('<div class="question-top"'));
  });

  it('a question in no seal has no seal-note section; one in a seal has it, above the decision card', async () => {
    expect(await render({ ...PANEL, seals: [] })).not.toContain('data-region="seal-note"');
    const sealed = await render();
    expect(sealed).toContain('<section data-region="seal-note" aria-labelledby="s12-seal-note"><h2 id="s12-seal-note">Sealed reviews</h2>');
    expect(sealed.indexOf('data-region="seal-note"')).toBeLessThan(sealed.indexOf('data-region="answer-form"'));
  });

  it('S9 R4: a reader\'s Findings section is absent when the person cannot raise one, present when they can; a writer has none (the card\'s foot carries the link)', async () => {
    // A reader's page reads the version's whole shape, so the version here is complete (as in the archived case).
    const current = { ...CURRENT, reasonErased: null, withdrawalCode: null, evidence: [] } as unknown as DecisionVersionView;
    const reader = { ...PANEL, current, canWrite: false };
    expect(await render({ ...reader, openFinding: null, canRaiseFinding: false })).not.toContain('data-region="finding-link"');
    expect(await render({ ...PANEL, openFinding: null, canRaiseFinding: true })).not.toContain('data-region="finding-link"');
    expect(await render({ ...reader, openFinding: null, canRaiseFinding: true })).toContain('<section data-region="finding-link" aria-labelledby="s12-finding-link"><h2 id="s12-finding-link">Findings</h2>');
  });

  it('every heading of the page, from the start of its markup, in order: the first is the h1 and none skips a level', async () => {
    const html = await render();
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1), levels.join(',')).toBe(true);
  });
});

describe('print (plan 1C Task 4, spec 7.5)', () => {
  it('@media print hides the strips, the route column and the form controls; keeps the question, the decision text and the guidance', () => {
    const css = readFileSync('components/question/workspace.css', 'utf8');
    const print = css.slice(css.indexOf('@media print'));
    for (const s of ['.question-top', '.position-strip', '.question-workspace__route', '.decision-slot__controls', '.decision-slot .question-foot', '.question-content__ways-summary']) expect(print).toContain(s);
    expect(print).toMatch(/display: none/);
    expect(print).toMatch(/\.question-content__ways > :not\(summary\) \{[^}]*display: block/);
  });
});
