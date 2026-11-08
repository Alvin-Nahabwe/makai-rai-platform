import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';

/**
 * FR-RM-03: each route and page the score removal deletes answers 404 for
 * every HTTP method it used to accept. A deleted route file answers 404 for
 * every method; an emptied one would answer 405 (Next 16 answers 405 for a
 * method a surviving route file does not export), which is why the lint test
 * `__tests__/lint/removed-score-routes.test.ts` also requires the files to be
 * absent.
 *
 * Signed in as the owner of the first fixture organisation (a seat of
 * e2e/fixtures/.auth/manifest.json, written by the setup project): an owner
 * held every one of these actions, so a 401 or 403 here would mean the route
 * is still there and refusing, not gone.
 */

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const org = manifest.orgs[0];
const owner = manifest.users.find((u) => u.orgSlug === org.slug && u.role === 'owner' && u.index === 0);
if (!owner) throw new Error(`removed-routes: no owner seat for ${org.slug} in the fixture manifest`);

test.use({ storageState: owner.storageStatePath });

type Method = 'GET' | 'POST' | 'PATCH';

// Methods are those of lib/authz/routeActions.ts (v0.5.0 lines 29-43) and the
// page routes.
const CASES: Array<[string, Method[]]> = [
  ['/api/v1/orgs/{slug}/assessments', ['GET', 'POST']],
  ['/api/v1/orgs/{slug}/assessments/{id}', ['GET', 'PATCH']],
  ['/api/v1/orgs/{slug}/assessments/{id}/complete', ['POST']],
  ['/api/v1/orgs/{slug}/assessments/{id}/remediation', ['GET', 'PATCH']],
  ['/api/v1/orgs/{slug}/assessments/{id}/evidence', ['GET', 'POST']],
  ['/api/v1/orgs/{slug}/reports/{id}/pdf', ['GET']],
  ['/orgs/{slug}/assessment/{id}/report', ['GET']],
  ['/orgs/{slug}/projects/{projectId}/compare', ['GET']],
  ['/orgs/{slug}/assessment/{id}', ['GET']],
];

test('FR-RM-03: every removed path answers 404 for every method it accepted', async ({ request, baseURL }) => {
  // A real project of the seat's organisation, so the 404 comes from the
  // missing route and not from a missing row behind a surviving route.
  const created = await request.post(`/api/v1/orgs/${org.slug}/projects`, {
    headers: { origin: baseURL ?? '' },
    data: { requestId: randomUUID(), name: `Removed-route probe ${Date.now()}`, aiSystemType: 'classification' },
  });
  expect(created.status(), 'creating the probe project').toBe(201);
  const projectId = (await created.json()).id as string;

  const id = randomUUID();
  const fill = (p: string) =>
    p.replace('{slug}', org.slug).replace('{projectId}', projectId).replace('{id}', id);

  for (const [path, methods] of CASES) {
    for (const m of methods) {
      const r = await request.fetch(fill(path), {
        method: m,
        headers: m === 'GET' ? undefined : { origin: baseURL ?? '' },
        data: m === 'GET' ? undefined : {},
      });
      expect(r.status(), `${m} ${path}`).toBe(404);
    }
  }
});
