import { Fragment, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FollowUpItem, SealView, StageCounts, StageReviewView } from '@/types/api';
import { STAGES, type Stage } from '@/types/record';
import type { StatusMarkKind } from '@/components/ui/types';
import { projectActions } from '@/lib/projects/can';
import { PROJECT_COPY } from '@/lib/project/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
import { UI_COPY } from '@/lib/ui/copy';
import { tallyOf } from '@/lib/ui/marks';
import {
  TERM_ACCEPTED_RISK, TERM_DOES_NOT_APPLY, TERM_DONE, TERM_FINDING, TERM_MITIGATION, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY,
  TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3, TERM_STAGE_REVIEW,
} from '@/lib/vocabulary/terms';
import type { ProjectOverviewData } from '@/lib/data/projects';
import type { ProjectRoutes, StageRoute } from '@/lib/project/routes';
import type { ContinueTarget } from '@/lib/home/types';

/**
 * S-10 rebuilt to the Route sketch (lane 4 Task A; spec 9.2, 7.1, 7.2, 7.5; plan 1C Task 8; owner ruling R5): each stage is
 * a vertical line whose sections are stops, in this order: the stage's name, Still open in this stage, Recorded so far,
 * Reviews, and a last stop with the next question and "All questions in this stage". The page's one primary action sits on
 * the line of the stage the person last saved in; the quiet "This project" row is at the foot with Archive last.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));

const { ProjectPage } = await import('@/components/project/ProjectPage');
const { ProjectActions } = await import('@/components/project/ProjectActions');
const { ArchiveProjectControl } = await import('@/components/project/ArchiveProjectControl');

const P = PROJECT_COPY;
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
const ALL_DECIDED: StageCounts = { ...ZERO, noDecision: 0, byStatus: { done: 24, partly: 0, not_yet: 0, not_applicable: 0 } };

/** A stage's route as the loader shapes it, from counts: one stop per question, the no-decision ones named in order. */
function routeFor(stage: Stage, c: StageCounts): StageRoute {
  const kinds: StatusMarkKind[] = [
    ...Array<StatusMarkKind>(c.byStatus.done).fill('done'), ...Array<StatusMarkKind>(c.byStatus.partly).fill('partly'),
    ...Array<StatusMarkKind>(c.byStatus.not_yet).fill('not_yet'), ...Array<StatusMarkKind>(c.byStatus.not_applicable).fill('not_applicable'),
    ...Array<StatusMarkKind>(c.notApplicableByGate).fill('does_not_apply'), ...Array<StatusMarkKind>(c.noDecision).fill('no_decision'),
  ];
  while (kinds.length < c.questions) kinds.push('scope_answered');
  const stops = kinds.map((kind, i) => ({
    id: `${stage}-q${i + 1}`, kind, title: `Question ${i + 1} of ${stage}`, href: `/orgs/o/projects/p1/stages/${stage}/questions/${stage}-q${i + 1}`, current: false,
  }));
  return {
    stops,
    tally: tallyOf(kinds, c.doneWithoutEvidence),
    noDecision: stops.filter((s) => s.kind === 'no_decision').map((s) => ({ id: s.id, text: s.title, href: s.href })),
  };
}

type Over = { role?: Parameters<typeof projectActions>[0]; archived?: boolean; counts?: Partial<Record<Stage, StageCounts>>; descriptiveLine?: string;
  followUp?: Partial<Record<Stage, { items: FollowUpItem[]; cannotAct: FollowUpItem[] }>>; reviews?: Partial<Record<Stage, StageReviewView[]>> };

function data(o: Over = {}): ProjectOverviewData {
  const archived = o.archived ?? false;
  const counts = Object.fromEntries(STAGES.map((s) => [s, o.counts?.[s] ?? COUNTS])) as Record<Stage, StageCounts>;
  return {
    orgSlug: 'o', orgName: 'Org', project: { id: 'p1', name: 'Maternal-risk triage', descriptiveLine: o.descriptiveLine ?? 'Classification, health', archived },
    counts,
    followUp: Object.fromEntries(STAGES.map((s) => [s, o.followUp?.[s] ?? { items: [], cannotAct: [] }])) as ProjectOverviewData['followUp'],
    reviews: Object.fromEntries(STAGES.map((s) => [s, o.reviews?.[s] ?? []])) as ProjectOverviewData['reviews'],
    can: projectActions(o.role ?? 'owner', archived),
  };
}
const routesOf = (d: ProjectOverviewData): ProjectRoutes => Object.fromEntries(STAGES.map((s) => [s, routeFor(s, d.counts[s])])) as ProjectRoutes;
const render = (o: Over = {}, continueTo: ContinueTarget | null = null) => {
  const d = data(o);
  return renderToStaticMarkup(<ProjectPage data={d} routes={routesOf(d)} continueTo={continueTo} />);
};

