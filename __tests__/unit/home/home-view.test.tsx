import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { FindingView, FollowUpItem, StageReviewView, UserRef } from '@/types/api';
import type { ChangeGroup, HomeBase, HomeData, NextStep, StageOpen } from '@/lib/home/types';
import type { StatusMarkKind } from '@/components/ui/types';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { positionWords, tallyWords } from '@/lib/ui/copy';
import { roleWithArticle, welcomeLine } from '@/lib/org/copy';
import {
  TERM_CHANGED_SINCE_SEAL_N, TERM_FINDING, TERM_MITIGATION, TERM_PRODUCT, TERM_REVIEWER, TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3,
} from '@/lib/vocabulary/terms';
import { openDraftStore, draftKey, DRAFT_PREFIX } from '@/lib/client/drafts';
import { decode, textOf } from '../../helpers/markup';
import { HOSTILE_STRINGS } from '../../helpers/hostile';

/**
 * Plan 1B Task 10: Home, every variant, as static markup (the page's components are server components; LocalTime writes
 * the UTC day on the server render). One case per variant and per state the brief lists, the principle-7 checks, the
 * first-use definitions, and the unsaved-changes line's rule (its sentence is a pure function of the draft store).
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'org-a' }) }));

const { HomeView } = await import('@/components/home/HomeView');
const { WelcomeLine } = await import('@/components/home/WelcomeLine');
const { unsavedSentence } = await import('@/components/home/HomeUnsavedLine');

const html = (el: ReactElement) => renderToStaticMarkup(el);
const home = (data: HomeData) => html(<HomeView data={data} />);
/** The links of the markup, by their text: [text, href]. */
const links = (h: string): Array<[string, string]> =>
  [...h.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [textOf(m[2]).replace(/\s+/g, ' ').trim(), decode(m[1])]);
const linksNamed = (h: string, names: string[]) => links(h).filter(([t]) => names.includes(t));
const headings = (h: string) => [...h.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `h${m[1]} ${textOf(m[2]).trim()}`);

const ORG = 'org-a';
const P1 = 'p1';
const user = (userId: string, name: string, formerMember = false): UserRef => ({ userId, name, formerMember });
const AMINA = user('u-amina', 'Amina Namusoke');
const JOSEPH = user('u-joseph', 'Joseph Mugisha');

const base = (over: Partial<HomeBase> = {}): HomeBase => ({
  orgSlug: ORG, orgId: 'o1', orgName: 'Makerere AI Lab', role: 'assessor', userId: AMINA.userId, userName: AMINA.name, welcome: false,
  archivedCount: 0, projects: [{ id: P1, name: 'Antenatal Risk Triage Model' }], ...over,
});

const NEXT: NextStep = {
  projectId: P1, projectName: 'Antenatal Risk Triage Model', stage: 'pre-processing', questionId: 'Q-PP-05',
  questionText: 'Has a human rights impact assessment been done?', position: { n: 5, of: 22 }, rule: 'next-open',
  lastSavedOn: '2026-11-03T09:15:00.000Z',
};

const stops = (stage: string, kinds: StatusMarkKind[], current?: number): StageOpen['stops'] =>
  kinds.map((kind, i) => ({ id: `Q-${stage}-${i + 1}`, kind, title: `Question ${i + 1}`, href: `/q/${stage}/${i + 1}`, ...(current === undefined ? {} : { current: i === current }) }));

const STAGES_OPEN: StageOpen[] = [
  {
    stage: 'pre-processing', noDecision: 3, openFindings: 11, overdueMitigations: 1,
    stops: stops('PP', ['done', 'partly', 'not_yet', 'no_decision', 'no_decision', 'no_decision'], 4),
    tally: { done: 1, partly: 1, not_yet: 1, no_decision: 3 },
    nextOpen: { questionId: 'Q-PP-04', questionText: 'Who is the system for?', position: { n: 4, of: 22 } },
  },
  {
    stage: 'in-processing', noDecision: 18, openFindings: 1, overdueMitigations: 0,
    stops: stops('IP', ['done', 'no_decision'], -1), tally: { done: 3, partly: 1, no_decision: 18 },
    nextOpen: { questionId: 'Q-IP-02', questionText: 'Which model did you choose?', position: { n: 2, of: 22 } },
  },
  {
    stage: 'post-processing', noDecision: 0, openFindings: 0, overdueMitigations: 0,
    stops: stops('PO', ['done'], -1), tally: { done: 23 }, nextOpen: null,
  },
];

const item = (over: Partial<FollowUpItem> = {}): FollowUpItem => ({
  mitigationId: 'm1', versionId: 'v1', findingId: 'f1', projectId: P1, stage: 'pre-processing',
  what: 'Write a monthly label audit', owner: AMINA, dueDate: '2026-12-18', status: 'planned', overdue: false, ownerCanAct: true, ...over,
});
const finding = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f9', projectId: P1, stage: 'in-processing', source: 'team', questionId: null, decisionVersionId: null, riskArea: null,
  title: 'Labels are not checked', description: null, raisedBy: AMINA, raisedAt: '2026-11-04T08:00:00.000Z', state: 'open',
  openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0, ...over,
});
const group = (over: Partial<ChangeGroup> = {}): ChangeGroup => ({
  day: '2026-11-08', latestAt: '2026-11-08T10:00:00.000Z', who: JOSEPH, kind: 'decisions', count: 2, projectId: P1,
  projectName: 'Antenatal Risk Triage Model', stage: 'in-processing', ...over,
});

