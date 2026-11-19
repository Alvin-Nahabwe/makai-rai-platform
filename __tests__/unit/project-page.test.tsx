import { Fragment, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FollowUpItem, SealView, StageCounts, StageReviewView } from '@/types/api';
import { STAGES, type Stage } from '@/types/record';
import type { StatusMarkKind } from '@/components/ui/types';
import { projectActions, projectCanRecord } from '@/lib/projects/can';
import { PROJECT_COPY } from '@/lib/project/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
import { UI_COPY } from '@/lib/ui/copy';
import { tallyOf } from '@/lib/ui/marks';
import { continueTarget } from '@/lib/home/nextStep';
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
    canRecord: projectCanRecord(o.role ?? 'owner', archived),
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

  it('owner 15 Nov 20:50: Still open shows the overdue plates, then one line "{n} other open mitigations" to the Findings page; no plate for one not due or whose person cannot act', () => {
    const later: FollowUpItem = { ...ITEM, mitigationId: 'm3', findingId: 'f3', what: 'Re-run the check', overdue: false, dueDate: '2026-12-20', status: 'planned' };
    const stuck: FollowUpItem = { ...ITEM, mitigationId: 'm4', findingId: 'f4', what: 'Write the guide', overdue: false, dueDate: '2026-12-21', ownerCanAct: false, owner: { userId: 'u9', name: 'Former Person', formerMember: true } };
    const html = render({ followUp: { 'pre-processing': { items: [later], cannotAct: [stuck] } }, counts: { 'pre-processing': { ...COUNTS, overdueMitigations: 0, openMitigations: 2 } } });
    const open = stop(lines(html)['pre-processing'], 'open');
    expect(text(open)).toContain(P.noOverdue);
    expect(open).not.toContain('Not overdue');
    expect(open).not.toContain('ui-plate');
    expect(open).not.toContain('Re-run the check');
    expect(open).toContain(`<a href="/orgs/o/projects/p1/findings?stage=pre-processing">${P.otherOpenMitigations(2)}</a>`);
    // With overdue ones: their plates, then the others as one line (singular for one).
    const both = render({ followUp: { 'pre-processing': { items: [ITEM, later], cannotAct: [] } }, counts: { 'pre-processing': { ...COUNTS, overdueMitigations: 1, openMitigations: 2 } } });
    const open2 = stop(lines(both)['pre-processing'], 'open');
    expect(open2.match(/class="ui-plate /g)).toHaveLength(1);
    expect(text(open2)).toContain(P.otherOpenMitigations(1));
    expect(open2.indexOf('ui-plate ')).toBeLessThan(open2.indexOf(P.otherOpenMitigations(1)));
    // None other open: no line.
    const none = render({ followUp: { 'pre-processing': { items: [ITEM], cannotAct: [] } } });
    expect(stop(lines(none)['pre-processing'], 'open')).not.toMatch(/other open mitigation/);
    // An open mitigation that is not overdue keeps "Nothing is open" away.
    const only = render({ counts: { 'pre-processing': { ...ZERO, noDecision: 0, openMitigations: 1 } }, followUp: { 'pre-processing': { items: [later], cannotAct: [] } } });
    expect(stop(lines(only)['pre-processing'], 'open')).not.toContain(S.nothingOpen);
  });

  it('owner 15 Nov 20:50: Recorded so far is the tally in words with the kit\'s mark beside each count, no row of marks per question; the no-decision count stays in Still open', () => {
    const l = lines(render({ counts: { 'in-processing': { ...COUNTS, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 0, noDecision: 22, notApplicableByGate: 1 } } }));
    const pre = stop(l['pre-processing'], 'recorded');
    // The row of marks per question is gone: no stops, no per-question words, no list named "Questions in <stage>".
    expect(pre).not.toContain('ui-route-row__stops');
    expect(pre).not.toContain('ui-route-row__stop');
    expect(pre).not.toContain(P.routeLabel('Pre-processing'));
    expect(pre).not.toContain('Question 1 of pre-processing');
    expect(pre).not.toContain('<a ');
    // The tally: one item per kind with a count, each its kit mark (hidden from assistive technology) then the count in words.
    const items = [...pre.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => m[1]);
    for (const it of items) expect(it).toMatch(/^<svg class="ui-mark__shape"[^>]*aria-hidden="true"/);
    const tally = (rec: string) => [...rec.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => text(m[1].replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, ''))).join(', ');
    expect(tally(pre)).toBe('7 done (2 with no evidence attached), 3 partly, 2 not yet, 2 not applicable, 1 answered');
    expect(tally(stop(l['in-processing'], 'recorded'))).toBe('1 done, 1 does not apply');
    expect(text(pre)).toContain('1 accepted risk, 1 document issued');
    expect(render()).not.toMatch(/\b(total|overall|in all)\b|%|\b21 done\b/i);
  });

  it('barely started: every line reads "No decisions recorded yet", with no row of marks', () => {
    const html = render({ counts: { 'pre-processing': ZERO, 'in-processing': ZERO, 'post-processing': ZERO } });
    for (const line of Object.values(lines(html))) {
      const rec = stop(line, 'recorded');
      expect(rec).not.toContain('ui-route-row__stop');
      expect(rec).toContain(`<p class="ui-route-row__tally">${UI_COPY.tally.none}</p>`);
      expect(rec).not.toMatch(/accepted risk|issued/);
      expect(text(stop(line, 'last'))).toContain(P.noDecisionYet(24));
    }
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

  it('owner 15 Nov 21:32 (A): every first-use definition below the stage heads is a (i) toggletip with the exact sentence; only the stage meanings stay as text', () => {
    const reviews = { 'in-processing': [{ ...REVIEW, stage: 'in-processing' as const }] };
    const html = render({ reviews, counts: { 'pre-processing': { ...COUNTS, openFindings: 0, openFindingsWithoutMitigation: 0 } } });
    for (const term of [TERM_FINDING, TERM_MITIGATION, TERM_ACCEPTED_RISK, TERM_STAGE_REVIEW, TERM_SEAL]) {
      // No bare Definition (it has no id); one tip, named by whatMeans, whose popover holds the vocabulary's sentence.
      expect(html, term.id).not.toMatch(new RegExp(`class="ui-definition" data-definition="${term.id}"`));
      expect(html, term.id).toContain(`data-definition="${term.id}">${term.definition?.replace(/'/g, '&#x27;')}</span>`);
      expect(html, term.id).toContain(`aria-label="${P.whatMeans(term.term).replace(/"/g, '&quot;')}"`);
      // The tip follows its term in the same block (a toggletip beside the exact definition counts, owner 11:00).
      expect(html.indexOf('<span class="ui-term-tip">', html.indexOf(`data-term="${term.id}"`)), term.id).toBeGreaterThan(-1);
    }
    for (const term of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3]) expect(html).toMatch(new RegExp(`<p class="ui-definition" data-definition="${term.id}">`));
    // The share line's two tips sit in its own p.
    const share = html.slice(html.indexOf('<p class="project-page__share">'), html.indexOf('</p>', html.indexOf('<p class="project-page__share">')));
    expect(share).toContain('ui-term-tip');
  });

  it('first use: each status word of a tally carries its (i) once on the page, on the first line whose tally shows it', () => {
    const STATUS_TERMS = [TERM_DONE, TERM_PARTLY, TERM_NOT_YET, TERM_NOT_APPLICABLE, TERM_DOES_NOT_APPLY];
    // Only the status words' tips: the page's other first-use tips (finding, mitigation, ...) sit beside them in the same lines.
    const tipsIn = (markup: string) => [...markup.matchAll(/<span class="ui-term-tip">.*?data-definition="([a-z-]+)"/g)].map((m) => m[1])
      .filter((id) => STATUS_TERMS.some((t) => t.id === id));
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

  it('G4: each stage shows "N of M", a progress element in data-stage-bar named "N of M questions recorded", and Next: Question N · Continue as a link', () => {
    // COUNTS: 24 questions, 9 with no decision, none removed by the gate: 15 of 24. The first open question of routeFor is the 15th (14 decided before it).
    const l = lines(render());
    for (const s of STAGES) {
      const head = stop(l[s], 'head');
      expect(head, s).toContain('<div class="stage-line__progress" data-stage-bar="">');
      expect(text(head), s).toContain('15 of 24');
      expect(head, s).toMatch(/<progress [^>]*max="24"[^>]*value="15"|<progress [^>]*value="15"[^>]*max="24"/);
      expect(head, s).toContain('aria-valuetext="15 of 24 questions recorded"');
      // M4: one announcement. The visible words name the bar (aria-labelledby), so the sentence is not repeated in an aria-label.
      expect(head, s).not.toContain('aria-label="15 of 24');
      const words = /<p class="stage-line__progress-words" id="([^"]+)">15 of 24 questions recorded<\/p>/.exec(head);
      expect(words, `${s}: the visible words carry an id`).not.toBeNull();
      expect(head, s).toContain(`aria-labelledby="${words?.[1]}"`);
      expect((head.match(/data-stage-bar/g) ?? []).length, `${s}: one bar`).toBe(1);
      expect(head, s).toMatch(new RegExp(`<a (?=[^>]*class="stage-line__next-link")(?=[^>]*href="/orgs/o/projects/p1/stages/${s}/questions/${s}-q15")[^>]*>Next: Question 15 · Continue</a>`));
      // The bar is in the head stop alone: no other stop, no percentage anywhere on the line.
      expect(l[s].split('<progress').length - 1, s).toBe(1);
      expect(l[s], s).not.toContain('%');
    }
  });

  it('G4 I1 (controller ruling): in the stage holding Home\'s continue target, the link names that question, numbered by its place in the stage; every other stage keeps its first open question', () => {
    // The last save is question 19 of in-processing; q15..q24 are open, so Home's rule (continueTarget, the one Home reads) names q20, not the first open q15.
    const d = data();
    const routes = routesOf(d);
    const stages = Object.fromEntries(STAGES.map((s) => [s, {
      questions: routes[s].stops.map((st) => ({ id: st.id, text: st.title })), open: new Set(routes[s].noDecision.map((q) => q.id)),
    }])) as unknown as Parameters<typeof continueTarget>[0];
    const home = continueTarget(stages, { stage: 'in-processing', questionId: 'in-processing-q19' });
    expect(home).toEqual({ stage: 'in-processing', questionId: 'in-processing-q20', label: 'continue' });
    const l = lines(render({}, home));
    const ip = stop(l['in-processing'], 'head');
    expect(ip).toMatch(/<a (?=[^>]*class="stage-line__next-link")(?=[^>]*href="\/orgs\/o\/projects\/p1\/stages\/in-processing\/questions\/in-processing-q20")[^>]*>Next: Question 20 · Continue<\/a>/);
    for (const s of ['pre-processing', 'post-processing'] as const) {
      expect(stop(l[s], 'head'), s).toContain(`${s}-q15"`);
      expect(stop(l[s], 'head'), s).toContain('Next: Question 15 · Continue');
    }
    // A target that is not an open question of its stage, or with no question, leaves the first open question.
    for (const t of [{ stage: 'in-processing' as const, questionId: null, label: 'continue' as const }, { stage: 'in-processing' as const, questionId: 'in-processing-q3', label: 'continue' as const }]) {
      expect(stop(lines(render({}, t))['in-processing'], 'head'), JSON.stringify(t)).toContain('Next: Question 15 · Continue');
    }
  });

  it('G4 (Task 11 ruling): N and M come from stageProgress, not byStatus: an answered gate counts as recorded, and a gate-removed question leaves M', () => {
    // 24 questions, 2 removed by the gate, 5 with no decision: M = 22, N = 17, whatever byStatus holds.
    const c: StageCounts = { ...COUNTS, noDecision: 5, notApplicableByGate: 2, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 } };
    const head = stop(lines(render({ counts: { 'pre-processing': c } }))['pre-processing'], 'head');
    expect(text(head)).toContain('17 of 22');
    expect(head).toContain('aria-valuetext="17 of 22 questions recorded"');
    // A finished stage reads M of M and has no next link.
    const done = stop(lines(render({ counts: { 'post-processing': ALL_DECIDED } }))['post-processing'], 'head');
    expect(text(done)).toContain('24 of 24');
    expect(done).not.toContain('stage-line__next-link');
  });

  it('G4 O1: a role that cannot record (Viewer, Reviewer, or any role on an archived project) sees the same link as "Next: Question N · View"; no role sees a link it cannot use', () => {
    for (const o of [{ role: 'viewer' as const }, { role: 'reviewer' as const }, { archived: true }]) {
      const html = render(o);
      expect(html, JSON.stringify(o)).toContain('Next: Question 15 · View</a>');
      expect(html, JSON.stringify(o)).not.toContain('· Continue');
      expect(html, JSON.stringify(o)).toContain('href="/orgs/o/projects/p1/stages/pre-processing/questions/pre-processing-q15"');
    }
    for (const role of ['owner', 'admin', 'assessor'] as const) {
      const html = render({ role });
      expect(html, role).toContain('Next: Question 15 · Continue</a>');
      expect(html, role).not.toContain('· View');
    }
  });

  it('G5: the page has exactly one primary button, Open the working report, and the G5 line is above the stages', () => {
    for (const o of [{}, { role: 'viewer' as const }, { role: 'reviewer' as const }, { archived: true }]) {
      const html = render(o);
      expect(html.match(/ui-button--primary/g), JSON.stringify(o)).toHaveLength(1);
      expect(html, JSON.stringify(o)).toContain(`<a class="ui-button ui-button--primary" href="/orgs/o/projects/p1/report">${P.overview.openReport}</a>`);
      const line = html.indexOf(P.overview.whatYouGet);
      expect(line, JSON.stringify(o)).toBeGreaterThan(-1);
      expect(line).toBeLessThan(html.indexOf('<section class="stage-line"'));
      // The primary and the line are in the page body, not the header, which has no actions wrapper (prj-components).
      expect(html.indexOf(P.overview.openReport)).toBeGreaterThan(html.indexOf('</header>') === -1 ? html.indexOf('ui-page-header') : html.indexOf('</header>'));
      expect(html).not.toContain('ui-page-header__actions');
      // Neither start nor continue is a button any more.
      expect(html).not.toContain(P.continue);
      expect(html).not.toContain(P.start);
    }
    expect(P.overview.whatYouGet).toBe('Answer the questions that apply. At any point you can open a working report: next steps by risk area, plus draft data card, model card and mitigation plan. About 5 minutes a question.');
    expect(P.overview.openReport).toBe('Open the working report');
  });

  it('G7 display: a stage with applies false reads "Doesn\'t apply to this project yet" and still links to the stage', () => {
    const d = { ...data(), applies: { 'pre-processing': true, 'in-processing': false, 'post-processing': true } };
    const html = renderToStaticMarkup(<ProjectPage data={d} routes={routesOf(d)} continueTo={null} />);
    const l = lines(html);
    expect(l['in-processing']).toContain('Doesn&#x27;t apply to this project yet');
    expect(l['in-processing']).toContain('href="/orgs/o/projects/p1/stages/in-processing"');
    expect(text(l['pre-processing'])).not.toContain('apply to this project yet');
    expect(text(l['post-processing'])).not.toContain('apply to this project yet');
    // No answers recorded for it: the empty bar is not shown for a stage that does not apply.
    const gone = renderToStaticMarkup(<ProjectPage data={{ ...d, counts: { ...d.counts, 'in-processing': ZERO } }} routes={routesOf({ ...d, counts: { ...d.counts, 'in-processing': ZERO } })} continueTo={null} />);
    expect(lines(gone)['in-processing']).not.toContain('<progress');
    // Answers already given are never hidden: with some recorded, the bar shows too.
    expect(l['in-processing']).toContain('<progress');
    // Absent applies means every stage applies.
    expect(text(render())).not.toContain('apply to this project yet');
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
    // Owner 15 Nov 21:32 (C): one line per review, "Review n · sealed <date> · k changed since", the count linking to the review.
    expect(text(pre)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.changedSince(2)}`);
    expect(text(pre)).toContain(`${P.reviewNumber(2)} · ${P.sealed} 11 Nov 2026 · ${P.changedSince(1)}`);
    expect(text(pre)).toContain(`${REVIEW_COPY.review.facts.preparedFor}: Ethics committee`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/reviews/r1">${P.changedSince(2)}</a>`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/reviews/r2">${P.changedSince(1)}</a>`);
    expect(pre).not.toContain('it was sealed');
    expect(pre).not.toContain(P.beforeSealing);
  });

  it('M-2: the team-typed "Prepared for" note sits inside <bdi> (and only the note), so right-to-left text cannot reorder the line', () => {
    const rtl = '\u05d5\u05e2\u05d3\u05ea \u05d0\u05ea\u05d9\u05e7\u05d4 (ethics)';
    const pre = stop(lines(render({ reviews: { 'pre-processing': [{ ...REVIEW, preparedFor: rtl }] } }))['pre-processing'], 'reviews');
    expect(pre).toContain(`<p class="review-list__meta">${REVIEW_COPY.review.facts.preparedFor}: <bdi>${rtl}</bdi></p>`);
    expect(pre.match(/<bdi>/g)).toHaveLength(1);
  });

  it('owner 15 Nov 21:32 (C): decisions and findings changed since the seal are one count, "k changed since"; none changed adds nothing', () => {
    const both: StageReviewView = { ...REVIEW, latestSeal: SEAL, changedSinceLatestSeal: true,
      changed: { sealNumber: 1, changedQuestions: ['Q-PP-01', 'Q-PP-02'], changedFindings: ['f1', 'f2', 'f3'] } };
    const pre = stop(lines(render({ reviews: { 'pre-processing': [both] } }))['pre-processing'], 'reviews');
    expect(text(pre)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.changedSince(5)}`);
    expect(pre).toContain(`<a href="/orgs/o/projects/p1/reviews/r1">${P.changedSince(5)}</a>`);
    // The review's meta is one p: no second sentence about findings, so the review adds no first use of "finding".
    expect(pre.match(/class="review-list__meta"/g)).toHaveLength(1);
    const html = render({ reviews: { 'pre-processing': [{ ...both, changed: { sealNumber: 1, changedQuestions: [], changedFindings: ['f1'] } }] }, counts: { 'pre-processing': { ...COUNTS, openFindings: 0, openFindingsWithoutMitigation: 0 } } });
    expect(text(stop(lines(html)['pre-processing'], 'reviews'))).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026 · ${P.changedSince(1)}`);
    // With no open finding in pre-processing, the first use of "finding" is in-processing's Still open, as for any page.
    expect(lines(html)['pre-processing']).not.toContain('data-definition="finding"');
    expect(html.split('data-definition="finding"')).toHaveLength(2);
    const none = stop(lines(render({ reviews: { 'pre-processing': [{ ...both, changed: { sealNumber: 1, changedQuestions: [], changedFindings: [] } }] } }))['pre-processing'], 'reviews');
    expect(text(none)).toContain(`${P.reviewNumber(1)} · ${P.sealed} 11 Nov 2026`);
    expect(none).not.toContain('changed since');
  });

  it('9.2: a damaged seal says so first, an erased purpose says when; "Open a stage review" only where the role may and the project is live', () => {
    const damaged: StageReviewView = { ...REVIEW, latestSeal: SEAL, latestSealUnreadable: true, preparedForErased: { erasedOn: '2026-11-12' } };
    const pre = text(stop(lines(render({ reviews: { 'pre-processing': [damaged] } }))['pre-processing'], 'reviews'));
    // One line, in the first sentence of the damaged-seal words (the review page keeps the whole of it).
    expect(pre).toContain(`${P.reviewNumber(1)} · ${REVIEW_COPY.state.damagedShort}`);
    expect(pre).not.toContain('Contact MAK-AI');
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

  it('UX-31 S5-1: the archived banner\'s words "Projects page" link to the organisation\'s projects, for every role; the sentence is the owner\'s ruling of 15 Nov 18:28', () => {
    // The split is pinned: the parts joined are the sentence as the owner ruled it, 15 Nov 2026 18:28 ("Projects page", not "All projects page").
    expect(P.archivedBannerParts.before + P.archivedBannerParts.link + P.archivedBannerParts.after)
      .toBe('This project is archived. Nothing in it can be changed. An Owner or Admin can unarchive it on the Projects page.');
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

  it('archived: the banner, no Archive trigger (its slot stays), no Edit, no Open a stage review; the lines still read', () => {
    const html = render({ archived: true }, null);
    expect(text(html)).toContain(P.archivedBanner);
    expect(html).not.toMatch(/Archive project|Edit project details/);
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
    expect([P.changedSince(1), P.changedSince(5)]).toEqual(['1 changed since', '5 changed since']);
    expect([P.reviewsHeading, P.thisProject, P.findings, P.editProjectDetails, P.noOverdue]).toEqual(['Reviews', 'This project', 'Findings', 'Edit project details', 'No overdue mitigations']);
    expect([P.otherOpenMitigations(1), P.otherOpenMitigations(4)]).toEqual(['1 other open mitigation', '4 other open mitigations']);
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
