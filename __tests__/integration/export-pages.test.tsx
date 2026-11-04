import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearSession, sessionFor } from '../helpers/authSession';
import { resetDb } from '../helpers/db';
import { addEvidence, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import * as exportData from '../../lib/data/export';
import { REFUSED_TEXT } from '../../components/export/TeamExportPanel';

/**
 * S-20's two pages (`/orgs/[slug]/export`, `/orgs/[slug]/projects/[id]/export`; FR-EXP-01, owner question B4,
 * NFR-SEC-02 / obligation E14), rendered as the server renders them, with a mocked session.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/export' }) }));

const orgModule = await import('../../app/(authenticated)/orgs/[slug]/export/page');
const projectModule = await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/export/page');
const OrgExportPage = orgModule.default;
const ProjectExportPage = projectModule.default;

let fxA: OrgFixture;
let projectOfA: string;
let archivedOfA: string;
let projectOfB: string;

beforeAll(async () => {
  await resetDb();
  fxA = await buildOrg({ label: 'pgA' });
  projectOfA = (await addProject(fxA, { name: 'Maternal-risk triage' })).id;
  archivedOfA = (await addProject(fxA, { name: 'Old pilot', archived: true })).id;
  await addEvidence(fxA, projectOfA, { kind: 'file', bytes: Buffer.alloc(2_400_000, 1) });
  projectOfB = (await addProject(await buildOrg({ label: 'pgB' }), { name: 'Secret of B' })).id;
});
beforeEach(() => {
  clearSession();
  sessionFor(fxA.members.owner.userId);
  vi.restoreAllMocks();
});

const orgPage = async (refused?: string) => renderToStaticMarkup(await OrgExportPage({
  params: Promise.resolve({ slug: fxA.org.slug }), searchParams: Promise.resolve(refused === undefined ? {} : { refused }),
}));
const projectPage = async (id: string) => renderToStaticMarkup(await ProjectExportPage({
  params: Promise.resolve({ slug: fxA.org.slug, id }), searchParams: Promise.resolve({}),
}));

describe('S-20', () => {
  it('NFR-SEC-02: the S-20 project export page for a project of organisation B is not found', async () => {
    const spy = vi.spyOn(exportData, 'estimateTeamExport');
    await expect(ProjectExportPage({ params: Promise.resolve({ slug: fxA.org.slug, id: projectOfB }), searchParams: Promise.resolve({}) }))
      .rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('FR-EXP-01 (owner question B4, contract row 20): S-20 renders the refusal text for ?refused=export_busy and ?refused=rate_limited, and none for another value', async () => {
    expect(await orgPage('export_busy')).toContain(REFUSED_TEXT.export_busy);
    expect(await orgPage('rate_limited')).toContain(REFUSED_TEXT.rate_limited);
    for (const other of [undefined, '<script>', 'nope']) {
      const html = await orgPage(other);
      expect(html).not.toContain(REFUSED_TEXT.export_busy);
      expect(html).not.toContain(REFUSED_TEXT.rate_limited);
      expect(html).toMatch(/>Download export<\/a>/);
    }
  });

  it('M-37 FR-EXP-01: the organisation page names the organisation, its size, and links to route 20 for the whole organisation', async () => {
    const html = await orgPage();
    expect(html).toContain(`Export ${fxA.org.name}: about 2.4 MB as one ZIP file.`);
    expect(html).toContain(`href="/api/v1/orgs/${fxA.org.slug}/export"`);
    expect(html).toMatch(/<h1[^>]*>Team export<\/h1>/);
  });

  it('M-37 FR-EXP-01: the project page names the project and links to route 20 for that project', async () => {
    const html = await projectPage(projectOfA);
    expect(html).toContain('Export Maternal-risk triage: about 2.4 MB as one ZIP file.');
    expect(html).toContain(`href="/api/v1/orgs/${fxA.org.slug}/export?projectId=${projectOfA}"`);
  });

  it('UX-31: the project export page shows the archived banner for an archived project, and still offers the export', async () => {
    const html = await projectPage(archivedOfA);
    expect(html).toContain('This project is archived. Nothing in it can be changed.');
    expect(html).toMatch(/>Download export<\/a>/);
    expect(await projectPage(projectOfA)).not.toContain('This project is archived.');
  });

  it('FR-EXP-01 FR-AUTHZ-01: assessor, reviewer and viewer get no S-20 page', async () => {
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      await expect(orgPage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
      await expect(projectPage(projectOfA)).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    }
    sessionFor(fxA.members.admin.userId);
    expect(await orgPage()).toMatch(/>Download export<\/a>/);
  });

  it('NFR-A11Y-02 (WCAG 2.4.2): both S-20 pages carry their own title', () => {
    expect(orgModule.metadata).toEqual({ title: 'Team export - MAK-AI RAI Platform' });
    expect(projectModule.metadata).toEqual({ title: 'Team export - MAK-AI RAI Platform' });
  });

  it('FR-EXP-01: estimateTeamExport sums held evidence files and issued PDFs of the scope', async () => {
    const ctx = { orgId: fxA.org.id, role: 'owner' } as Parameters<typeof exportData.estimateTeamExport>[0];
    expect(await exportData.estimateTeamExport(ctx, projectOfA)).toBe(2_400_000);
    expect(await exportData.estimateTeamExport(ctx, archivedOfA)).toBe(0);
    expect(await exportData.estimateTeamExport(ctx, null)).toBe(2_400_000);
  });
});