/** Each stage's line, from its opening tag to the next line (or the share line after the last). */
function lines(html: string): Record<Stage, string> {
  const out = {} as Record<Stage, string>;
  for (const [i, s] of STAGES.entries()) {
    const start = html.indexOf(`<section class="stage-line" id="${s}"`);
    expect(start, `${s}: its line`).toBeGreaterThan(-1);
    const next = i + 1 < STAGES.length ? html.indexOf(`<section class="stage-line" id="${STAGES[i + 1]}"`) : html.indexOf(P.overview.shareLine);
    out[s] = html.slice(start, next);
  }
  return out;
}
/** The stops of a line, in order, by their modifier class. */
const stopsOf = (line: string) => [...line.matchAll(/<div class="stage-line__stop stage-line__stop--([a-z]+)"/g)].map((m) => m[1]);
/** The markup of one stop of a line, up to the next stop. */
function stop(line: string, name: string): string {
  const start = line.indexOf(`<div class="stage-line__stop stage-line__stop--${name}"`);
  expect(start, `the ${name} stop`).toBeGreaterThan(-1);
  const next = line.indexOf('<div class="stage-line__stop stage-line__stop--', start + 10);
  return line.slice(start, next === -1 ? undefined : next);
}
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const ITEM: FollowUpItem = {
  mitigationId: 'm1', versionId: 'v1', findingId: 'f1', projectId: 'p1', stage: 'pre-processing', what: 'Collect a further 1,500 labelled records',
  owner: { userId: 'u1', name: 'Joseph Mugisha', formerMember: false }, dueDate: '2026-09-30', status: 'in_progress', overdue: true, ownerCanAct: true,
};
const SEAL: SealView = {
  id: 's1', reviewId: 'r1', sealNumber: 1, fingerprint: 'a'.repeat(64), sealedBy: { userId: 'u1', name: 'Grace', formerMember: false },
  sealedByRole: 'owner', sealedAt: '2026-11-11T08:00:00.000Z', contentSemver: '0.0.1-fixture', bytesMatch: true,
};
const REVIEW: StageReviewView = {
  id: 'r1', projectId: 'p1', stage: 'pre-processing', numberInStage: 1, name: 'Ethics protocol submission', preparedFor: null,
  openedBy: { userId: 'u1', name: 'Grace', formerMember: false }, openedAt: '2026-11-01T08:00:00.000Z',
  latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased: null, latestSealUnreadable: false,
};

