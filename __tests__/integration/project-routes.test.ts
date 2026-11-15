import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGES } from '@/types/record';
import { stageView } from '@/lib/data/projects';
import { loadStagePage } from '@/lib/question/stagePage';
import { loadProjectRoutes } from '@/lib/project/routes';
import { eatDate } from '@/lib/followup/overdue';
import { resetDb } from '../helpers/db';
import { clearSession, sessionFor } from '../helpers/authSession';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addEvidence, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * Lane 4 Task A: the project page's per-question marks and its named no-decision questions (lib/project/routes.ts) agree
 * with the stage page's for the same stored data, and every read is the caller's organisation's (security obligations S1
 * and S4: a tenant-scoped read, and another organisation's project a 404 for the page as for its title).
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'x' }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/dashboard' }) }));

const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };
let fx: OrgFixture;
let other: OrgFixture;
let p: { id: string };

beforeEach(async () => {
  await resetDb();
  clearSession();
  const cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ label: 'routesA' });
  other = await buildOrg({ label: 'routesB' });
  p = await addProject(fx, { name: 'Routed project' });
  const pp = 'pre-processing' as const;
  const ev = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.org/e' });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done', evidenceIds: [ev.id] });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-04', contentVersionId: cv, status: 'partly' });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-07', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-07', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  await addDecision(fx, p.id, { stage: pp, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
  await addDecision(fx, p.id, { stage: 'in-processing', questionId: 'Q-IP-01', contentVersionId: cv, status: 'not_yet' });
  await addDecision(fx, p.id, { stage: 'post-processing', questionId: 'Q-PO-01', contentVersionId: cv, status: 'not_applicable' });
});

describe('loadProjectRoutes', () => {
  it('each stage\'s marks are the stage page\'s marks, in its order; the named questions are its no-decision rows; their count is the page\'s count', async () => {
    const ctx = ctxFor(fx, 'viewer');
    const routes = await loadProjectRoutes(ctx, { orgSlug: fx.org.slug, projectId: p.id });
    const counts = await stageView(ctx, p.id, eatDate(new Date()));
    for (const s of STAGES) {
      const page = await loadStagePage(ctx, fx.members.viewer.userId, p.id, s);
      expect(page, s).not.toBeNull();
      expect(routes[s].stops.map((x) => [x.id, x.kind]), s).toEqual(page!.rows.map((r) => [r.questionId, page!.marks[r.questionId]]));
      expect(routes[s].noDecision.map((q) => q.id), s).toEqual(page!.rows.filter((r) => r.kind === 'none').map((r) => r.questionId));
      expect(routes[s].noDecision, s).toHaveLength(counts[s].noDecision);
    }
    // Not vacuous: the stored decisions show.
    expect(routes['pre-processing'].stops.find((x) => x.id === 'Q-PP-13')?.kind).toBe('does_not_apply');
    expect(routes['in-processing'].stops.find((x) => x.id === 'Q-IP-01')?.kind).toBe('not_yet');
  });

  it('S1: the reads are the caller\'s organisation\'s: under another organisation\'s context the same project shows no decision at all', async () => {
    const routes = await loadProjectRoutes(ctxFor(other, 'owner'), { orgSlug: other.org.slug, projectId: p.id });
    for (const s of STAGES) expect(new Set(routes[s].stops.map((x) => x.kind)), s).toEqual(new Set(['no_decision']));
  });

  it('S4: the page renders its lines for a member, and another organisation\'s member gets a 404 before any read of the project', async () => {
    const { default: Page } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/page');
    sessionFor(fx.members.owner.userId);
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ slug: fx.org.slug, id: p.id }) }) as ReactElement);
    expect(html.match(/<section class="stage-line"/g)).toHaveLength(3);
    expect(html).toContain('data-tally-kind="partly"');
    clearSession();
    sessionFor(other.members.owner.userId);
    await expect(Page({ params: Promise.resolve({ slug: other.org.slug, id: p.id }) })).rejects.toMatchObject(NOT_FOUND);
  });
});
