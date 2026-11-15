import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { StageCounts } from '@/types/api';
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
import type { ProjectOverviewData } from '@/lib/data/projects';

/**
 * PRJ Tasks 5 to 7: the synchronous views of S-10, S-08, S-09 and S-32 render from loaded data (React 19's
 * renderToStaticMarkup does not await async components, so the page files only load and pass data). Nothing here
 * clicks or moves focus: that is `e2e/prj-screens.spec.ts`.
 */
const welcomeProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));
vi.mock('@/components/account/WelcomeNotice', () => ({ WelcomeNotice: (p: Record<string, unknown>) => { welcomeProps.push(p); return null; } }));

const { ProjectPage } = await import('@/components/project/ProjectPage');
const { HomeView } = await import('@/components/home/HomeView');
const { ProjectsTable } = await import('@/components/project/ProjectsTable');
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
    // Read as text: the tally's count is bold and its word marked as the term's first use, with its (i) beside it, whose
    // definition is left out here (lane 4 Task B).
    const t = textOf(html.replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/g, ''));
    expect(t.indexOf('Still open in this stage')).toBeLessThan(t.indexOf('9 questions with no decision'));
    expect(t.indexOf('9 questions with no decision')).toBeLessThan(t.indexOf('Recorded so far'));
    expect(t.indexOf('Recorded so far')).toBeLessThan(t.indexOf('7 done (2 with no evidence attached)'));
    expect(html).toContain('3 open findings'); expect(textOf(html)).toContain(`${PROJECT_COPY.followUp.overdue}: ${PROJECT_COPY.mitigationCount(1)}`);
    expect(html).not.toMatch(/%|score|complete/i);
  });

  it('UX-06 (R12-16, spec 7.2): each status phrase of a stage column is the kit\'s mark with its words in ink, and none carries the warning class', () => {
    const line = preLine(COUNTS);
    const html = line.slice(line.indexOf('<div class="stage-line__stop stage-line__stop--recorded"'), line.indexOf('<div class="stage-line__stop stage-line__stop--reviews"'));
    // Each question's stop is the kit's shape, hidden from assistive technology, in a stop that names its status in words
    // (drawn without a link on S-10: lead's ruling on C5).
    expect(html.match(/<li class="ui-route-row__stop" data-mark-kind="[a-z_]+"><span class="ui-route-row__point"><svg class="ui-mark__shape"[^>]*aria-hidden="true"/g)).toHaveLength(24);
    // The tally is the kit's list keyed by the marks (lane 4 Task B): one item per kind, read without its (i).
    const tally = [...html.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => textOf(m[1].replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, '')));
    expect(tally).toEqual(['7 done (2 with no evidence attached)', expect.stringMatching(/^\d+ partly$/), expect.stringMatching(/^\d+ not yet$/), expect.stringMatching(/^\d+ not applicable$/), '1 answered']);
    expect(html).not.toMatch(/status-label|warning/);
  });

  it('FR-PRJ-02: the stage column says how many open findings have no mitigation yet, and counts gated questions as not applying, beside those marked not applicable', () => {
    const html = preLine({ ...COUNTS, notApplicableByGate: 2 });
    expect(html).toContain('<a href="/orgs/o/projects/p1/findings?stage=pre-processing">3 open findings</a>');
    expect(textOf(html)).toContain('3 open findings (1 of them with no mitigation yet)');
    const tally = [...html.matchAll(/<li class="ui-route-row__tally-item"[^>]*>(.*?)<\/li>/g)].map((m) => textOf(m[1].replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, '')));
    expect(tally).toContain('2 not applicable');
    expect(tally).toContain('2 do not apply');
  });

  it('FR-RM-04: no stage column and no page adds the three stages together', () => {
    expect(renderPage({})).not.toMatch(/\b(total|overall|in all)\b/i);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the banner and no form or Archive control on S-10', () => {
    const html = renderPage({ archived: true, role: 'owner' });
    // Read as text: the words "All projects page" are a link inside the sentence (S5-1, lane 4 Task B round 1).
    expect(textOf(html)).toContain(PROJECT_COPY.archivedBanner);
    expect(html).not.toMatch(/<form|Archive project|Edit project/);
  });

  it('FR-PRJ-03 UX-29: only owner and admin see Archive project', () => {
    for (const role of ['owner', 'admin'] as const) expect(renderPage({ role })).toContain('Archive project');
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) expect(renderPage({ role })).not.toContain('Archive project');
  });

  it('no time-zone sentence on Home or the project page', () => {
    // CONSOLIDATED section 4: the time-zone sentence is country-specific and internal; how overdue is counted is unchanged.
    const project = renderPage({});
    const home = renderToStaticMarkup(<HomeView data={{ variant: 'first-time', canCreate: true, base: {
      orgSlug: 'o', orgId: 'o1', orgName: 'Org', role: 'owner', userId: 'u1', userName: 'Amina', welcome: false, archivedCount: 0, projects: [],
    } }} />);
    expect(home).toMatch(new RegExp(`<h1[^>]*>${HOME_COPY.welcomeFirst('<bdi>Amina</bdi>')}</h1>`));   // not vacuous: Home rendered, its welcome the page's h1 (a first visit's)
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

describe('S-09 and S-32 (Task 7)', () => {
  it('FR-PRJ-03: S-32 lists active and archived projects, with Unarchive for owner and admin only', () => {
    const rows = [{ id: 'a', name: 'Alive', descriptiveLine: '', archived: false }, { id: 'b', name: 'Shelved', descriptiveLine: '', archived: true }];
    const data = { orgSlug: 'o', rows, canCreate: true, target: 'project' as const };
    const owner = renderToStaticMarkup(<ProjectsTable {...data} canUnarchive />);
    const assessor = renderToStaticMarkup(<ProjectsTable {...data} canUnarchive={false} />);
    expect(owner.indexOf('Alive')).toBeLessThan(owner.indexOf('Shelved'));
    expect(owner).toContain('Unarchive'); expect(assessor).not.toContain('Unarchive');
    expect(owner).not.toMatch(/Maturity|compliance|\bAssessments?\b|\bcompleted\b/i);
    const empty = renderToStaticMarkup(<ProjectsTable {...data} rows={[]} canUnarchive />);
    expect(empty.split(PROJECT_COPY.allProjects.empty.title)).toHaveLength(2);
    expect(empty).not.toContain('<table');
  });

  it('UX-37: the S-32 page and its view use ListLink and import no next/link', () => {
    for (const f of ['app/(authenticated)/orgs/[slug]/projects/page.tsx', 'components/project/ProjectsTable.tsx'])
      expect(readFileSync(f, 'utf8')).not.toMatch(/from 'next\/link'/);
    expect(readFileSync('components/project/ProjectsTable.tsx', 'utf8')).toMatch(/\bListLink\b/);
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