describe('S-10 as three lines of stops (Route R5)', () => {
  it('9.2: per stage, in order: the stage, Still open in this stage, Recorded so far, Reviews, then the last stop', () => {
    for (const line of Object.values(lines(render()))) {
      expect(stopsOf(line)).toEqual(['head', 'open', 'recorded', 'reviews', 'last']);
      const at = [/<h2 id="[a-z-]+">/, `>${S.stillOpen}</h3>`, `>${S.recorded}</h3>`, `>${P.reviewsHeading}</h3>`, `>${S.allQuestions}</a>`]
        .map((w) => (typeof w === 'string' ? line.indexOf(w) : line.search(w)));
      expect(at.every((n) => n > -1), at.join(',')).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('9.2: each stage is a section named by its heading; ids and data-stage are the stages, so other pages link #<stage>', () => {
    const html = render();
    const sections = [...html.matchAll(/<section class="stage-line" id="([^"]+)" data-stage="([^"]+)" aria-labelledby="([^"]+)">/g)];
    expect(sections.map((m) => m[1])).toEqual([...STAGES]);
    expect(sections.map((m) => m[2])).toEqual([...STAGES]);
    for (const [i, m] of sections.entries()) expect(html).toMatch(new RegExp(`<h2 id="${m[3]}"><span data-term="stage-${i + 1}">${P.stageNames[STAGES[i]]}</span></h2>`));
    expect(html).not.toMatch(/<details|stage-column|stage-list__columns/);
  });

  it('D1 X-5: under each stage\'s name, its plain meaning (the vocabulary\'s definition) and its number of questions', () => {
    const l = lines(render());
    for (const [s, term] of [['pre-processing', TERM_STAGE_1], ['in-processing', TERM_STAGE_2], ['post-processing', TERM_STAGE_3]] as const) {
      const head = stop(l[s], 'head');
      // The definition is the element right after the heading (the first-use rule's "beside"), the count after it.
      expect(head).toMatch(new RegExp(`</h2><p class="ui-definition" data-definition="${term.id}">`));
      expect(head).toContain(`>${term.definition}</p><p class="stage-line__count">24 questions</p>`);
    }
    expect(JSON.stringify(P)).not.toContain('Problem formulation; data collection');
  });

  it('9.2 (owner 15 Nov 19:20, "Count, not names"): Still open counts the questions with no decision as one link to the filtered list and names none of them', () => {
    const l = lines(render({ counts: { 'in-processing': { ...COUNTS, noDecision: 2 }, 'post-processing': { ...COUNTS, noDecision: 0 } } }));
    const pre = stop(l['pre-processing'], 'open');
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/stages/pre-processing?show=no_decision">${S.noDecisionQuestions(9)}</a>`);
    // No question title from the route's list, no list of them, and no "and k more".
    for (const n of [15, 16, 17]) expect(pre).not.toContain(`Question ${n} of pre-processing`);
    expect(pre).not.toContain('stage-line__named');
    expect(pre).not.toMatch(/and \d+ more/);
    const inp = stop(l['in-processing'], 'open');
    expect(inp).toContain(`>${S.noDecisionQuestions(2)}</a>`);
    expect(inp).not.toContain('stage-line__named');
    // None open: the line is left out.
    expect(stop(l['post-processing'], 'open')).not.toContain('with no decision');
  });

  it('9.2 FR-PRJ-02: open findings link to the stage\'s findings, keep "(k of them with no mitigation yet)"; nothing open reads "Nothing is open in this stage."', () => {
    const l = lines(render({ counts: { 'post-processing': { ...ALL_DECIDED } } }));
    expect(stop(l['pre-processing'], 'open')).toContain(`<a href="/orgs/o/projects/p1/findings?stage=pre-processing">${S.openFindings}`.replace(S.openFindings, '3 open findings'));
    expect(text(stop(l['pre-processing'], 'open'))).toContain('3 open findings (1 of them with no mitigation yet)');
    expect(stop(l['post-processing'], 'open')).toContain(`<p>${S.nothingOpen}</p>`);
    expect(stop(l['pre-processing'], 'open')).not.toContain(S.nothingOpen);
  });

  it('spec 7.1: each overdue mitigation is its own plate; red only on the word Overdue and "was due <date>"; the name in ink', () => {
    const second: FollowUpItem = { ...ITEM, mitigationId: 'm2', findingId: 'f2', what: null, owner: { userId: 'u2', name: 'Asha Assessor', formerMember: false }, status: 'planned', dueDate: '2026-10-28' };
    const html = render({ followUp: { 'pre-processing': { items: [ITEM, second], cannotAct: [] } }, counts: { 'pre-processing': { ...COUNTS, overdueMitigations: 2 } } });
    const open = stop(lines(html)['pre-processing'], 'open');
    expect(text(open)).toContain(`${PROJECT_COPY.followUp.overdue}: ${P.mitigationCount(2)}`);
    // Two plates, never one run-together line: each a kit item plate whose title links to its finding.
    const plates = [...open.matchAll(/<div class="ui-plate ui-plate--link">([\s\S]*?)<\/div><\/div>/g)].map((m) => m[1]);
    expect(plates).toHaveLength(2);
    // FR-FUP-01's order: overdue first, then the earlier due date.
    expect(text(plates[0])).toContain(`${PROJECT_COPY.followUp.assignedTo('Joseph Mugisha')} · In progress · ${P.wasDue('30 Sep 2026')}`);
    expect(plates[1]).toContain('<a class="ui-plate__link" href="/orgs/o/projects/p1/findings/f2">Text erased at your organisation&#x27;s request.</a>');
    expect(text(plates[1])).toBe(`Text erased at your organisation&#x27;s request.${PROJECT_COPY.followUp.assignedTo('Asha Assessor')} · Planned · ${P.wasDue('28 Oct 2026')}`);
    // The red elements hold only "Overdue" and "was due <date>"; the person's name is outside every one of them.
    const red = [...open.matchAll(/<span class="followup-overdue">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]));
    expect(red).toEqual([PROJECT_COPY.followUp.overdue, P.wasDue('30 Sep 2026'), P.wasDue('28 Oct 2026')]);
    expect(open).toMatch(/<span class="followup-overdue"><svg class="ui-icon"[^>]*aria-hidden="true"/);
    expect(open).not.toMatch(/followup-overdue[^>]*>[^<]*(Joseph|Asha)/);
    expect(open).toMatch(/<span class="status-label">Planned<\/span>/);
  });

  it('owner 15 Nov 19:20: Still open shows overdue mitigations only; a mitigation not yet due, or whose person can no longer act, adds no "Not overdue" line and no plate', () => {
    const later: FollowUpItem = { ...ITEM, mitigationId: 'm3', findingId: 'f3', what: 'Re-run the check', overdue: false, dueDate: '2026-12-20', status: 'planned' };
    const stuck: FollowUpItem = { ...ITEM, mitigationId: 'm4', findingId: 'f4', what: 'Write the guide', overdue: false, dueDate: '2026-12-21', ownerCanAct: false, owner: { userId: 'u9', name: 'Former Person', formerMember: true } };
    const html = render({ followUp: { 'pre-processing': { items: [later], cannotAct: [stuck] } }, counts: { 'pre-processing': { ...COUNTS, overdueMitigations: 0, openMitigations: 2 } } });
    const open = stop(lines(html)['pre-processing'], 'open');
    expect(text(open)).toContain(P.noOverdue);
    expect(open).not.toContain('Not overdue');
    expect(open).not.toContain('ui-plate');
    expect(open).not.toContain('Re-run the check');
    // An open mitigation that is not overdue keeps "Nothing is open" away.
    const only = render({ counts: { 'pre-processing': { ...ZERO, noDecision: 0, openMitigations: 1 } }, followUp: { 'pre-processing': { items: [later], cannotAct: [] } } });
    expect(stop(lines(only)['pre-processing'], 'open')).not.toContain(S.nothingOpen);
  });

  it('7.2 C5: Recorded so far is the kit\'s route row, one stop per question with no link (each question is reached by name), labelled with the stage, and the tally with the evidence caveat', () => {
    const l = lines(render({ counts: { 'in-processing': { ...COUNTS, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 0, noDecision: 22, notApplicableByGate: 1 } } }));
    const pre = stop(l['pre-processing'], 'recorded');
    expect(pre).toContain(`<ol class="ui-route-row__stops" role="list" aria-label="${P.routeLabel('Pre-processing')}">`);
    expect(pre.match(/<li class="ui-route-row__stop/g)).toHaveLength(24);
    expect(pre.match(/<span class="ui-route-row__point"><svg class="ui-mark__shape"/g)).toHaveLength(24);
    // No link in the row: about 75 fewer keyboard stops before "This project" (lead's ruling on C5).
    expect(pre).not.toContain('<a ');
    expect(pre).toContain('<span class="visually-hidden"><span>Question 1 of pre-processing</span>: Done</span>');
    // The tally as the kit's list keyed by the marks, read in the tally's words and order (no decision is left out here).
    const tally = (rec: string) => [...rec.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => text(m[1].replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, ''))).join(', ');
    expect(tally(pre)).toBe('7 done (2 with no evidence attached), 3 partly, 2 not yet, 2 not applicable, 1 answered');
    expect(tally(stop(l['in-processing'], 'recorded'))).toBe('1 done, 1 does not apply');
    expect(text(pre)).toContain('1 accepted risk, 1 document issued');
    expect(render()).not.toMatch(/\b(total|overall|in all)\b|%|\b21 done\b/i);
  });

  it('barely started: every line shows its row of No decision marks and "No decisions recorded yet"', () => {
    const html = render({ counts: { 'pre-processing': ZERO, 'in-processing': ZERO, 'post-processing': ZERO } });
    for (const line of Object.values(lines(html))) {
      const rec = stop(line, 'recorded');
      expect(rec.match(/data-mark-kind="no_decision"/g)).toHaveLength(24);
      expect(rec).toContain(`<p class="ui-route-row__tally">${UI_COPY.tally.none}</p>`);
      expect(rec).not.toMatch(/accepted risk|issued/);
      expect(text(stop(line, 'last'))).toContain(P.noDecisionYet(24));
    }
    expect(html.split(UI_COPY.tally.none)).toHaveLength(4);
  });

  it('first use: each defined term\'s definition shows once on the page, beside the first use, which is marked as the term', () => {
    const reviews = { 'in-processing': [{ ...REVIEW, stage: 'in-processing' as const }] };
    const html = render({ reviews, counts: { 'pre-processing': { ...COUNTS, openFindings: 0, openFindingsWithoutMitigation: 0 } } });
    for (const term of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3, TERM_FINDING, TERM_MITIGATION, TERM_ACCEPTED_RISK, TERM_STAGE_REVIEW, TERM_SEAL]) {
      expect(html.split(`data-definition="${term.id}"`), term.id).toHaveLength(2);
      expect(html.split(`data-term="${term.id}"`), term.id).toHaveLength(2);
      // The definition follows its term.
      expect(html.indexOf(`data-term="${term.id}"`)).toBeLessThan(html.indexOf(`data-definition="${term.id}"`));
    }
    const l = lines(html);
    // Pre-processing has no open finding here, so "finding" is first used, and defined, on the next line.
    expect(l['pre-processing']).not.toContain('data-definition="finding"');
    expect(l['in-processing']).toContain('data-definition="finding"');
    // "mitigation" is first used in pre-processing's Still open; "stage review" in pre-processing's empty Reviews sentence.
    expect(stop(l['pre-processing'], 'open')).toContain('data-definition="mitigation"');
    expect(stop(l['pre-processing'], 'reviews')).toMatch(new RegExp(`<p><span data-term="stage-review">${REVIEW_COPY.mounted.noReviews}</span>`));
    // "seal" is first used in the share line ("seal a stage review"): defined there, after the lines.
    expect(html.indexOf('data-definition="seal"')).toBeGreaterThan(html.indexOf('<section class="stage-line" id="post-processing"'));
  });

  it('first use: each status word of a tally carries its (i) once on the page, on the first line whose tally shows it', () => {
    const STATUS_TERMS = [TERM_DONE, TERM_PARTLY, TERM_NOT_YET, TERM_NOT_APPLICABLE, TERM_DOES_NOT_APPLY];
    const tipsIn = (markup: string) => [...markup.matchAll(/<span class="ui-term-tip">.*?data-definition="([a-z-]+)"/g)].map((m) => m[1]);
    // Pre-processing counts done, partly, not yet and not applicable; only in-processing has a question that does not apply.
    const html = render({ counts: { 'in-processing': { ...COUNTS, notApplicableByGate: 1, noDecision: 8 } } });
    for (const term of STATUS_TERMS) {
      expect(html.split(`data-definition="${term.id}"`), term.id).toHaveLength(2);
      expect(html.split(`data-term="${term.id}"`), term.id).toHaveLength(2);
      expect(html, term.id).toContain(`aria-label="${P.whatMeans(term.term).replace(/"/g, '&quot;')}"`);
      // The sentence is the vocabulary's, word for word, inside the tip.
      expect(html, term.id).toContain(`data-definition="${term.id}">${term.definition}</span>`);
    }
    const l = lines(html);
    expect(tipsIn(stop(l['pre-processing'], 'recorded'))).toEqual(['done', 'partly', 'not-yet', 'not-applicable']);
    expect(tipsIn(stop(l['in-processing'], 'recorded'))).toEqual(['does-not-apply']);
    expect(tipsIn(l['post-processing'])).toEqual([]);
    // No (i) on "no decision" or on the answered personal data question, wherever they show.
    expect(html).not.toMatch(/data-definition="no-decision"|data-definition="personal-data-question-scope-question"/);

    // A stage with nothing recorded shows no tally items, so the words are first used, and defined, on a later line.
    const later = lines(render({ counts: { 'pre-processing': ZERO, 'in-processing': { ...ZERO, noDecision: 23, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 } } } }));
    expect(tipsIn(later['pre-processing'])).toEqual([]);
    expect(tipsIn(stop(later['in-processing'], 'recorded'))).toEqual(['done']);
    expect(tipsIn(stop(later['post-processing'], 'recorded'))).toEqual(['partly', 'not-yet', 'not-applicable']);
  });

  /** Markup without lane 1's TermTips (the (i) and its popover's sentence), for reading the words around them. */
  const noTip = (markup: string) => markup.replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/g, '');
  /** The next-step block shown above the stacked lines (owner's ruling on C3), from its opening tag to the jump links. */
  const stacked = (html: string) => {
    const at = html.indexOf('<div class="next-step-block next-step-block--stacked">');
    return at === -1 ? '' : html.slice(at, html.indexOf('<nav class="stage-list__jump"', at));
  };

  it('C11 C3: the one primary action and "Next question" sit in the head stop of the line of the stage last saved in; every last stop says what is left', () => {
    // in-processing-q16 has no decision (routeFor: 14 decided, then the no-decision stops).
    const html = render({}, { stage: 'in-processing', questionId: 'in-processing-q16', label: 'continue' });
    const l = lines(html);
    const head = stop(l['in-processing'], 'head');
    const button = `<a class="ui-button ui-button--primary" href="/orgs/o/projects/p1/stages/in-processing/questions/in-processing-q16">${P.continue}</a>`;
    expect(head).toContain('<div class="next-step-block next-step-block--line">');
    expect(head).toContain(button);
    expect(head).toContain(`<span class="stage-line__next-words"><b class="stage-line__next-label">${P.nextLabel}</b> <span class="stage-line__next-text">Question 16 of in-processing</span></span>`);
    expect(text(head)).toContain(`${P.nextLabel} Question 16 of in-processing ${UI_COPY.position(16, 24)}`);
    // The block comes after the stage's definition, under the name.
    expect(head.indexOf('data-definition="stage-2"')).toBeLessThan(head.indexOf('next-step-block'));
    // Every line's last stop, the target's included, keeps its sentence and the stage's questions, and no button.
    for (const s of STAGES) {
      const last = stop(l[s], 'last');
      expect(last).not.toContain('ui-button');
      expect(last).not.toContain(P.nextLabel);
      expect(text(last)).toContain(P.noDecisionYet(9));
      if (s !== 'in-processing') expect(stop(l[s], 'head')).not.toContain('next-step-block');
    }
    // The same block once above the stacked lines. The markup holds two copies; ProjectPage.css shows one at every width
    // (display: none on the other), and e2e/project-page.spec.ts finds exactly one by role at 1280, 1440 and 375.
    expect(stacked(html)).toContain(button);
    expect(stacked(html)).toContain(P.nextLabel);
    expect(html.match(/ui-button--primary/g)).toHaveLength(2);
    // Above the stacked lines the block sits outside its stage's line, so it names the stage; inside the line it does not.
    expect(text(noTip(stacked(html)))).toContain(`${P.stageNames['in-processing']} · Question`);
    expect(text(head)).not.toContain(`${P.stageNames['in-processing']} · Question`);
  });

  it('N1: below 52rem the stacked block names the stage first, so there the name is marked as the term with its (i) beside it in the same p', () => {
    for (const [target, term] of [
      [{ stage: 'in-processing', questionId: 'in-processing-q16', label: 'continue' }, TERM_STAGE_2],
      [{ stage: 'post-processing', questionId: null, label: 'continue' }, TERM_STAGE_3],
    ] as const) {
      const html = render({}, target);
      const block = stacked(html);
      // In the block's one p: the name as the term, then lane 1's TermTip named by whatMeans, holding the vocabulary's sentence.
      expect(block, term.id).toMatch(new RegExp(`<p class="stage-line__next">(?:(?!</p>).)*<span data-term="${term.id}">${term.term}</span><span class="ui-term-tip">`));
      expect(block, term.id).toContain(`aria-label="${P.whatMeans(term.term).replace(/"/g, '&quot;')}"`);
      expect(block, term.id).toContain(`data-definition="${term.id}">${term.definition}</span>`);
      // What a reader sees, per width. Wide: the stacked block is display:none (ProjectPage.css), so outside it each stage
      // term is marked once, its definition once, under its heading. Narrow: the block comes first and holds the
      // continued stage's term with its sentence in the (i)'s closed popover; the head stop keeps its Definition.
      const outside = html.replace(block, '');
      for (const t of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3]) {
        expect(outside.split(`data-definition="${t.id}"`), `${term.id} wide: ${t.id}`).toHaveLength(2);
        expect(outside.split(`data-term="${t.id}"`), `${term.id} wide: ${t.id}`).toHaveLength(2);
      }
      expect(block.split('data-term=').length - 1, `${term.id} narrow: one term in the block`).toBe(1);
      expect(block.split('data-definition=').length - 1, `${term.id} narrow: one definition in the block, in the tip`).toBe(1);
      expect(block.indexOf('data-definition=')).toBeGreaterThan(block.indexOf('<span class="ui-term-tip">'));
    }
    // On the line, the head stop has no (i): its Definition stays.
    const head = stop(lines(render({}, { stage: 'in-processing', questionId: 'in-processing-q16', label: 'continue' }))['in-processing'], 'head');
    expect(head).not.toContain('ui-term-tip');
  });

  it('C11: "Start recording" for a first save; a null question links to the stage, with the sentence and no label; all decided says so', () => {
    const start = stop(lines(render({}, { stage: 'pre-processing', questionId: 'pre-processing-q16', label: 'start' }))['pre-processing'], 'head');
    expect(start).toContain(`href="/orgs/o/projects/p1/stages/pre-processing/questions/pre-processing-q16">${P.start}</a>`);
    const done = render({ counts: { 'post-processing': ALL_DECIDED } }, { stage: 'post-processing', questionId: null, label: 'continue' });
    const head = stop(lines(done)['post-processing'], 'head');
    expect(head).toContain(`<a class="ui-button ui-button--primary" href="/orgs/o/projects/p1/stages/post-processing">${P.continue}</a>`);
    expect(head).not.toContain(P.nextLabel);
    expect(text(head)).toContain(P.allDecided);
    expect(text(stop(lines(done)['post-processing'], 'last'))).toContain(P.allDecided);
  });

  it('C11 "last-saved": on a fully decided stage the target question is already decided, so the head stop says all are decided, not "Next question"; the button still goes to it', () => {
    const html = render({ counts: { 'post-processing': ALL_DECIDED } }, { stage: 'post-processing', questionId: 'post-processing-q5', label: 'continue' });
    for (const block of [stop(lines(html)['post-processing'], 'head'), stacked(html)]) {
      expect(block).not.toContain(P.nextLabel);
      expect(text(block)).toContain(P.allDecided);
      expect(block).toContain(`<a class="ui-button ui-button--primary" href="/orgs/o/projects/p1/stages/post-processing/questions/post-processing-q5">${P.continue}</a>`);
    }
  });

  it('C11: no target (a Reviewer, a Viewer, an archived project) renders no primary action anywhere', () => {
    for (const html of [render({ role: 'reviewer' }), render({ role: 'viewer' }), render({ archived: true })]) {
      expect(html).not.toContain('ui-button--primary');
      expect(html).not.toContain('next-step-block');
      expect(html).not.toContain(P.continue);
      expect(html).not.toContain(P.start);
    }
  });

  it('All questions in this stage, on every line, links to the stage page and is described by the stage\'s heading', () => {
    const html = render();
    for (const [s, line] of Object.entries(lines(html))) {
      const heading = /<h2 id="([^"]+)">/.exec(line)?.[1];
      const link = new RegExp(`<a ([^>]*)>${S.allQuestions}</a>`).exec(stop(line, 'last'))?.[1] ?? '';
      expect(link).toContain(`href="/orgs/o/projects/p1/stages/${s}"`);
      expect(link).toContain(`aria-describedby="${heading}"`);
    }
    expect(html.split(`>${S.allQuestions}</a>`)).toHaveLength(4);
  });

  it('M11: an unsealed review shows "Before sealing, look at:" with the non-zero items as links, and the empty sentence when none', () => {
    const html = render({ reviews: { 'pre-processing': [REVIEW], 'post-processing': [{ ...REVIEW, id: 'r3', stage: 'post-processing' }] },
      counts: { 'post-processing': ALL_DECIDED } });
    const pre = stop(lines(html)['pre-processing'], 'reviews');
    expect(pre).toContain(`<a class="review-list__name" href="/orgs/o/projects/p1/reviews/r1">${REVIEW.name}</a>`);
    expect(text(pre)).toContain(`${P.reviewNumber(1)} · ${P.notSealedYet}`);
    expect(pre).toContain(P.beforeSealing);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/stages/pre-processing?show=no_decision">${S.noDecisionQuestions(9)}</a>`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/stages/pre-processing?show=done_without_evidence">${P.doneNoEvidence(2)}</a>`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/findings?stage=pre-processing">${P.overdueMitigations(1)}</a>`);
    const post = stop(lines(html)['post-processing'], 'reviews');
    expect(post).toContain(P.nothingLeftOpen);
    expect(post).not.toContain(P.beforeSealing);
  });

  it('9.2: a sealed review says when, and how many decisions changed since, linking to them on the newest review only; its purpose; no Before sealing', () => {
    const sealed: StageReviewView = { ...REVIEW, preparedFor: 'Ethics committee', latestSeal: SEAL, changedSinceLatestSeal: true,
      changed: { sealNumber: 1, changedQuestions: ['Q-PP-01', 'Q-PP-02'], changedFindings: [] } };
    const newer: StageReviewView = { ...REVIEW, id: 'r2', numberInStage: 2, name: 'Team check-in, November', latestSeal: { ...SEAL, id: 's2', reviewId: 'r2' }, changedSinceLatestSeal: true,
      changed: { sealNumber: 1, changedQuestions: ['Q-PP-03'], changedFindings: [] } };
    const pre = stop(lines(render({ reviews: { 'pre-processing': [sealed, newer] } }))['pre-processing'], 'reviews');
    expect(text(pre)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.changedSinceSeal(2)}`);
    expect(text(pre)).toContain(`${REVIEW_COPY.review.facts.preparedFor}: Ethics committee`);
    // Only the newest review's change count is a link: the stage page's filter compares against the newest review.
    expect(pre).not.toContain(`>${P.changedSinceSeal(2)}</a>`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/stages/pre-processing?show=changed_since_seal">${P.changedSinceSeal(1)}</a>`);
    expect(pre).not.toContain(P.beforeSealing);
  });

  it('M-2: the team-typed "Prepared for" note sits inside <bdi> (and only the note), so right-to-left text cannot reorder the line', () => {
    const rtl = '\u05d5\u05e2\u05d3\u05ea \u05d0\u05ea\u05d9\u05e7\u05d4 (ethics)';
    const pre = stop(lines(render({ reviews: { 'pre-processing': [{ ...REVIEW, preparedFor: rtl }] } }))['pre-processing'], 'reviews');
    expect(pre).toContain(`<p class="review-list__meta">${REVIEW_COPY.review.facts.preparedFor}: <bdi>${rtl}</bdi></p>`);
    expect(pre.match(/<bdi>/g)).toHaveLength(1);
  });

  it('9.2: a sealed review says how many decisions and how many findings changed since it was sealed, each on its own; the findings part links to the review', () => {
    const both: StageReviewView = { ...REVIEW, latestSeal: SEAL, changedSinceLatestSeal: true,
      changed: { sealNumber: 1, changedQuestions: ['Q-PP-01', 'Q-PP-02'], changedFindings: ['f1', 'f2', 'f3'] } };
    const pre = stop(lines(render({ reviews: { 'pre-processing': [both] } }))['pre-processing'], 'reviews');
    expect(text(pre)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.changedSinceSeal(2)} · ${P.findingsChangedSinceSeal(3)}`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/stages/pre-processing?show=changed_since_seal">${P.changedSinceSeal(2)}</a>`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/reviews/r1">${P.findingsChangedSinceSeal(3)}</a>`);
    // Findings only: the findings part alone, in the same words; never "Changed since seal 1 (n)."
    const onlyFindings: StageReviewView = { ...both, changed: { sealNumber: 1, changedQuestions: [], changedFindings: ['f1'] } };
    const html = render({ reviews: { 'pre-processing': [onlyFindings] }, counts: { 'pre-processing': { ...COUNTS, openFindings: 0, openFindingsWithoutMitigation: 0 } } });
    const only = stop(lines(html)['pre-processing'], 'reviews');
    expect(text(only)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.findingsChangedSinceSeal(1)}`);
    expect(only).not.toContain(P.changedSinceSeal(1));
    expect(only).not.toContain('Changed since seal');
    // With no open finding before it, this sentence is the page's first use of "finding": its definition is here, once.
    expect(only).toContain('data-definition="finding"');
    expect(html.split('data-definition="finding"')).toHaveLength(2);
    expect([P.findingsChangedSinceSeal(1), P.findingsChangedSinceSeal(3)]).toEqual(['1 finding changed since it was sealed', '3 findings changed since it was sealed']);
  });

  it('9.2: a damaged seal says so first, an erased purpose says when; "Open a stage review" only where the role may and the project is live', () => {
    const damaged: StageReviewView = { ...REVIEW, latestSeal: SEAL, latestSealUnreadable: true, preparedForErased: { erasedOn: '2026-11-12' } };
    const pre = text(stop(lines(render({ reviews: { 'pre-processing': [damaged] } }))['pre-processing'], 'reviews'));
    expect(pre).toContain(`${P.reviewNumber(1)} · ${REVIEW_COPY.state.damaged}`);
    expect(pre).toContain(`${REVIEW_COPY.review.facts.preparedFor}: ${REVIEW_COPY.mounted.noteErased('12 Nov 2026')}`);
    for (const [o, shown] of [[{ role: 'owner' }, true], [{ role: 'assessor' }, true], [{ role: 'viewer' }, false], [{ role: 'owner', archived: true }, false]] as const) {
      const html = render(o);
      expect(html.split(`>${REVIEW_COPY.mounted.openReview}</a>`).length - 1, JSON.stringify(o)).toBe(shown ? 3 : 0);
    }
    expect(render()).toContain('href="/orgs/o/projects/p1/reviews/new?stage=in-processing"');
  });

  it('the header: breadcrumb "Projects › name", the name, the descriptive line when there is one, the any-order line with its glyph hidden; no actions slot', () => {
    const html = render();
    expect(html).toMatch(/<nav class="ui-breadcrumb" aria-label="Breadcrumb"><ol class="ui-breadcrumb__list" role="list"><li class="ui-breadcrumb__item"><a href="\/orgs\/o\/projects">Projects<\/a><\/li><li class="ui-breadcrumb__item"><span class="ui-breadcrumb__current" aria-current="page">Maternal-risk triage<\/span>/);
    expect(html).not.toContain('>Org<');
    expect(html).toContain('<h1 class="ui-page-header__title">Maternal-risk triage</h1>');
    expect(html).toContain('<p class="project-page__facts">Classification, health</p>');
    expect(html).toMatch(new RegExp(`<p class="project-page__order"><span class="project-page__glyph" aria-hidden="true"></span>${P.overview.anyOrder}</p>`));
    expect(html).not.toContain('ui-page-header__actions');
    expect(render({ descriptiveLine: '' })).not.toContain('project-page__facts');
  });

  it('UX-31 S5-1: the archived banner\'s words "All projects page" link to the organisation\'s projects, for every role; the sentence is today\'s', () => {
    // The split is pinned: the parts joined are the sentence the banner said before round 1, word for word.
    expect(P.archivedBannerParts.before + P.archivedBannerParts.link + P.archivedBannerParts.after)
      .toBe('This project is archived. Nothing in it can be changed. An Owner or Admin can unarchive it on the All projects page.');
    expect(P.archivedBanner).toBe(P.archivedBannerParts.before + P.archivedBannerParts.link + P.archivedBannerParts.after);
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) {
      const html = render({ archived: true, role });
      const banner = html.slice(html.indexOf('<div role="status"><div class="ui-banner ui-banner--archived">'));
      expect(banner, role).toMatch(/^<div role="status"><div class="ui-banner ui-banner--archived">/);
      const body = /<div class="ui-banner__body">(.*?)<\/div>/.exec(banner)![1];
      expect(body, role).toBe(`${P.archivedBannerParts.before}<a href="/orgs/o/projects">${P.archivedBannerParts.link}</a>${P.archivedBannerParts.after}`);
      expect(text(body), role).toBe(P.archivedBanner);
    }
  });

  it('share line once, after the three lines and before the "This project" row', () => {
    const html = render();
    expect(html.split(P.overview.shareLine)).toHaveLength(2);
    expect(html.indexOf(P.overview.shareLine)).toBeGreaterThan(html.indexOf('<section class="stage-line" id="post-processing"'));
    expect(html.indexOf(P.overview.shareLine)).toBeLessThan(html.indexOf(`>${P.thisProject}</h2>`));
  });

  it('the "This project" row: Findings, Download records, Edit project details, then Archive last in its own slot; each only where the role allows', () => {
    const owner = render();
    const row = owner.slice(owner.indexOf('<nav class="project-actions"'));
    expect(row).toMatch(new RegExp(`^<nav class="project-actions" aria-labelledby="project-actions-heading"><h2 id="project-actions-heading">${P.thisProject}</h2>`));
    const order = [`>${P.findings}</a>`, `>${P.overview.downloadRecords}</a>`, `>${P.editProjectDetails}</a>`, 'Archive project'].map((w) => row.indexOf(w));
    // Each link of the row has its sketch icon; Edit project details has the pencil (round 1).
    expect(row).toMatch(new RegExp(`href="/orgs/o/projects/p1/edit"><svg class="ui-icon"[^>]*><path d="M21\\.174 6\\.812[^"]*"></path><path d="m15 5 4 4"></path></svg>${P.editProjectDetails}</a>`));
    expect(order.every((i) => i > -1), order.join(',')).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(row).toContain('href="/orgs/o/projects/p1/findings"');
    expect(row).toContain('href="/orgs/o/projects/p1/export"');
    expect(row).toContain('href="/orgs/o/projects/p1/edit"');
    // Archive sits after the list, in a slot of its own pushed to the far end, never beside the primary (which is on a line).
    expect(row).toMatch(/<\/ul><div class="project-actions__archive"><div class="archive-control"/);
    expect(owner).not.toMatch(/Reviews and documents|Findings for this project/);
    // Each action carries its icon, hidden from assistive technology; Edit has none (the kit has no pencil).
    expect(row.match(/<svg class="ui-icon"[^>]*aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(3);
    const viewer = render({ role: 'viewer' });
    const vrow = viewer.slice(viewer.indexOf('<nav class="project-actions"'));
    expect(vrow).toContain(`>${P.findings}</a>`);
    expect(vrow).not.toMatch(/Download records|Edit project details|Archive project/);
  });

  it('archived: the banner, no primary, no Archive trigger (its slot stays), no Edit, no Open a stage review; the lines still read', () => {
    const html = render({ archived: true }, null);
    expect(text(html)).toContain(P.archivedBanner);
    expect(html).not.toMatch(/Archive project|Edit project details|ui-button--primary/);
    expect(html).toContain('<div class="project-actions__archive"></div>');
    expect(html).not.toContain(REVIEW_COPY.mounted.openReview);
    expect(html.match(/<section class="stage-line"/g)).toHaveLength(3);
  });

  it('mount stability: ArchiveProjectControl keeps its place in the tree between the live and the archived page, with or without the primary', () => {
    /** The path from the page to the control: each element's type and key, and each array index, as React reconciles them. */
    const own = new Set<unknown>([ProjectPage, ProjectActions]);
    function pathTo(node: ReactNode, path: string[] = []): string[] | null {
      if (Array.isArray(node)) {
        for (const [i, child] of node.entries()) { const p = pathTo(child, [...path, `[${i}]`]); if (p) return p; }
        return null;
      }
      if (!isValidElement(node)) return null;
      const t = node.type as unknown;
      const name = typeof t === 'string' ? t : t === Fragment ? 'Fragment' : (t as { name?: string }).name ?? 'anonymous';
      const here = [...path, `${name}${node.key === null ? '' : `#${node.key}`}`];
      if (t === ArchiveProjectControl) return here;
      const props = node.props as { children?: ReactNode };
      if (own.has(t)) return pathTo((t as (p: unknown) => ReactNode)(props), here);
      return pathTo(props.children, here);
    }
    const page = (archived: boolean, continueTo: ContinueTarget | null) => {
      const d = data({ archived });
      return <ProjectPage data={d} routes={routesOf(d)} continueTo={continueTo}>{null}</ProjectPage>;
    };
    const live = pathTo(page(false, { stage: 'pre-processing', questionId: 'pre-processing-q16', label: 'continue' }));
    expect(live).not.toBeNull();
    expect(live?.at(-2)).toBe('div');   // the archive slot
    expect(pathTo(page(true, null))).toEqual(live);
    expect(pathTo(page(false, null))).toEqual(live);
  });

  it('copy: the new constants\' exact words, and no copy constant says "stop" or "line" (spec principle 4)', () => {
    expect(P.nextLabel).toBe('Next question');
    expect([P.whatMeans('Done'), P.whatMeans('Not yet')]).toEqual(['What does "Done" mean?', 'What does "Not yet" mean?']);
    expect([P.noDecisionYet(1), P.noDecisionYet(3)]).toEqual(['1 question has no decision yet.', '3 questions have no decision yet.']);
    expect(P.allDecided).toBe('Every question in this stage has a decision.');
    expect([P.beforeSealing, P.nothingLeftOpen]).toEqual(['Before sealing, look at:', 'Nothing is left open in this stage.']);
    expect([P.doneNoEvidence(1), P.doneNoEvidence(2)]).toEqual(['1 decision marked Done with no evidence attached', '2 decisions marked Done with no evidence attached']);
    expect([P.overdueMitigations(1), P.overdueMitigations(2)]).toEqual(['1 overdue mitigation', '2 overdue mitigations']);
    expect([P.changedSinceSeal(1), P.changedSinceSeal(2)]).toEqual(['1 decision changed since it was sealed', '2 decisions changed since it was sealed']);
    expect([P.reviewsHeading, P.thisProject, P.findings, P.editProjectDetails, P.noOverdue]).toEqual(['Reviews', 'This project', 'Findings', 'Edit project details', 'No overdue mitigations']);
    const words: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') words.push(v);
      else if (typeof v === 'function') words.push(String((v as (...a: unknown[]) => unknown)(1, 'X')), String((v as (...a: unknown[]) => unknown)(2, 'X')));
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(PROJECT_COPY);
    expect(words.length).toBeGreaterThan(50);
    for (const w of words) expect(w, w).not.toMatch(/\b(stop|line|Next stop|All stops)\b/i);
  });
});