const RECORDER: HomeData = {
  variant: 'recorder', base: base(), next: NEXT, assigned: [item()],
  since: { from: '2026-11-03T09:15:00.000Z', groups: [group(), group({ kind: 'seal', count: 1, stage: 'pre-processing', day: '2026-11-11', latestAt: '2026-11-11T07:00:00.000Z' })], more: false },
  focus: { projectId: P1, projectName: 'Antenatal Risk Triage Model', stages: STAGES_OPEN }, lead: null, otherProjects: 0,
};
const RECORDER_WITH_LEAD: HomeData = {
  ...RECORDER, base: base({ role: 'owner' }),
  lead: { overdue: [item({ mitigationId: 'm7', owner: JOSEPH, overdue: true, dueDate: '2026-09-30', what: 'Retrain the labellers' })], withoutMitigation: [finding()], multiProject: false },
};
const review = (over: Partial<StageReviewView> = {}): StageReviewView => ({
  id: 'r1', projectId: P1, stage: 'pre-processing', numberInStage: 1, name: 'Pre-processing review 1', preparedFor: null, openedBy: JOSEPH,
  openedAt: '2026-11-01T08:00:00.000Z', latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased: null, latestSealUnreadable: false,
  ...over,
});
const REVIEWER: HomeData = {
  variant: 'reviewer', base: base({ role: 'reviewer' }), assigned: [], unsealed: [review()],
  changedSinceSeal: [review({
    id: 'r2', stage: 'in-processing', name: 'In-processing review 1', changedSinceLatestSeal: true,
    latestSeal: { id: 's1', reviewId: 'r2', sealNumber: 2, fingerprint: 'x', sealedBy: JOSEPH, sealedByRole: 'reviewer', sealedAt: '2026-11-02T08:00:00.000Z', contentSemver: '5.1.0', bytesMatch: true } as never,
  })],
  raisedByMe: [finding()],
};
const VIEWER: HomeData = {
  variant: 'viewer', base: base({ role: 'viewer' }), assigned: [], recent: { groups: [group()], more: true },
  open: [{ projectId: P1, projectName: 'Antenatal Risk Triage Model', stages: STAGES_OPEN.map((s) => ({ ...s, stops: s.stops.map(({ current: _c, ...rest }) => rest) })) }],
};
const firstTime = (role: HomeBase['role'], canCreate: boolean, over: Partial<HomeBase> = {}): HomeData => ({ variant: 'first-time', base: base({ role, projects: [], ...over }), canCreate });

