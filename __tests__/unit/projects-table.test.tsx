import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '@/components/ui/Icon';
import { PROJECT_COPY } from '@/lib/project/copy';
import { PROJECT_WRITE_COPY } from '@/lib/project/write/copy';
import { TERM_PROJECT } from '@/lib/vocabulary/terms';

/**
 * Plan 1B Task 12: Projects (S-32) as one list, active and archived (spec 8; plan rule C8). The view renders from
 * loaded rows; the page's own reads, gates and paging are __tests__/integration/prj-stage-view.test.ts and
 * __tests__/integration/projects-for-findings.test.ts. Nothing here clicks or moves focus: e2e/prj-screens.spec.ts.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));

const { ProjectsTable } = await import('@/components/project/ProjectsTable');
const { PROJECTS_LIST_ID } = await import('@/components/project/projectsListId');

const C = PROJECT_COPY.allProjects;
type Row = { id: string; name: string; descriptiveLine: string; archived: boolean };
const row = (id: string, name: string, archived = false, descriptiveLine = ''): Row => ({ id, name, descriptiveLine, archived });

const render = (rows: Row[], over: { canUnarchive?: boolean; canCreate?: boolean; target?: 'project' | 'findings' } = {}) =>
  renderToStaticMarkup(
    <ProjectsTable orgSlug="o" rows={rows} canUnarchive={over.canUnarchive ?? false} canCreate={over.canCreate ?? false} target={over.target ?? 'project'} />,
  );

/** The project name of each body row (its row header's link), in document order. */
const rowHeaders = (html: string): string[] => [...html.matchAll(/<a class="projects-list__name"[^>]*>(.*?)<\/a>/g)].map((m) => m[1]);
/** The body rows' markup, in document order. */
const bodyRows = (html: string): string[] => [...(html.split('<tbody')[1] ?? '').matchAll(/<tr role="row">(.*?)<\/tr>/g)].map((m) => m[1]);

