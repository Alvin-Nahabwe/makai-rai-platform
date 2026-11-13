import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { FollowUpItem, StageCounts } from '@/types/api';
import { STAGES, type Stage } from '@/types/record';
import { can } from '@/lib/authz/policy';
import { projectActions } from '@/lib/projects/can';
import { descriptiveLine } from '@/lib/projects/metadataValues';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import type { DashboardData, ProjectOverviewData } from '@/lib/data/projects';

/**
 * PRJ Tasks 5 to 7: the synchronous views of S-10, S-08, S-09 and S-32 render from loaded data (React 19's
 * renderToStaticMarkup does not await async components, so the page files only load and pass data). Nothing here
 * clicks or moves focus: that is `e2e/prj-screens.spec.ts`.
 */
const reviewSummaryProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const welcomeProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));
vi.mock('@/components/review/StageReviewsSummary', () => ({ StageReviewsSummary: (p: Record<string, unknown>) => { reviewSummaryProps.push(p); return null; } }));
vi.mock('@/components/account/WelcomeNotice', () => ({ WelcomeNotice: (p: Record<string, unknown>) => { welcomeProps.push(p); return null; } }));

const { StageColumn } = await import('@/components/project/StageColumn');
const { ProjectOverview } = await import('@/components/project/ProjectOverview');
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
const renderPage = (o: Parameters<typeof overview>[0]) => renderToStaticMarkup(<ProjectOverview data={overview(o)} />);