describe('recorder (spec 9.1, sketch home.png)', () => {
  it('opens "Welcome back, <name>." as the one h1, with the sketch\'s lead when the next step, the changes and the stages are all there', () => {
    const h = home(RECORDER);
    expect(headings(h).filter((x) => x.startsWith('h1'))).toEqual([`h1 ${HOME_COPY.welcomeBack(AMINA.name)}`]);
    expect(textOf(h)).toContain(HOME_COPY.recorderLead);
    expect(textOf(home({ ...RECORDER, since: null }))).not.toContain(HOME_COPY.recorderLead);
    expect(textOf(home({ ...RECORDER, next: null }))).not.toContain(HOME_COPY.recorderLead);
  });

  it('next step names the question in words with its reason and two controls of equal height', () => {
    const h = home(RECORDER);
    expect(textOf(h)).toContain(HOME_COPY.reasonNextOpen('Pre-processing', '3 Nov 2026'));
    expect(linksNamed(h, [HOME_COPY.continueRecording, HOME_COPY.chooseAnother])).toEqual([
      [HOME_COPY.continueRecording, `/orgs/${ORG}/projects/${P1}/stages/pre-processing/questions/Q-PP-05`],
      [HOME_COPY.chooseAnother, `/orgs/${ORG}/projects/${P1}/stages/pre-processing`],
    ]);
    expect(textOf(h)).toContain(positionWords(5, 22));
    const t = textOf(h);
    expect(t.indexOf('Q-PP-05')).toBeGreaterThan(t.indexOf(NEXT.questionText));   // the code is small and after the words
  });

  it('gap 2, as ruled again on 15 November (role-matrix O-13): the Home of a person who records has one "New project" and no "Create a project"', () => {
    for (const data of [RECORDER, RECORDER_WITH_LEAD]) {
      expect(textOf(home(data))).not.toMatch(/Create a project/);
      expect(linksNamed(home(data), [PROJECT_COPY.allProjects.newProject])).toHaveLength(1);
    }
  });

  it('gap 3: "Assigned to you" holds the person\'s mitigations with their status and due date, linked to the finding', () => {
    const h = home(RECORDER);
    expect(headings(h)).toContain(`h2 ${HOME_COPY.assignedHeading}`);
    expect(linksNamed(h, ['Write a monthly label audit'])).toEqual([['Write a monthly label audit', `/orgs/${ORG}/projects/${P1}/findings/f1`]]);
    expect(textOf(h)).toContain('Planned');
    expect(textOf(h)).toContain(PROJECT_COPY.followUp.due('18 Dec 2026'));
    expect(textOf(home({ ...RECORDER, assigned: [] }))).toContain(HOME_COPY.assignedNone);
  });

  it('gap 4: "Since your last saved change (date)" lists the dated changes of others, in words', () => {
    const h = home(RECORDER);
    expect(textOf(h)).toContain(HOME_COPY.sinceHeading('3 Nov 2026'));
    expect(textOf(h)).toContain(HOME_COPY.sinceDecisions(JOSEPH.name, 2, 'In-processing'));
    expect(textOf(h)).toContain(HOME_COPY.sinceSeals(JOSEPH.name, 1, 'Pre-processing'));
    expect(h).toMatch(/<time[^>]*dateTime="2026-11-08"[^>]*>8 Nov 2026<\/time>/);
    expect(textOf(home({ ...RECORDER, since: { from: '2026-11-03T09:15:00.000Z', groups: [], more: false } }))).toContain(HOME_COPY.sinceNone);
    expect(textOf(home({ ...RECORDER, since: { ...RECORDER.since!, more: true } }))).toContain(HOME_COPY.sinceMore);
    // A person with no saved entry has no "since": the section is absent, not empty.
    expect(textOf(home({ ...RECORDER, since: null }))).not.toContain('Since your last saved change');
  });

  it('counts agree in number in every change sentence; a former member is marked', () => {
    const h = home({ ...RECORDER, since: { ...RECORDER.since!, groups: [
      group({ count: 1 }), group({ kind: 'finding', count: 3, stage: 'post-processing' }), group({ who: user('u-x', 'Peter Ssemwogerere', true), kind: 'seal', count: 2 }),
    ] } });
    expect(textOf(h)).toContain(HOME_COPY.sinceDecisions(JOSEPH.name, 1, 'In-processing'));
    expect(textOf(h)).toContain('Joseph Mugisha saved 1 decision in In-processing.');
    expect(textOf(h)).toContain('Joseph Mugisha raised 3 findings in Post-processing.');
    expect(textOf(h)).toContain('Peter Ssemwogerere (former member) sealed 2 reviews of In-processing.');
  });

  it('gap 5: the project\'s three stage plates, open items first, then the tally in words with a mark per kind, then "Next:"', () => {
    const h = home(RECORDER);
    expect(headings(h)).toContain('h2 Antenatal Risk Triage Model');
    expect(textOf(h)).toContain(HOME_COPY.stagesLead);
    const plate = h.slice(h.indexOf('data-stage="pre-processing"'), h.indexOf('data-stage="in-processing"'));
    const t = textOf(plate);
    expect(t.indexOf('11 open findings')).toBeLessThan(t.indexOf(tallyWords({ done: 1 })));
    expect(t.indexOf('Overdue')).toBeLessThan(t.indexOf(tallyWords({ done: 1 })));
    expect(t.indexOf(tallyWords({ no_decision: 3 }))).toBeLessThan(t.indexOf(HOME_COPY.next));
    expect(t).toContain(`${HOME_COPY.next} ${HOME_COPY.nextHere(positionWords(5, 22))}`);
    expect([...plate.matchAll(/class="home-tally__item"[^>]*data-tally-kind="([a-z_]+)"/g)].map((m) => m[1])).toEqual(['done', 'partly', 'not_yet', 'no_decision']);
    expect(linksNamed(h, ['11 open findings'])).toEqual([['11 open findings', `/orgs/${ORG}/projects/${P1}/findings?stage=pre-processing`]]);
    const second = textOf(h.slice(h.indexOf('data-stage="in-processing"'), h.indexOf('data-stage="post-processing"')));
    expect(second).toContain(`${HOME_COPY.next} ${HOME_COPY.nextFirstOf(18)}`);
    expect(linksNamed(h, [HOME_COPY.nextFirstOf(18)])).toEqual([[HOME_COPY.nextFirstOf(18), `/orgs/${ORG}/projects/${P1}/stages/in-processing/questions/Q-IP-02`]]);
  });

  it('no card of zero counts: a stage with nothing open shows no "0 open findings", no overdue line and no "Next:"', () => {
    const h = home(RECORDER);
    const third = h.slice(h.indexOf('data-stage="post-processing"'));
    expect(textOf(third)).not.toMatch(/\b0 open|Overdue|Next:/);
    expect(textOf(h)).not.toMatch(/(^|\D)0 (open|overdue|mitigation|question|decision)/);
  });

  it('only the word "Overdue" and an overdue date are red: the count after the word is ink, and the overdue class never wraps a name', () => {
    const h = home(RECORDER_WITH_LEAD);
    for (const m of h.matchAll(/<span class="home-overdue"[^>]*>([\s\S]*?)<\/span>/g)) expect(textOf(m[1]).trim()).toMatch(new RegExp(`^(${PROJECT_COPY.followUp.overdue}|\\d{1,2} [A-Z][a-z]{2} \\d{4})$`));
    expect(textOf(h)).toContain(`${PROJECT_COPY.followUp.overdue}${HOME_COPY.overdueCount(1)}`);
  });

  it('principle 7: no %, no total across stages, no progress element, no colour class on a name', () => {
    const h = home(RECORDER_WITH_LEAD);
    expect(h).not.toMatch(/%|<progress|role="progressbar"|in all|total/i);
    expect(h).not.toMatch(/class="[^"]*overdue[^"]*"[^>]*>\s*[A-Z][a-z]+ [A-Z]/);
  });

  it('owner/admin: overdue and no-mitigation lists sit above the stages as compact rows and show Assigned to', () => {
    const h = home(RECORDER_WITH_LEAD);
    const t = textOf(h);
    expect(headings(h)).toEqual(expect.arrayContaining([`h2 ${HOME_COPY.leadOverdueHeading}`, `h2 ${HOME_COPY.leadNoMitigationHeading}`]));
    expect(t.indexOf(HOME_COPY.leadOverdueHeading)).toBeLessThan(t.indexOf(HOME_COPY.stagesLead));
    expect(t.indexOf(HOME_COPY.leadNoMitigationHeading)).toBeLessThan(t.indexOf(HOME_COPY.stagesLead));
    expect(t).toContain(HOME_COPY.assignedToName(JOSEPH.name));
    expect(t).toContain(`${PROJECT_COPY.followUp.overdue}${PROJECT_COPY.followUp.wasDue('30 Sep 2026')}`);
    // Compact rows, not plates (design review #7); the reader's own overdue item says "Assigned to you".
    const lead = h.slice(h.indexOf(HOME_COPY.leadOverdueHeading), h.indexOf(HOME_COPY.stagesLead));
    expect(lead).not.toContain('class="home-plate"');
    expect((lead.match(/class="home-row"/g) ?? []).length).toBe(2);
    const own = home({ ...RECORDER_WITH_LEAD, lead: { ...RECORDER_WITH_LEAD.lead!, overdue: [item({ owner: AMINA, overdue: true, dueDate: '2026-09-30' })] } });
    const ownLead = textOf(own.slice(own.indexOf(HOME_COPY.leadOverdueHeading), own.indexOf(HOME_COPY.leadNoMitigationHeading)));
    expect(ownLead).toContain(HOME_COPY.assignedToReader);
    expect(ownLead).not.toContain(AMINA.name);
    expect(linksNamed(h, ['Labels are not checked'])).toEqual([['Labels are not checked', `/orgs/${ORG}/projects/${P1}/findings/f9`]]);
    // A team finding's title is null only once erased: it says so, as an erased mitigation does, never "Untitled".
    const erased = home({ ...RECORDER_WITH_LEAD, lead: { ...RECORDER_WITH_LEAD.lead!, withoutMitigation: [finding({ title: null })] } });
    expect(textOf(erased)).toContain(PROJECT_COPY.followUp.erased);
    expect(textOf(erased)).not.toContain('Untitled');
    // An assessor's Home has no lead lists; an empty list is never shown as a heading over nothing.
    expect(textOf(home(RECORDER))).not.toContain(HOME_COPY.leadOverdueHeading);
    expect(textOf(home({ ...RECORDER_WITH_LEAD, lead: { overdue: [], withoutMitigation: [], multiProject: false } }))).not.toMatch(/Overdue mitigations|Findings with no mitigation yet/);
  });

  it('several projects: "You have N other projects." and All projects; an item names its project when there is more than one', () => {
    const many = base({ projects: [{ id: P1, name: 'Antenatal Risk Triage Model' }, { id: 'p2', name: 'Maize Disease Image Classifier' }, { id: 'p3', name: 'Third' }] });
    const h = home({ ...RECORDER, base: many, otherProjects: 2, assigned: [item({ projectId: 'p2' })] });
    expect(textOf(h)).toContain(HOME_COPY.otherProjects(2));
    expect(textOf(home({ ...RECORDER, base: many, otherProjects: 1 }))).toContain('You have 1 other project.');
    expect(linksNamed(h, [HOME_COPY.allProjects])).toEqual([[HOME_COPY.allProjects, `/orgs/${ORG}/projects`]]);
    expect(textOf(h)).toContain('Maize Disease Image Classifier');
    expect(textOf(home(RECORDER))).not.toContain('other project');
  });

  it('a recorder with nothing saved yet: the first open question with its reason; no "since"', () => {
    const h = home({ ...RECORDER, next: { ...NEXT, rule: 'first-open', lastSavedOn: null }, since: null });
    expect(textOf(h)).toContain(HOME_COPY.reasonFirstOpen);
    expect(textOf(h)).not.toContain('Since your last saved change');
    // An Owner with no saved entry has no next step at all, and no recording control.
    const owner = home({ ...RECORDER_WITH_LEAD, next: null, since: null });
    expect(textOf(owner)).not.toContain(HOME_COPY.nextStepHeading);
    expect(linksNamed(owner, [HOME_COPY.continueRecording])).toHaveLength(0);
  });

  it('first use: "mitigation" and "finding" sit beside their definitions, under Assigned to you; each stage name beside its own', () => {
    const h = home(RECORDER);
    for (const term of [TERM_MITIGATION, TERM_FINDING]) {
      expect(h).toMatch(new RegExp(`<dt[^>]*><span data-term="${term.id}">[^<]+</span></dt><dd[^>]*><span class="ui-definition" data-definition="${term.id}">`));
    }
    for (const term of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3]) expect(h).toContain(`data-definition="${term.id}"`);
    expect(h).toContain(`data-definition="${TERM_SEAL.id}"`);   // beside the first seal in the changes, as the sketch shows it
  });

  it('a hostile project name, question text, mitigation text and person name come out as text, isolated in <bdi>', () => {
    for (const s of HOSTILE_STRINGS) {
      const h = home({
        ...RECORDER, next: { ...NEXT, projectName: s, questionText: s }, assigned: [item({ what: s })],
        since: { ...RECORDER.since!, groups: [group({ who: user('u-h', s) })] }, focus: { ...RECORDER.focus!, projectName: s },
      });
      expect(h).not.toContain(s.startsWith('<') ? '<script>' : '<img');
      expect(textOf(h)).toContain(s);
      expect(h).toContain(`<bdi>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</bdi>`);
    }
  });
});