describe('Projects, one list (plan 1B Task 12)', () => {
  it('C8: active rows come first, then archived ones, each group in the order read (most recently changed first)', () => {
    const html = render([row('a1', 'Alpha'), row('x1', 'Shelved one', true), row('a2', 'Beta'), row('x2', 'Shelved two', true)]);
    expect(rowHeaders(html)).toEqual(['Alpha', 'Beta', 'Shelved one', 'Shelved two']);
  });

  it('is one table with a caption that names the list and its order, a row header per project, and no Active or Archived sub-list', () => {
    const html = render([row('a', 'Alive'), row('b', 'Shelved', true)]);
    expect(html.match(/<table\b/g)).toHaveLength(1);
    expect(html.match(/<caption\b/g)).toHaveLength(1);
    // with both groups on the page the caption is also the visible line that says the order (design review 14)
    expect(html).toMatch(new RegExp(`<caption [^>]*class="ui-table__caption">${C.caption}</caption>`));
    expect(html.match(/role="rowheader"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<ul\b|<h2\b/);
    // the list's region (the kit's scrollable wrapper, named by the caption) sits inside the element Unarchive focuses
    expect(html).toMatch(new RegExp(`<div id="${PROJECTS_LIST_ID}"[^>]*>.*<div class="ui-table-wrap" role="region" tabindex="0"`));
  });

  it('design review 14: with only one group on the page the caption names the table for assistive technology only', () => {
    for (const rows of [[row('a', 'Alive')], [row('b', 'Shelved', true)]]) {
      expect(render(rows)).toMatch(new RegExp(`<caption [^>]*class="ui-table__caption visually-hidden">${C.caption}</caption>`));
    }
  });

  it('each row is the item plate in its row header: the name as a link, then its descriptive line, then one line of state', () => {
    const html = render([row('a', 'Maternal risk triage', false, 'Classification, Health'), row('b', 'Bare')]);
    const [first, second] = bodyRows(html);
    expect(first).toContain('href="/orgs/o/projects/a"');
    const header = /<th role="rowheader"[^>]*>(.*?)<\/th>/.exec(first)?.[1] ?? '';
    expect(header.indexOf('Maternal risk triage')).toBeLessThan(header.indexOf('Classification, Health'));
    expect(header.indexOf('Classification, Health')).toBeLessThan(header.indexOf(`>${C.active}<`));
    expect(first).toMatch(/<p class="projects-list__line">Classification, Health<\/p>/);
    expect(second).not.toContain('projects-list__line');
    expect(second).toMatch(new RegExp(`<p class="projects-list__state">${C.active}</p>`));
  });

  it('design review 6 and 17: there is no State column; the state is the plate\'s line, Active, or Archived with the archive icon; no count, no score', () => {
    const archiveIcon = renderToStaticMarkup(<Icon name="archive" size={16} />);
    const html = render([row('a', 'Alive'), row('b', 'Shelved', true)], { canUnarchive: true });
    expect(html).not.toMatch(/>State<\/th>/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(2);   // Project, Actions
    const [alive, shelved] = bodyRows(html).map((r) => /<th role="rowheader"[^>]*>(.*?)<\/th>/.exec(r)?.[1] ?? '');
    expect(alive).toContain(`>${C.active}<`);
    expect(alive).not.toContain(archiveIcon);
    expect(shelved).toContain(`<p class="projects-list__state">${archiveIcon}${C.archived}</p>`);
    expect((alive + shelved).replace(/<[^>]+>/g, ' ')).not.toMatch(/\d|%|score|maturity|complet/i);   // the words read, not the markup
  });

  it('T12.1: Unarchive is on archived rows only and only with canUnarchive; without it there is no Actions column at all', () => {
    const rows = [row('a', 'Alive'), row('b', 'Shelved', true)];
    const owner = render(rows, { canUnarchive: true });
    const [alive, shelved] = bodyRows(owner);
    expect(alive).not.toContain(PROJECT_WRITE_COPY.unarchive.button);
    expect(shelved).toContain(`aria-label="${PROJECT_WRITE_COPY.unarchive.named('Shelved')}"`);
    expect(owner).toContain(`>${C.columns.actions}</th>`);
    const assessor = render(rows, { canUnarchive: false });
    expect(assessor).not.toContain(PROJECT_WRITE_COPY.unarchive.button);
    expect(assessor).not.toContain(`>${C.columns.actions}</th>`);
    expect(assessor.match(/role="columnheader"/g)).toHaveLength(1);
    // nothing archived: nothing to unarchive, so no column of empty cells either
    expect(render([row('a', 'Alive')], { canUnarchive: true })).not.toContain(`>${C.columns.actions}</th>`);
  });

  it('L2-65: with target findings every row links to its project\'s findings page and to no project page', () => {
    const html = render([row('a', 'Alive'), row('b', 'Shelved', true)], { target: 'findings' });
    expect(html).toContain('href="/orgs/o/projects/a/findings"');
    expect(html).toContain('href="/orgs/o/projects/b/findings"');
    expect(html).not.toMatch(/href="\/orgs\/o\/projects\/[ab]"/);
  });

  it('NFR-SEC-11: a hostile name and line render as text, never as markup', () => {
    const html = render([row('a', '<img src=x onerror=alert(1)>', true, '<script>alert(2)</script>')], { canUnarchive: true });
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('no project: no table, the empty state "No projects yet" with what a project is, then the creator\'s or the asker\'s sentence', () => {
    const creator = render([], { canCreate: true });
    expect(creator).not.toContain('<table');
    expect(creator).toContain(`<p class="ui-empty__title">${C.empty.title}</p>`);
    expect(C.empty.title).toBe('No projects yet');
    expect(creator).toContain(`${TERM_PROJECT.definition} ${C.empty.create}`);
    expect(C.empty.create).toBe('Create a project to start.');
    const viewer = render([], { canCreate: false });
    expect(viewer).toContain(`${TERM_PROJECT.definition} ${C.empty.ask}`);
    expect(C.empty.ask).toBe('Ask an Owner, Admin or Assessor to create your project.');
    expect(viewer).not.toContain(C.empty.create);
    // design review 20: a creator's one way on is the empty state's own New project button; an asker gets none
    expect(creator).toMatch(new RegExp(`<div class="ui-empty__action"><a [^>]*href="/orgs/o/projects/new"[^>]*>${C.newProject}</a></div>`));
    expect(viewer).not.toContain('ui-empty__action');
  });

  it('design review 19 (spec 9.7): a person who cannot unarchive is told once who can, only when an archived project is listed', () => {
    const line = `<p class="projects-list__note">${C.whoCanUnarchive}</p>`;
    expect(C.whoCanUnarchive).toBe('Owners and Admins can unarchive a project.');
    expect(render([row('a', 'Alive'), row('b', 'Shelved', true)]).split(line)).toHaveLength(2);
    expect(render([row('a', 'Alive')])).not.toContain(C.whoCanUnarchive);
    expect(render([row('a', 'Alive'), row('b', 'Shelved', true)], { canUnarchive: true })).not.toContain(C.whoCanUnarchive);
  });

  it('design review 16: the list holds one empty polite status line from the first render, for what Unarchive did', () => {
    const html = render([row('a', 'Alive'), row('b', 'Shelved', true)], { canUnarchive: true });
    expect(html).toMatch(new RegExp(`<div id="${PROJECTS_LIST_ID}"[^>]*><p role="status" class="projects-list__status"></p>`));
    expect(PROJECT_WRITE_COPY.unarchive.unarchived('Maize classifier')).toBe('Maize classifier is active again. Your team can change it.');
  });

  it('design review 15: the paging line counts what is shown and says when archived projects are not shown yet', () => {
    expect(C.showing(50, 63)).toBe('Showing 50 of 63 projects.');
    expect(C.archivedNotShown(1)).toBe('1 archived project is not shown yet. Archived projects come last.');
    expect(C.archivedNotShown(12)).toBe('12 archived projects are not shown yet. Archived projects come last.');
  });

  it('gap 2: the page is headed "Projects", and the archived banner names that page', () => {
    expect(C.heading).toBe('Projects');
    expect(PROJECT_COPY.archivedBanner).toContain('on the Projects page');
    expect(PROJECT_COPY.archivedBanner).not.toContain('All projects');
  });

  it('UX-37: the list uses ListLink and imports no next/link; Unarchive focuses the list by its id', () => {
    const src = readFileSync('components/project/ProjectsTable.tsx', 'utf8');
    expect(src).toMatch(/\bListLink\b/);
    expect(src).not.toMatch(/from 'next\/link'/);
    // one id, from a module with no 'use client' and no copy, so the client button and the server list share it
    expect(src).toMatch(/\bPROJECTS_LIST_ID\b/);
    expect(readFileSync('components/project/UnarchiveProjectButton.tsx', 'utf8')).toMatch(/import \{ PROJECTS_LIST_ID \} from '@\/components\/project\/projectsListId'/);
    expect(readFileSync('components/project/projectsListId.ts', 'utf8')).not.toMatch(/^['"]use client['"]|^import /m);
  });

  it('design review 16: a successful Unarchive writes its sentence into the list\'s status line, which outlives the refresh', () => {
    const src = readFileSync('components/project/UnarchiveProjectButton.tsx', 'utf8');
    expect(src).toMatch(/useProjectsListAnnounce\(\)/);
    expect(src.match(/say\(C\.unarchived\(/g)).toHaveLength(2);   // the 204, and the 409 that means another person did it
    // a 409 says "active again" only for not_archived: request_id_reused wrote nothing (silent-failure review F1)
    expect(src).toMatch(/if \(code === 'not_archived' && p\.projectName !== undefined\) say\(C\.unarchived\(/);
  });

  it('design review 16: the announce function exists inside the Projects list and is null outside it (no silent provider loss)', async () => {
    const { ProjectsListAnnouncer, useProjectsListAnnounce } = await import('@/components/project/ProjectsListAnnouncer');
    function Probe() { return <i>{useProjectsListAnnounce() === null ? 'none' : 'line'}</i>; }
    expect(renderToStaticMarkup(<ProjectsListAnnouncer><Probe /></ProjectsListAnnouncer>)).toContain('<i>line</i>');
    expect(renderToStaticMarkup(<Probe />)).toContain('<i>none</i>');
    // and the table, with its Unarchive controls, sits inside the provider
    const html = render([row('b', 'Shelved', true)], { canUnarchive: true });
    expect(html.indexOf('projects-list__status')).toBeLessThan(html.indexOf('<table'));
  });
});
