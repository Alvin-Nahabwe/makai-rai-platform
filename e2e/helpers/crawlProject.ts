import { expect, type APIRequestContext } from '@playwright/test';

/**
 * The crawl's OWN project, made through the existing APIs before anything is crawled (never through the browser): a
 * decision on Q-PP-01 (S-12 links its history, S-13), a team finding (S-15) and an opened and sealed stage review (S-16,
 * S-17). Moved from e2e/claims-crawl.spec.ts unchanged apart from the parameters (plan 1A Task 9, fix round 1);
 * e2e/vocabulary-first-use.spec.ts seeds its own the same way. `api` posts as an owner of `slug`; only its `post` is
 * used, so a caller under the loopback guard (e2e/helpers/loopbackOnly.ts) can pass one that sends absolute URLs with
 * `maxRedirects: 0`.
 */
export async function seedCrawlProject(api: Pick<APIRequestContext, 'post'>, baseURL: string | undefined, slug: string, name: string): Promise<{ id: string }> {
  const seed = async (path: string, data: Record<string, unknown>, what: string): Promise<{ id: string }> => {
    const response = await api.post(path, { headers: { origin: baseURL ?? '' }, data: { requestId: crypto.randomUUID(), ...data } });
    expect(response.status(), `seeding ${what}`).toBe(201);
    return (await response.json()) as { id: string };
  };
  const crawlProject = await seed(`/api/v1/orgs/${slug}/projects`, { name, aiSystemType: 'classification' }, 'the crawl project');
  const projectApi = `/api/v1/orgs/${slug}/projects/${crawlProject.id}`;
  await seed(`${projectApi}/decisions`, {
    stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null,
    reason: 'Crawl fixture reason for this decision.', decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
  }, 'the crawl project\'s decision');
  await seed(`${projectApi}/findings`, {
    stage: 'pre-processing', title: 'Crawl fixture finding', description: 'Raised so the crawl has a finding to open.', riskArea: null, questionId: null, decisionVersionId: null,
  }, 'the crawl project\'s finding');
  const review = await seed(`${projectApi}/reviews`, { stage: 'pre-processing', preparedFor: null }, 'the crawl project\'s stage review');
  await seed(`${projectApi}/reviews/${review.id}/seals`, {}, 'the crawl project\'s seal');
  return crawlProject;
}

/** Every link into a project goes to the crawl's own project: the pages of any other project are not followed. */
export function ownProject(pathname: string, crawlProject: { id: string }): boolean {
  const m = /^\/orgs\/[^/]+\/projects\/([^/]+)/.exec(pathname);
  return m === null || m[1] === 'new' || m[1] === crawlProject.id;
}