describe('reviewer, viewer, first visit (spec 9.1, review M13, T9.5)', () => {
  it('reviewer: three lists, no next step, no recording link', () => {
    const h = home(REVIEWER);
    expect(headings(h)).toEqual(expect.arrayContaining([`h2 ${HOME_COPY.reviewerUnsealed}`, `h2 ${HOME_COPY.reviewerChanged}`, `h2 ${HOME_COPY.reviewerRaised}`]));
    expect(linksNamed(h, ['Pre-processing review 1'])).toEqual([['Pre-processing review 1', `/orgs/${ORG}/projects/${P1}/reviews/r1`]]);
    expect(textOf(h)).toContain(TERM_CHANGED_SINCE_SEAL_N.term.replace('{n}', '2'));
    expect(linksNamed(h, ['Labels are not checked'])).toHaveLength(1);
    expect(textOf(h)).not.toContain(HOME_COPY.nextStepHeading);
    expect(h).not.toMatch(/\/questions\/|Continue recording/);
    const empty = textOf(home({ ...REVIEWER, unsealed: [], changedSinceSeal: [], raisedByMe: [] }));
    for (const s of [HOME_COPY.reviewerUnsealedNone, HOME_COPY.reviewerChangedNone, HOME_COPY.reviewerRaisedNone]) expect(empty).toContain(s);
  });

  it('viewer: recent and open, no next step; stage plates link to the reading view, with no "Next:"', () => {
    const h = home(VIEWER);
    expect(headings(h)).toEqual(expect.arrayContaining([`h2 ${HOME_COPY.viewerRecent}`, `h2 ${HOME_COPY.viewerOpen}`]));
    expect(textOf(h)).toContain(HOME_COPY.sinceDecisions(JOSEPH.name, 2, 'In-processing'));
    expect(textOf(h)).toContain(HOME_COPY.sinceMore);
    expect(textOf(h)).not.toMatch(/Your next step|Continue recording|Next:/);
    expect(textOf(h)).toContain('11 open findings');
    expect(textOf(home({ ...VIEWER, recent: { groups: [], more: false } }))).toContain(HOME_COPY.viewerRecentNone);
    expect(textOf(h)).not.toContain(HOME_COPY.stagesLead);   // "You can work on the stages" speaks to a person who records
    expect(linksNamed(h, ['Pre-processing'])).toEqual([['Pre-processing', `/orgs/${ORG}/projects/${P1}/stages/pre-processing`]]);
  });

  it('first time: one sentence and one action for a role that can create; the ask line for a Reviewer or Viewer (M13)', () => {
    for (const role of ['owner', 'admin', 'assessor'] as const) {
      const h = home(firstTime(role, true));
      expect(textOf(h)).toContain(TERM_PRODUCT.definition);
      expect(links(h).filter(([, href]) => href.startsWith('/orgs/'))).toEqual([[HOME_COPY.firstTimeCreate, `/orgs/${ORG}/projects/new`]]);
      expect(textOf(h)).not.toContain(HOME_COPY.firstTimeAsk);
    }
    for (const role of ['reviewer', 'viewer'] as const) {
      const h = home(firstTime(role, false));
      expect(textOf(h)).toContain(TERM_PRODUCT.definition);
      expect(textOf(h)).toContain(HOME_COPY.firstTimeAsk);
      expect(linksNamed(h, [HOME_COPY.firstTimeCreate])).toHaveLength(0);
    }
    // No section of nothing: no "Assigned to you", no "Since", no stage plates.
    expect(textOf(home(firstTime('owner', true)))).not.toMatch(/Assigned to you|Since your last|Still open/);
  });

  it('an organisation with only archived projects is told where they are, not that it has none (B#31)', () => {
    const h = home(firstTime('owner', true, { archivedCount: 2 }));
    expect(textOf(h)).toContain(HOME_COPY.noActiveProjects);
    expect(linksNamed(h, [HOME_COPY.allProjects])).toEqual([[HOME_COPY.allProjects, `/orgs/${ORG}/projects`]]);
    expect(textOf(home(firstTime('owner', true)))).not.toContain(HOME_COPY.noActiveProjects);
  });

  it('after joining (?welcome=1): the h1 is the welcome line, with the role\'s sentence from the vocabulary as plain text', () => {
    const h = home({ ...REVIEWER, base: base({ role: 'reviewer', welcome: true }) });
    expect(headings(h).filter((x) => x.startsWith('h1'))).toEqual([`h1 ${welcomeLine('Makerere AI Lab', roleWithArticle('reviewer'))}`]);
    expect(textOf(h)).toContain(TERM_REVIEWER.definition);
    expect(h).not.toContain(`data-definition="${TERM_REVIEWER.id}"`);   // C10: plain text, not the Definition component
    expect(textOf(home(REVIEWER))).not.toContain(TERM_REVIEWER.definition);
  });

  it('welcome: role sentence from the vocabulary', () => {
    expect(textOf(html(<WelcomeLine orgName="Makerere AI Lab" role="reviewer" />))).toContain(TERM_REVIEWER.definition);
  });
});