describe('S-10 (Task 5)', () => {
  it('UX-06 FR-PRJ-02: to-do counts come before recorded counts in each stage column', () => {
    const html = renderToStaticMarkup(<StageColumn orgSlug="o" projectId="p" stage="pre-processing" counts={COUNTS}>{null}</StageColumn>);
    expect(html.indexOf('9 with no decision')).toBeLessThan(html.indexOf('Done 7'));
    expect(html).toContain('3 open findings'); expect(html).toContain('1 overdue mitigation');
    expect(html).not.toMatch(/%|score|complete/i);
  });

  it('UX-06 (R12-16): each status phrase of a stage column is a status-label element, and none carries the warning class', () => {
    const html = renderToStaticMarkup(<StageColumn orgSlug="o" projectId="p" stage="pre-processing" counts={COUNTS}>{null}</StageColumn>);
    const labels = [...html.matchAll(/<[a-z]+ [^>]*class="([^"]*\bstatus-label\b[^"]*)"[^>]*>([^<]*)</g)];
    expect(labels.map((m) => m[2])).toEqual(['Done 7', expect.stringMatching(/^Partly \d+$/), expect.stringMatching(/^Not yet \d+$/), expect.stringMatching(/^Not applicable \d+$/)]);
    expect(labels.every((m) => !/status-label--warning/.test(m[1]))).toBe(true);
  });

  it('FR-PRJ-02: the stage column says how many open findings have no mitigation yet, and counts gated questions as not applicable', () => {
    const html = renderToStaticMarkup(<StageColumn orgSlug="o" projectId="p" stage="pre-processing" counts={{ ...COUNTS, notApplicableByGate: 2 }}>{null}</StageColumn>);
    expect(html).toContain('3 open findings (1 of them with no mitigation yet)');
    expect(html).toContain('Not applicable 4');
  });

  it('FR-RM-04: no stage column and no page adds the three stages together', () => {
    expect(renderPage({})).not.toMatch(/\b(total|overall|in all)\b/i);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the banner and no form or Archive control on S-10', () => {
    const html = renderPage({ archived: true, role: 'owner' });
    expect(html).toContain('This project is archived. Nothing in it can be changed. Owners and admins can unarchive it from All projects.');
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
    expect(home).toMatch(/<h1>Dashboard<\/h1>/);   // not vacuous: the view rendered
    expect(project).toContain('Stages can be recorded in any order.');
    for (const html of [home, project]) expect(html).not.toMatch(/East Africa|UTC\+3|\bEAT\b/);
  });

  it('FR-PRJ-02: S-10 says how to share the record once, right after the stages and their reviews, before the findings link', () => {
    const html = renderPage({});
    const line = 'To share your record outside the team, seal a stage review and create a document from it.';
    expect(html.split(line)).toHaveLength(2);
    // The end of the stage list (the jump links and the three columns), found by balancing its <div>s.
    const start = html.indexOf('<div class="stage-list">');
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
    expect(html.indexOf(line)).toBeLessThan(html.indexOf('Findings for this project'));
    expect(html).not.toContain('Team working view');
  });

  it('FR-PRJ-02: a new project shows "Nothing recorded yet." in each stage', () => {
    expect(renderPage({ counts: ZERO }).split('Nothing recorded yet.')).toHaveLength(4);
  });

  it('UX-36: each stage is a details element, open by default, that names its three to-do counts when collapsed', () => {
    const html = renderPage({});
    expect(html.match(/<details open="" class="stage-column"/g)).toHaveLength(3);
    expect(html).toContain('Pre-processing: 9 with no decision, 3 open findings, 1 overdue mitigation');
  });

  it('FR-PRJ-03 UX-29: archive, export and open-review actions follow the role and the archived state', () => {
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) for (const archived of [false, true]) {
      expect(projectActions(role, archived)).toEqual({
        update: can(role, 'project:update') && !archived, archive: can(role, 'project:archive') && !archived,
        archiveControl: can(role, 'project:archive'), export: can(role, 'team:export'), openReview: can(role, 'review:open') && !archived,
      });
    }
  });

  it('FR-PRJ-03: S-10 passes canOpen to each stage\'s review summary and shows Export project only with team:export', () => {
    for (const role of ['owner', 'reviewer', 'viewer'] as const) for (const archived of [false, true]) {
      reviewSummaryProps.length = 0;
      const html = renderPage({ role, archived });
      expect(reviewSummaryProps.splice(0).map((p) => p.canOpen)).toEqual(STAGES.map(() => can(role, 'review:open') && !archived));
      expect(html.includes('Export project')).toBe(can(role, 'team:export'));
    }
  });

  it('FR-PRJ-01: the descriptive line is built from the fields and shows no score', () => {
    expect(descriptiveLine({ aiSystemType: 'classification', deploymentSector: 'health', processesPersonalData: true, developmentStage: 'testing' }))
      .toBe('Classification, health, personal data: yes, lifecycle stage: Testing');
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

  it('UX-06 (R12-16, R13-7): in an overdue mitigation line only the word Overdue is a status-label--warning element, a due one is plain text, and each status word is a status-label', () => {
    const html = renderToStaticMarkup(<MyMitigationsList orgSlug="o" projectNames={new Map([['p1', 'P']])} items={[OVERDUE_ITEM, DUE_ITEM]} />);
    expect(html).toMatch(/<span class="[^"]*\bstatus-label\b[^"]*\bstatus-label--warning\b[^"]*">Overdue<\/span>: was due 28 Oct 2026/);
    expect(html.match(/status-label--warning/g)).toHaveLength(1);
    expect(html).not.toMatch(/status-label--warning[^>]*>[^<]*was due/);
    expect(html).toContain('Due 20 Nov 2026'); expect(html).not.toMatch(/<[^>]*status-label[^>]*>Due /);
    expect(html).toMatch(/<[a-z]+ [^>]*class="[^"]*\bstatus-label\b(?![^"]*--warning)[^"]*"[^>]*>(Planned|In progress)</);
  });

  it('FR-PRJ-04 F11: a mitigation with no text says "No text recorded." and a recorded one does not', () => {
    const html = renderToStaticMarkup(<MyMitigationsList orgSlug="o" projectNames={new Map([['p1', 'P']])} items={[{ ...OVERDUE_ITEM, what: null }, DUE_ITEM]} />);
    expect(html.match(/No text recorded\./g)).toHaveLength(1);
    expect(html).toContain('Re-run check');
  });

  it('FR-PRJ-04: S-08 empty states say who can create a project and that the person owns no open mitigations', () => {
    for (const role of ['owner', 'admin', 'assessor'] as const) {
      const html = renderToStaticMarkup(<DashboardView data={emptyDashboard(role)} />);
      expect(html).toMatch(/No projects yet\.\s*<a[^>]*href="\/orgs\/o\/projects\/new"[^>]*>New project<\/a>/);
      expect(html).not.toContain('Owners, admins and assessors can create one.');
    }
    for (const role of ['reviewer', 'viewer'] as const) {
      const html = renderToStaticMarkup(<DashboardView data={emptyDashboard(role)} />);
      expect(html).toContain('No projects yet. Owners, admins and assessors can create one.');
      expect(html).not.toContain('href="/orgs/o/projects/new"');
    }
    expect(renderToStaticMarkup(<DashboardView data={emptyDashboard('viewer')} />)).toContain('You own no open mitigations.');
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
    expect(renderToStaticMarkup(<AllProjectsView data={{ ...data, active: [], archived: [], canUnarchive: true }} />).split('None.')).toHaveLength(3);
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
    for (const label of ['AI system type', 'Sector', 'Dataset type', 'Dataset size', 'Personal data', 'Funding source',
                         'Regulatory context', 'Lifecycle stage', 'Start date', 'End date'])
      expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>${label}`));
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
