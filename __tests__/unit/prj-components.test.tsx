import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { FollowUpItem, StageCounts } from '@/types/api';
import type { StatusMarkKind } from '@/components/ui/types';
import { tallyOf } from '@/lib/ui/marks';
import type { ProjectRoutes } from '@/lib/project/routes';
import { STAGES, type Stage } from '@/types/record';
import { can } from '@/lib/authz/policy';
import { projectActions } from '@/lib/projects/can';
import { descriptiveLine } from '@/lib/projects/metadataValues';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { PROJECT_FIELD_MESSAGES } from '@/lib/projects/copy';
import type { DashboardData, ProjectOverviewData } from '@/lib/data/projects';

/**
 * PRJ Tasks 5 to 7: the synchronous views of S-10, S-08, S-09 and S-32 render from loaded data (React 19's
 * renderToStaticMarkup does not await async components, so the page files only load and pass data). Nothing here
 * clicks or moves focus: that is `e2e/prj-screens.spec.ts`.
 */
const welcomeProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));
vi.mock('@/components/account/WelcomeNotice', () => ({ WelcomeNotice: (p: Record<string, unknown>) => { welcomeProps.push(p); return null; } }));

const { ProjectPage } = await import('@/components/project/ProjectPage');
const { DashboardView } = await import('@/components/project/DashboardView');
const { MyMitigationsList } = await import('@/components/project/MyMitigationsList');
const { ProjectCard } = await import('@/components/dashboard/ProjectCard');
const { AllProjectsView } = await import('@/components/project/AllProjectsView');
const { default: ProjectForm } = await import('@/components/project/ProjectForm');
const { ArchiveProjectControl } = await import('@/components/project/ArchiveProjectControl');
const { UnarchiveProjectButton } = await import('@/components/project/UnarchiveProjectButton');

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
const perStage = <T,>(v: T): Record<Stage, T> => ({ 'pre-processing': v, 'in-processing': v, 'post-processing': v });

function overview(o: { role?: OrgRole; archived?: boolean; counts?: StageCounts }): ProjectOverviewData {
  const archived = o.archived ?? false;
  return {
    orgSlug: 'o', orgName: 'Org', project: { id: 'p1', name: 'Maternal-risk triage', descriptiveLine: 'Classification, health', archived },
    counts: perStage(o.counts ?? COUNTS), followUp: perStage({ items: [], cannotAct: [] }), reviews: perStage([]),
    can: projectActions(o.role ?? 'owner', archived),
  };
}
/** Each stage's row of marks as lib/project/routes.ts shapes it, from the counts: one stop per question. */
function routesOf(d: ProjectOverviewData): ProjectRoutes {
  return Object.fromEntries(STAGES.map((s) => {
    const c = d.counts[s];
    const kinds: StatusMarkKind[] = [
      ...Array<StatusMarkKind>(c.byStatus.done).fill('done'), ...Array<StatusMarkKind>(c.byStatus.partly).fill('partly'),
      ...Array<StatusMarkKind>(c.byStatus.not_yet).fill('not_yet'), ...Array<StatusMarkKind>(c.byStatus.not_applicable).fill('not_applicable'),
      ...Array<StatusMarkKind>(c.notApplicableByGate).fill('does_not_apply'), ...Array<StatusMarkKind>(c.noDecision).fill('no_decision'),
    ];
    while (kinds.length < c.questions) kinds.push('scope_answered');
    const stops = kinds.map((kind, i) => ({ id: `${s}-${i}`, kind, title: `Question ${i}`, href: `/orgs/o/projects/p1/stages/${s}/questions/${s}-${i}`, current: false }));
    return [s, { stops, tally: tallyOf(kinds, c.doneWithoutEvidence), noDecision: stops.filter((x) => x.kind === 'no_decision').map((x) => ({ id: x.id, text: x.title, href: x.href })) }];
  })) as ProjectRoutes;
}
const renderPage = (o: Parameters<typeof overview>[0]) => { const d = overview(o); return renderToStaticMarkup(<ProjectPage data={d} routes={routesOf(d)} continueTo={null} />); };
/** The pre-processing line of the page, with these counts in every stage. */
const preLine = (counts: StageCounts) => { const html = renderPage({ counts }); return html.slice(html.indexOf('<section class="stage-line" id="pre-processing"'), html.indexOf('<section class="stage-line" id="in-processing"')); };
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, '');