describe('fix round 1 (lane lead, 15 November)', () => {
  it('owner ruling: a recorder who has never saved sees "Start recording"; anyone who has saved sees "Continue recording"', () => {
    const never = home({ ...RECORDER, next: { ...NEXT, rule: 'first-open', lastSavedOn: null }, since: null });
    expect(linksNamed(never, [PROJECT_COPY.start])).toEqual([[PROJECT_COPY.start, `/orgs/${ORG}/projects/${P1}/stages/pre-processing/questions/Q-PP-05`]]);
    expect(linksNamed(never, [HOME_COPY.continueRecording])).toHaveLength(0);
    for (const rule of ['next-open', 'last-saved'] as const) {
      const saved = home({ ...RECORDER, next: { ...NEXT, rule } });
      expect(linksNamed(saved, [HOME_COPY.continueRecording])).toHaveLength(1);
      expect(linksNamed(saved, [PROJECT_COPY.start])).toHaveLength(0);
    }
    // Both controls keep one primary and one secondary, primary first.
    // (The page's own "New project" is its quieter button, outside the card: left out of this card's pair.)
    const controls = [...never.matchAll(/<a\b[^>]*class="([^"]*ui-button[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [textOf(m[2]).trim(), m[1].includes('ui-button--primary')])
      .filter(([t]) => t !== PROJECT_COPY.allProjects.newProject);
    expect(controls).toEqual([[PROJECT_COPY.start, true], [HOME_COPY.chooseAnother, false]]);
  });

  it('owner/admin lists stop at 3 rows and then link to the full list, with no cross-stage count (FR-RM-04)', () => {
    const overdue = Array.from({ length: 7 }, (_, i) => item({ mitigationId: `m${i}`, owner: JOSEPH, overdue: true, dueDate: '2026-09-30', what: `Overdue ${i}` }));
    const findings = Array.from({ length: 82 }, (_, i) => finding({ id: `f${i}`, title: `Gap ${i}` }));
    const one = home({ ...RECORDER_WITH_LEAD, lead: { overdue, withoutMitigation: findings, multiProject: false } });
    const rows = (h: string, heading: string, next: string) => (h.slice(h.indexOf(heading), h.indexOf(next)).match(/class="home-row"/g) ?? []).length;
    expect(rows(one, HOME_COPY.leadOverdueHeading, HOME_COPY.leadNoMitigationHeading)).toBe(3);
    expect(rows(one, HOME_COPY.leadNoMitigationHeading, HOME_COPY.stagesLead)).toBe(3);
    expect(linksNamed(one, [HOME_COPY.leadOverdueAll(7), HOME_COPY.leadNoMitigationAll(82)])).toEqual([
      [HOME_COPY.leadOverdueAll(7), `/orgs/${ORG}/projects/${P1}/findings`],
      [HOME_COPY.leadNoMitigationAll(82), `/orgs/${ORG}/projects/${P1}/findings`],
    ]);
    expect(HOME_COPY.leadNoMitigationAll(82)).toBe('See all findings with no mitigation yet'); // FR-RM-04: no cross-stage total
    expect(HOME_COPY.leadOverdueAll(1)).toBe('See the overdue mitigation');
    // Several projects: the link is the rail's Findings entry, in its own words (code review M2: no count it cannot show).
    const many = base({ role: 'owner', projects: [{ id: P1, name: 'Antenatal Risk Triage Model' }, { id: 'p2', name: 'Maize' }] });
    const h = home({ ...RECORDER_WITH_LEAD, base: many, otherProjects: 1, lead: { overdue, withoutMitigation: findings, multiProject: true } });
    expect(linksNamed(h, [PROJECT_COPY.chooseForFindings])).toEqual([
      [PROJECT_COPY.chooseForFindings, `/orgs/${ORG}/projects?for=findings`], [PROJECT_COPY.chooseForFindings, `/orgs/${ORG}/projects?for=findings`],
    ]);
    expect(textOf(h)).not.toContain(HOME_COPY.leadNoMitigationAll(82));
    // Three or fewer: every row, no link.
    const few = home({ ...RECORDER_WITH_LEAD, lead: { overdue: overdue.slice(0, 3), withoutMitigation: findings.slice(0, 3), multiProject: false } });
    expect(textOf(few)).not.toMatch(/See (all|the)|Choose a project/);
  });

  it('a Reviewer or Viewer with mitigations assigned sees "Assigned to you" first; with none, no such section', () => {
    for (const data of [REVIEWER, VIEWER]) {
      const h = home({ ...data, assigned: [item({ owner: AMINA })] } as HomeData);
      const t = textOf(h);
      expect(headings(h)).toContain(`h2 ${HOME_COPY.assignedHeading}`);
      expect(t.indexOf(HOME_COPY.assignedHeading)).toBeLessThan(t.indexOf(data.variant === 'reviewer' ? HOME_COPY.reviewerUnsealed : HOME_COPY.viewerRecent));
      expect(linksNamed(h, ['Write a monthly label audit'])).toHaveLength(1);
      expect(t).not.toContain(HOME_COPY.assignedHeading + HOME_COPY.assignedNone);
      expect(textOf(home(data))).not.toContain(HOME_COPY.assignedHeading);
      expect(textOf(home(data))).not.toContain(HOME_COPY.assignedNone);
    }
  });

  it('the archived-only sentence names the Projects page', () => {
    expect(HOME_COPY.noActiveProjects).toBe('No active projects. Your archived projects are on the Projects page.');
  });
});

/**
 * Spec 6, as the lane lead ruled in fix round 2: a stage's defining use is its plate heading, so every plate carries its
 * stage's definition in a named form, all three alike; the next-step card and the rows carry none. "finding",
 * "mitigation" and "seal" are defined in named term lists (dt + dd) under the heading of the first section that shows an
 * item using them; never over an empty list, never stacked in a row. A Reviewer (no plates) gets the three stage
 * definitions once, as one named list, at the first section that names a stage.
 */
describe('definitions (fix round 2 ruling)', () => {
  const STAGE_IDS = [TERM_STAGE_1.id, TERM_STAGE_2.id, TERM_STAGE_3.id];
  const defs = (h: string, id: string) => (h.match(new RegExp(`data-definition="${id}"`, 'g')) ?? []).length;
  /** The definitions inside a part of the page, by id. */
  const defsIn = (part: string) => [...part.matchAll(/data-definition="([a-z0-9-]+)"/g)].map((m) => m[1]);
  /** Each `<dl class="home-terms">` as its [dt words, dd definition id] pairs. */
  const termLists = (h: string) => [...h.matchAll(/<dl class="home-terms">([\s\S]*?)<\/dl>/g)].map((m) =>
    [...m[1].matchAll(/<dt>([\s\S]*?)<\/dt><dd>[\s\S]*?data-definition="([a-z0-9-]+)"/g)].map((p) => [textOf(p[1]), p[2]]));

  it('every stage plate carries its own stage definition, named; the next-step card and the rows carry none', () => {
    for (const data of [RECORDER, RECORDER_WITH_LEAD, VIEWER]) {
      const h = home(data);
      for (const [i, stage] of (['pre-processing', 'in-processing', 'post-processing'] as const).entries()) {
        const plate = h.slice(h.indexOf(`data-stage="${stage}"`), i < 2 ? h.indexOf(`data-stage="${['in-processing', 'post-processing'][i]}"`) : undefined);
        expect(plate).toMatch(new RegExp(`<p class="home-stage__def"><span class="home-stage-name"><span data-term="${STAGE_IDS[i]}">[^<]+</span></span>: <span class="ui-definition" data-definition="${STAGE_IDS[i]}">`));
      }
      const card = h.includes('class="home-next"') ? h.slice(h.indexOf('class="home-next"'), h.indexOf('</section>', h.indexOf('class="home-next"'))) : '';
      expect(defsIn(card)).toEqual([]);
      for (const row of h.matchAll(/<li class="(home-plate|home-row|home-changes__row)"[\s\S]*?<\/li>/g)) expect(defsIn(row[0])).toEqual([]);
      for (const id of STAGE_IDS) expect(defs(h, id)).toBe(1);   // one project's plates: each stage defined once
    }
  });

  it('"Mitigation" and "Finding" are a named list under "Assigned to you", not over an empty list; "Seal" under the first list with a seal', () => {
    expect(termLists(home(RECORDER))[0]).toEqual([['Mitigation', TERM_MITIGATION.id], ['Finding', TERM_FINDING.id]]);
    const empty = home({ ...RECORDER, assigned: [] });
    expect(empty.slice(empty.indexOf(HOME_COPY.assignedHeading), empty.indexOf(HOME_COPY.assignedNone))).not.toContain('home-terms');
    // With nothing assigned, the first use moves on: here the stages' open findings and overdue mitigations.
    expect(termLists(empty).flat().map(([, id]) => id)).toEqual(expect.arrayContaining([TERM_FINDING.id, TERM_MITIGATION.id]));
    const since = home(RECORDER);
    const sinceList = since.slice(since.indexOf('Since your last saved change'));
    expect(termLists(sinceList)[0]).toEqual([['Seal', TERM_SEAL.id]]);
    for (const id of [TERM_FINDING.id, TERM_MITIGATION.id, TERM_SEAL.id]) expect(defs(since, id)).toBeLessThanOrEqual(1);
  });

  it('a Reviewer gets the three stage definitions once, as one named list at the first section naming a stage', () => {
    const h = home(REVIEWER);
    for (const id of STAGE_IDS) expect(defs(h, id)).toBe(1);
    const first = h.slice(h.indexOf(HOME_COPY.reviewerUnsealed), h.indexOf(HOME_COPY.reviewerChanged));
    expect(termLists(first)[0].map(([, id]) => id)).toEqual(STAGE_IDS);
    const assigned = home({ ...REVIEWER, assigned: [item()] } as HomeData);
    const top = assigned.slice(assigned.indexOf(HOME_COPY.assignedHeading), assigned.indexOf(HOME_COPY.reviewerUnsealed));
    expect(termLists(top)[0].map(([, id]) => id)).toEqual([TERM_MITIGATION.id, TERM_FINDING.id, ...STAGE_IDS]);
    // No "Seal" list over the empty changed list (design review #13).
    const none = home({ ...REVIEWER, changedSinceSeal: [] });
    expect(defs(none, TERM_SEAL.id)).toBe(0);
  });
});

describe('fix round 2', () => {
  it('#8: with no next step, the stages (and the lead lists) take the first column, before "Assigned to you"', () => {
    const t = textOf(home({ ...RECORDER_WITH_LEAD, next: null, since: null }));
    expect(t.indexOf(HOME_COPY.leadOverdueHeading)).toBeLessThan(t.indexOf(HOME_COPY.stagesLead));
    expect(t.indexOf(HOME_COPY.stagesLead)).toBeLessThan(t.indexOf(HOME_COPY.assignedHeading));
    const withNext = textOf(home(RECORDER_WITH_LEAD));
    expect(withNext.indexOf(HOME_COPY.assignedHeading)).toBeLessThan(withNext.indexOf(HOME_COPY.stagesLead));
  });

  it('#12: a first visit says "Welcome, <name>.", not "Welcome back"', () => {
    const h = home(firstTime('owner', true));
    expect(headings(h).filter((x) => x.startsWith('h1'))).toEqual([`h1 ${HOME_COPY.welcomeFirst(AMINA.name)}`]);
    expect(textOf(h)).not.toContain('Welcome back');
  });

  it('#10: each tally count is bold ink', () => {
    expect(home(RECORDER)).toMatch(/<li class="home-tally__item" data-tally-kind="done">[\s\S]*?<b class="home-tally__count">1<\/b> done<\/span>/);
  });

  it('M6: a single open finding links to its stage\'s findings too', () => {
    const one = home({ ...RECORDER, focus: { ...RECORDER.focus!, stages: STAGES_OPEN.map((s) => (s.stage === 'post-processing' ? { ...s, openFindings: 1 } : s)) } });
    expect(linksNamed(one, ['1 open finding'])).toEqual([
      ['1 open finding', `/orgs/${ORG}/projects/${P1}/findings?stage=in-processing`], ['1 open finding', `/orgs/${ORG}/projects/${P1}/findings?stage=post-processing`],
    ]);
  });
});

describe('S-08\'s protected cases, on the rebuilt Home (plan 1B Task 10; ledger entries in test-replacements.json)', () => {
  it('SRS 11.2 FR-PRJ-04: the stage plates show per-stage counts, no assessment count and no completed count, and Home reads no assessment', () => {
    // The fixture's question text says "assessment"; a team's own words are not the platform's count, so it is changed here.
    for (const data of [{ ...RECORDER, next: { ...NEXT, questionText: 'Who is the system for?' } }, VIEWER]) {
      const h = home(data);
      expect(textOf(h)).toContain('11 open findings');
      expect(textOf(h)).toContain(tallyWords({ no_decision: 18 }));
      expect(h).not.toMatch(/\bAssessments?\b|\bcompleted\b/i);
    }
    const files = ['app/(authenticated)/orgs/[slug]/dashboard/page.tsx', 'lib/home/load.ts', ...readdirSync('components/home').filter((f) => f.endsWith('.tsx')).map((f) => `components/home/${f}`)];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.assessments\b|\bassessments\s*:|\btx\.assessment\b/);
  });

  it('UX-06 (spec 7.1, 9.1): in a mitigation line the word Overdue and the overdue date are red, outside any status word; a due one is plain text; no status word carries a warning class', () => {
    const page = home({ ...RECORDER, assigned: [item({ overdue: true, dueDate: '2026-10-28' }), item({ mitigationId: 'm2', what: 'Re-run check', dueDate: '2026-11-20', status: 'in_progress' })] });
    const h = page.slice(page.indexOf(HOME_COPY.assignedHeading), page.indexOf('Since your last saved change'));   // the "Assigned to you" section
    expect(textOf(h)).toContain(`${PROJECT_COPY.followUp.overdue}${PROJECT_COPY.followUp.wasDue('28 Oct 2026')}`);
    // Two red spans: the word, then the date; ": was due " between them is plain text (spec 7.1: red on an overdue date and the word).
    expect([...h.matchAll(/<span class="home-overdue">([\s\S]*?)<\/span>([^<]*)/g)].map((m) => [textOf(m[1]), m[2]])).toEqual([
      [PROJECT_COPY.followUp.overdue, ': was due '], ['28 Oct 2026', ''],
    ]);
    expect(textOf(h)).toContain(PROJECT_COPY.followUp.due('20 Nov 2026'));
    expect(h).not.toMatch(/<[^>]*home-overdue[^>]*>[^<]*Due /);
    expect([...h.matchAll(/class="home-plate__status"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(['Planned', 'In progress']);
    expect(h).not.toMatch(/status-label--warning|badge--moderate/);
  });

  it('FR-PRJ-04 F11: a mitigation whose text was erased says so, and a recorded one does not', () => {
    const h = home({ ...RECORDER, assigned: [item({ what: null }), item({ mitigationId: 'm2', what: 'Re-run check' })] });
    expect(textOf(h).split(PROJECT_COPY.followUp.erased)).toHaveLength(2);
    expect(textOf(h)).toContain('Re-run check');
  });

  it('UX-07 FR-PRJ-04: Home shows no total of mitigations and no emoji', () => {
    const h = home({ ...RECORDER_WITH_LEAD, assigned: [item(), item({ mitigationId: 'm2', overdue: true })] });
    expect(h).not.toMatch(/\(\d+\)|\d+ mitigations? in total|in all/);
    expect(h).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('HomeUnsavedLine (spec 9.7 line 459; defect 23)', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, String(v)); },
    };
  };
  const now = new Date('2026-11-15T08:00:00.000Z');
  const put = (s: Storage, userId: string, orgId: string, questionId: string) =>
    s.setItem(draftKey({ userId, orgId, projectId: P1, target: { kind: 'question', questionId } }), JSON.stringify({ baseVersionNumber: null, value: {}, savedAt: '2026-11-14T08:00:00.000Z', savePressedAt: null, retry: { requestId: null, sentBody: null } }));

  it('store null → nothing; 0 → nothing; 1 → singular sentence; several → plural; storage throws → nothing', () => {
    expect(unsavedSentence(null, 'u', 'o1', now)).toBeNull();
    const s = memory();
    const store = openDraftStore(s);
    expect(unsavedSentence(store, 'u', 'o1', now)).toBeNull();
    put(s, 'u', 'o1', 'Q-PP-01');
    expect(unsavedSentence(store, 'u', 'o1', now)).toBe(HOME_COPY.unsaved(1));
    put(s, 'u', 'o1', 'Q-PP-02');
    put(s, 'u', 'o2', 'Q-PP-03');           // another organisation's draft is not counted here
    put(s, 'other', 'o1', 'Q-PP-04');       // nor another account's
    expect(unsavedSentence(store, 'u', 'o1', now)).toBe(HOME_COPY.unsaved(2));
    const throwing: Storage = { ...memory(), getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, key: () => { throw new Error('blocked'); }, get length(): number { throw new Error('blocked'); } };
    expect(unsavedSentence(openDraftStore(throwing), 'u', 'o1', now)).toBeNull();
    expect(DRAFT_PREFIX).toBe('makrai.draft.v1:');
  });
});

describe('Home\'s "New project" (role-matrix O-13; coordinator ruling, 15 November)', () => {
  const NEW = PROJECT_COPY.allProjects.newProject;
  const newLinks = (h: string) => links(h).filter(([t]) => t === NEW);
  const noNext: HomeData = { ...RECORDER, next: null };
  for (const role of ['owner', 'admin', 'assessor'] as const) {
    it(`${role}: exactly one "New project" link, to the new-project page, quieter beside a next-step card`, () => {
      const h = home({ ...RECORDER, base: base({ role }) });
      expect(newLinks(h)).toEqual([[NEW, `/orgs/${ORG}/projects/new`]]);
      expect(h).toMatch(/<a\b[^>]*class="ui-button ui-button--secondary"[^>]*href="[^"]*\/projects\/new"/);
    });
    it(`${role}: with no next-step card it is the one primary control, still only one`, () => {
      const h = home({ ...noNext, base: base({ role }) });
      expect(newLinks(h)).toHaveLength(1);
      expect(h).toMatch(/<a\b[^>]*class="ui-button ui-button--primary"[^>]*href="[^"]*\/projects\/new"/);
    });
  }
  it('the first-time state keeps its single "Create a project" and gains no second link', () => {
    const h = home(firstTime('owner', true));
    expect(newLinks(h)).toHaveLength(0);
    expect(links(h).filter(([, href]) => href.endsWith('/projects/new'))).toHaveLength(1);
  });
  for (const data of [REVIEWER, VIEWER]) {
    it(`${data.base.role}: no "New project" link`, () => {
      expect(newLinks(home(data))).toHaveLength(0);
      expect(links(home(data)).filter(([, href]) => href.endsWith('/projects/new'))).toHaveLength(0);
    });
  }
});