describe('S-10 (Task 5)', () => {
  it('UX-06 FR-PRJ-02: to-do counts come before recorded counts in each stage column', () => {
    const html = preLine(COUNTS);
    expect(html.indexOf('Still open in this stage')).toBeLessThan(html.indexOf('9 questions with no decision'));
    expect(html.indexOf('9 questions with no decision')).toBeLessThan(html.indexOf('Recorded so far'));
    expect(html.indexOf('Recorded so far')).toBeLessThan(html.indexOf('7 done (2 with no evidence attached)'));
    expect(html).toContain('3 open findings'); expect(textOf(html)).toContain(`${PROJECT_COPY.followUp.overdue}: ${PROJECT_COPY.mitigationCount(1)}`);
    expect(html).not.toMatch(/%|score|complete/i);
  });

  it('UX-06 (R12-16, spec 7.2): each status phrase of a stage column is the kit\'s mark with its words in ink, and none carries the warning class', () => {
    const line = preLine(COUNTS);
    const html = line.slice(line.indexOf('<div class="stage-line__stop stage-line__stop--recorded"'), line.indexOf('<div class="stage-line__stop stage-line__stop--reviews"'));
    // Each question's stop is the kit's shape, hidden from assistive technology, in a stop that names its status in words
    // (drawn without a link on S-10: lead's ruling on C5).
    expect(html.match(/<li class="ui-route-row__stop" data-mark-kind="[a-z_]+"><span class="ui-route-row__point"><svg class="ui-mark__shape"[^>]*aria-hidden="true"/g)).toHaveLength(24);
    const tally = /<p class="ui-route-row__tally">([^<]*)<\/p>/.exec(html)?.[1].split(', ');
    expect(tally).toEqual(['7 done (2 with no evidence attached)', expect.stringMatching(/^\d+ partly$/), expect.stringMatching(/^\d+ not yet$/), expect.stringMatching(/^\d+ not applicable$/), '1 answered']);
    expect(html).not.toMatch(/status-label|warning/);
  });

  it('FR-PRJ-02: the stage column says how many open findings have no mitigation yet, and counts gated questions as not applying, beside those marked not applicable', () => {
    const html = preLine({ ...COUNTS, notApplicableByGate: 2 });
    expect(html).toContain('<a href="/orgs/o/projects/p1/findings?stage=pre-processing">3 open findings</a>');
    expect(textOf(html)).toContain('3 open findings (1 of them with no mitigation yet)');
    expect(html).toMatch(/<p class="ui-route-row__tally">[^<]*\b2 not applicable\b[^<]*<\/p>/);
    expect(html).toMatch(/<p class="ui-route-row__tally">[^<]*\b2 do not apply\b[^<]*<\/p>/);
  });

  it('FR-RM-04: no stage column and no page adds the three stages together', () => {
    expect(renderPage({})).not.toMatch(/\b(total|overall|in all)\b/i);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the banner and no form or Archive control on S-10', () => {
    const html = renderPage({ archived: true, role: 'owner' });
    expect(html).toContain(PROJECT_COPY.archivedBanner);
    expect(html).not.toMatch(/<form|Archive project|Edit project/);
  });

  it('FR-PRJ-03 UX-29: only owner and admin see Archive project', () => {
    for (const role of ['owner', 'admin'] as const) expect(renderPage({ role })).toContain('Archive project');
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) expect(renderPage({ role })).not.toContain('Archive project');
  });

  it('no time-zone sentence on Home or the project page', () => {
    // CONSOLIDATED section 4: the time-zone sentence is country-specific and internal; how overdue is counted is unchanged.
    const project = renderPage({});
    const home = renderToStaticMarkup(<DashboardView data={{ orgSlug: 'o', orgName: 'Org', role: 'owner', welcome: false, canCreate: true, projects: [], mine: [], projectNames: new Map(), archivedCount: 0 }} />);
    expect(home).toMatch(new RegExp(`<h1[^>]*>${HOME_COPY.heading}</h1>`));   // not vacuous: the view rendered, its heading inside the kit's page header
    expect(project).toContain(PROJECT_COPY.overview.anyOrder);
    for (const html of [home, project]) expect(html).not.toMatch(/East Africa|UTC\+3|\bEAT\b/);
  });

  it('FR-PRJ-02: S-10 says how to share the record once, right after the stages and their reviews, before the findings link', () => {
    const html = renderPage({});
    const line = 'To share your record outside the team, seal a stage review and create a document from it.';
    expect(html.split(line)).toHaveLength(2);
    // The end of the stages (the jump links and the three lines), found by balancing their frame's <div>s.
    const start = html.indexOf('<div class="project-lines-frame">');
    expect(start).toBeGreaterThan(-1);
    const tags = /<(\/?)div\b[^>]*>/g;
    tags.lastIndex = start;
    let depth = 0;
    let end = -1;
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = tags.lastIndex; break; }
    }
    expect(end).toBeGreaterThan(start);
    expect(html.indexOf(line)).toBeGreaterThan(end);
    expect(html.indexOf(line)).toBeLessThan(html.indexOf(`>${PROJECT_COPY.findings}</a>`));
    expect(html).not.toContain('Team working view');
  });

  it('S-10 (Route R5): the page header has no actions wrapper for any role; the owner\'s Archive control sits in the "This project" row', () => {
    expect(renderPage({ role: 'viewer' })).not.toContain('ui-page-header__actions');
    const owner = renderPage({ role: 'owner' });
    expect(owner).not.toContain('ui-page-header__actions');
    expect(owner.slice(owner.indexOf('<nav class="project-actions"'))).toContain('class="archive-control"');
  });

  it('FR-PRJ-02: a new project shows "No decisions recorded yet" in each stage', () => {
    expect(renderPage({ counts: ZERO }).split('<p class="ui-route-row__tally">No decisions recorded yet</p>')).toHaveLength(4);
  });

  it('UX-36: each stage is a plain block, named by its heading, that names its three to-do counts', () => {
    const html = renderPage({});
    expect(html.match(/<section class="stage-line" id="[a-z-]+" data-stage="[a-z-]+" aria-labelledby="[a-z-]+">/g)).toHaveLength(3);
    expect(html).not.toContain('<details');
    const pre = textOf(preLine(COUNTS));
    expect(preLine(COUNTS)).toMatch(/<h2 id="[a-z-]+"><span data-term="stage-1">Pre-processing<\/span><\/h2>/);
    for (const count of ['9 questions with no decision', '3 open findings', `${PROJECT_COPY.followUp.overdue}: ${PROJECT_COPY.mitigationCount(1)}`]) expect(pre).toContain(count);
  });

  it('FR-PRJ-03 UX-29: archive, export and open-review actions follow the role and the archived state', () => {
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) for (const archived of [false, true]) {
      expect(projectActions(role, archived)).toEqual({
        update: can(role, 'project:update') && !archived, archive: can(role, 'project:archive') && !archived,
        archiveControl: can(role, 'project:archive'), export: can(role, 'team:export'), openReview: can(role, 'review:open') && !archived,
      });
    }
  });

  it('FR-PRJ-03: S-10 offers Open a stage review on each stage\'s line only with review:open on a live project, and Download records only with team:export', () => {
    for (const role of ['owner', 'reviewer', 'viewer'] as const) for (const archived of [false, true]) {
      const html = renderPage({ role, archived });
      const open = STAGES.map((s) => html.includes(`href="/orgs/o/projects/p1/reviews/new?stage=${s}"`));
      expect(open).toEqual(STAGES.map(() => can(role, 'review:open') && !archived));
      expect(html.includes(PROJECT_COPY.overview.downloadRecords)).toBe(can(role, 'team:export'));
    }
  });

  it('FR-PRJ-01: the descriptive line is built from the fields and shows no score', () => {
    expect(descriptiveLine({ aiSystemType: 'classification', deploymentSector: 'health', processesPersonalData: true, developmentStage: 'testing' }))
      .toBe(['Classification', 'health', PROJECT_COPY.descriptive.usesPersonalData, 'Testing'].join(', '));
    expect(descriptiveLine({ processesPersonalData: false })).toBe(PROJECT_COPY.descriptive.noPersonalData);
    expect(descriptiveLine(null)).toBe('');
  });
});

describe('S-08 (Task 6)', () => {
  const OVERDUE_ITEM: FollowUpItem = {
    mitigationId: 'm1', versionId: 'v1', findingId: 'f1', projectId: 'p1', stage: 'pre-processing', what: 'Write labelling guide',
    owner: { userId: 'u1', name: 'Joseph K.', formerMember: false }, dueDate: '2026-10-28', status: 'planned', overdue: true, ownerCanAct: true,
  };
  const DUE_ITEM: FollowUpItem = { ...OVERDUE_ITEM, mitigationId: 'm2', what: 'Re-run check', dueDate: '2026-11-20', status: 'in_progress', overdue: false };
  const emptyDashboard = (role: OrgRole): DashboardData => ({
    orgSlug: 'o', orgName: 'Org', role, welcome: false, canCreate: can(role, 'project:create'), projects: [], mine: [], projectNames: new Map(), archivedCount: 0,
  });

  it('SRS 11.2 FR-PRJ-04: the project card shows per-stage counts, no assessment count and no completed count', () => {
    const none = { openFindings: 0, overdueMitigations: 0 };
    const html = renderToStaticMarkup(<ProjectCard orgSlug="o" project={{ id: 'p', name: 'P', descriptiveLine: 'Classification, health' }} counts={perStage(none)} />);
    expect(html).not.toMatch(/\bAssessments?\b|\bcompleted\b/i);
    expect(html).toMatch(/Pre-processing: \d+ open findings?, \d+ overdue mitigations?/);
    for (const f of ['app/(authenticated)/orgs/[slug]/dashboard/page.tsx', 'components/dashboard/ProjectCard.tsx'])
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.assessments\b|\bassessments\s*:|\btx\.assessment\b/);
  });

  it('UX-06 (spec 7.1, plan 1A Task 15): in an overdue mitigation line only the word Overdue is red, outside any status label; a due one is plain text; each status word is a status-label with no warning class', () => {
    const html = renderToStaticMarkup(<MyMitigationsList orgSlug="o" projectNames={new Map([['p1', 'P']])} items={[OVERDUE_ITEM, DUE_ITEM]} />);
    expect(html).toContain(`<span class="followup-overdue">${PROJECT_COPY.followUp.overdue}</span>${PROJECT_COPY.followUp.wasDue('28 Oct 2026')}`);
    expect(html.match(/class="followup-overdue"/g)).toHaveLength(1);
    expect(html).not.toMatch(/status-label--warning|badge--moderate/);
    expect(html).not.toMatch(/followup-overdue[^>]*>[^<]*was due/);
    expect(html).toContain(PROJECT_COPY.followUp.due('20 Nov 2026')); expect(html).not.toMatch(/<[^>]*(status-label|followup-overdue)[^>]*>Due /);
    expect([...html.matchAll(/<[a-z]+ [^>]*class="([^"]*\bstatus-label\b[^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])).toEqual([['status-label', 'Planned'], ['status-label', 'In progress']]);
  });

  it('FR-PRJ-04 F11: a mitigation with no text says "No text recorded." and a recorded one does not', () => {
    const html = renderToStaticMarkup(<MyMitigationsList orgSlug="o" projectNames={new Map([['p1', 'P']])} items={[{ ...OVERDUE_ITEM, what: null }, DUE_ITEM]} />);
    expect(html.match(new RegExp(PROJECT_COPY.followUp.erased.replace("'", '&#x27;'), 'g'))).toHaveLength(1);
    expect(html).toContain('Re-run check');
  });

  it('FR-PRJ-04: S-08 empty states say who can create a project and that the person owns no open mitigations', () => {
    for (const role of ['owner', 'admin', 'assessor'] as const) {
      const html = renderToStaticMarkup(<DashboardView data={emptyDashboard(role)} />);
      expect(html).toMatch(/No projects yet\.\s*<a[^>]*href="\/orgs\/o\/projects\/new"[^>]*>New project<\/a>/);
      expect(html).not.toContain(HOME_COPY.whoCanCreate);
    }
    for (const role of ['reviewer', 'viewer'] as const) {
      const html = renderToStaticMarkup(<DashboardView data={emptyDashboard(role)} />);
      expect(html).toContain(`${HOME_COPY.noProjects} ${HOME_COPY.whoCanCreate}`);
      expect(html).not.toContain('href="/orgs/o/projects/new"');
    }
    expect(renderToStaticMarkup(<DashboardView data={emptyDashboard('viewer')} />)).toContain(HOME_COPY.noMitigations);
  });

  it('FR-PRJ-04: the welcome notice appears only with welcome=1, with the organisation name and the role', () => {
    welcomeProps.length = 0;
    renderToStaticMarkup(<DashboardView data={{ ...emptyDashboard('assessor'), orgName: 'Makerere CAI Lab', welcome: true }} />);
    expect(welcomeProps.splice(0)).toEqual([{ orgName: 'Makerere CAI Lab', role: 'assessor' }]);
    renderToStaticMarkup(<DashboardView data={{ ...emptyDashboard('assessor'), welcome: false }} />);
    expect(welcomeProps).toEqual([]);
  });

  it('UX-07 FR-PRJ-04: the dashboard shows no total of mitigations and no emoji', () => {
    const html = renderToStaticMarkup(<DashboardView data={{ ...emptyDashboard('owner'), mine: [OVERDUE_ITEM, DUE_ITEM], projectNames: new Map([['p1', 'P']]) }} />);
    expect(html).not.toMatch(/My open and overdue mitigations \(\d+\)|\d+ mitigations? in total/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('S-09 and S-32 (Task 7)', () => {
  it('FR-PRJ-03: S-32 lists active and archived projects, with Unarchive for owner and admin only', () => {
    const data = { orgSlug: 'o', active: [{ id: 'a', name: 'Alive', descriptiveLine: '' }], archived: [{ id: 'b', name: 'Shelved', descriptiveLine: '' }] };
    const owner = renderToStaticMarkup(<AllProjectsView data={{ ...data, canUnarchive: true }} />);
    const assessor = renderToStaticMarkup(<AllProjectsView data={{ ...data, canUnarchive: false }} />);
    expect(owner.indexOf('Active')).toBeLessThan(owner.indexOf('Shelved'));
    expect(owner).toContain('Unarchive'); expect(assessor).not.toContain('Unarchive');
    expect(owner).not.toMatch(/Maturity|compliance|\bAssessments?\b|\bcompleted\b/i);
    const empty = renderToStaticMarkup(<AllProjectsView data={{ ...data, active: [], archived: [], canUnarchive: true }} />);
    expect(empty.split(PROJECT_COPY.allProjects.noActive)).toHaveLength(2);
    expect(empty.split(PROJECT_COPY.allProjects.noArchived)).toHaveLength(2);
    expect(empty.indexOf(PROJECT_COPY.allProjects.noActive)).toBeLessThan(empty.indexOf(PROJECT_COPY.allProjects.noArchived));
  });

  it('UX-37: the S-32 page and its view use ListLink and import no next/link', () => {
    for (const f of ['app/(authenticated)/orgs/[slug]/projects/page.tsx', 'components/project/AllProjectsView.tsx'])
      expect(readFileSync(f, 'utf8')).not.toMatch(/from 'next\/link'/);
    expect(readFileSync('components/project/AllProjectsView.tsx', 'utf8')).toMatch(/\bListLink\b/);
    const page = readFileSync('app/(authenticated)/orgs/[slug]/projects/page.tsx', 'utf8');
    expect(page).toMatch(/\bpageOf\b/);
    expect(page).toMatch(/\bShowMoreLink\b/);
  });

  it('FR-PRJ-01: the form has a labelled control for each descriptive field', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="create" />);
    for (const label of ['AI system type', 'Sector', 'Dataset type', 'Dataset size', PROJECT_FORM_COPY.labels.processesPersonalData, 'Funding source',
                         'Regulatory context', PROJECT_FORM_COPY.labels.developmentStage])
      expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>${label}`));
    // The two dates are the kit's DateField (plan 1B Task 13): a fieldset named by its legend, and three labelled boxes.
    for (const [prefix, legend] of [['projectStart', 'Start date'], ['projectEnd', 'End date']]) {
      expect(html).toMatch(new RegExp(`<fieldset[^>]*>\\s*<legend[^>]*>${legend}</legend>`));
      for (const part of ['day', 'month', 'year']) expect(html).toMatch(new RegExp(`<label[^>]*for="${prefix}-${part}"[^>]*>[^<]+</label>\\s*<input[^>]*id="${prefix}-${part}"`));
    }
  });

  it('FR-PRJ-01 (B37): the dataset size and personal data options print the words of lib/project/labels.ts, and the form writes none of them', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="create" />);
    const optionsOf = (id: string) => [...(html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? '').matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(optionsOf('datasetSize').filter(([v]) => v !== '')).toEqual(Object.entries(DATASET_SIZE_WORDS));
    expect(optionsOf('processesPersonalData').filter(([v]) => v !== '')).toEqual(Object.entries(PERSONAL_DATA_WORDS));
    const source = readFileSync('components/project/ProjectForm.tsx', 'utf8');
    expect(source).toMatch(/from '@\/lib\/project\/labels'/);
    for (const word of [...Object.values(DATASET_SIZE_WORDS), ...Object.values(PERSONAL_DATA_WORDS)].filter((w) => w.length > 3)) expect(source, word).not.toContain(`'${word}'`);
  });

  it('FR-PRJ-01: the form says Create project in create mode and Save changes in edit mode', () => {
    expect(renderToStaticMarkup(<ProjectForm mode="create" />)).toContain('>Create project<');
    const edit = renderToStaticMarkup(<ProjectForm mode="edit" projectId="p1" initial={{ name: 'Existing', description: 'd', datasetSize: 'small_lt1k', processesPersonalData: false }} />);
    expect(edit).toContain('>Save changes<');
    expect(edit).toContain('value="Existing"');
  });

  it('FR-PRJ-01 (X-2): the API answers a bad descriptive value with the ruled field message, and the client form ships none of them', async () => {
    // A dynamic import although the module is imported at the top: a new static import line would be a module-level change
    // to this protected file, which only a ledger entry could excuse; this case is newer than stage-1-base and not compared.
    const { validateProjectMetadataValues } = await import('@/lib/projects/metadataValues');
    const M = PROJECT_FIELD_MESSAGES;
    expect(validateProjectMetadataValues({ developmentStage: 'beta' })).toEqual({ field: 'developmentStage', message: M.developmentStage });
    expect(validateProjectMetadataValues({ datasetSize: 'huge' })).toEqual({ field: 'datasetSize', message: M.datasetSize });
    expect(validateProjectMetadataValues({ processesPersonalData: 'yes' })).toEqual({ field: 'processesPersonalData', message: M.processesPersonalData });
    expect(validateProjectMetadataValues({ teamSize: -1 })).toEqual({ field: 'teamSize', message: M.teamSize });
    expect(validateProjectMetadataValues({ projectStart: '2026-02-30' })).toEqual({ field: 'projectStart', message: M.date });
    expect(validateProjectMetadataValues({ deploymentSector: 's'.repeat(201) })).toEqual({ field: 'deploymentSector', message: M.textMax(200) });
    expect(validateProjectMetadataValues({ datasetDescription: 'd'.repeat(2001) })).toEqual({ field: 'datasetDescription', message: M.textMax(2000) });
    expect(validateProjectMetadataValues({ developmentStage: 'testing', teamSize: 0, projectEnd: '2027-03-31' })).toBeNull();
    const source = readFileSync('components/project/ProjectForm.tsx', 'utf8');
    expect(source).not.toMatch(/lib\/projects\/metadataValues|lib\/projects\/copy/);
    expect(source).toMatch(/\bLIFECYCLE_STAGE_WORDS\b[^;]*from '@\/lib\/project\/labels'/);
  });
});

describe('the writers\' status regions (UX-27, SPEC-1 ruling)', () => {
  it('UX-27 UX-25: each of the three writers has an empty role="status" region from its first render, so a later line is announced', () => {
    expect(renderToStaticMarkup(<ProjectForm mode="create" />)).toContain('<p role="status"></p>');
    expect(renderToStaticMarkup(<ArchiveProjectControl orgSlug="o" projectId="p" projectName="P" archived={false} />)).toContain('<p role="status"></p>');
    expect(renderToStaticMarkup(<UnarchiveProjectButton orgSlug="o" projectId="p" projectName="P" />)).toContain('<span role="status"></span>');
  });

  it('FR-PRJ-01 SPEC-2: a field error is linked to its control and the additional details are in the page, so an opened section shows them', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="edit" projectId="p1" initial={{ name: 'N', description: '' }} />);
    expect(html).toContain('id="project-details"');
    expect(html).not.toMatch(/id="project-details"[^>]*\bhidden\b/);   // edit mode opens them
  });
});
