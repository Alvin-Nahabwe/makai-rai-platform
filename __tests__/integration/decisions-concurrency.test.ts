import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import type { SaveDecisionRequest } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import { saveDecision } from '@/lib/data/decisions';
import { POST as SAVE_POST } from '@/app/api/v1/orgs/[slug]/projects/[id]/decisions/route';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { clearSession, sessionFor } from '../helpers/authSession';
import { addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

// Concurrent route calls need the identity step queued (the vitest limitation is stated at queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
  clearSession();
});

const actor = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
const body = (over: Partial<SaveDecisionRequest> = {}): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Fixture reason', decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...over,
});
const save = (role: OrgRole, b: SaveDecisionRequest) =>
  saveDecision(ctxFor(fx, role), actor(role), { ...b, projectId: project.id }, requestDigest({ path: { id: project.id }, body: b }));
const post = (role: OrgRole, b: SaveDecisionRequest) => {
  sessionFor(fx.members[role].userId);
  return SAVE_POST(new NextRequest(`http://localhost/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`,
    { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: fx.org.slug, id: project.id }) });
};
const countVersions = () => testDb.decisionVersion.count({ where: { projectId: project.id } });
const versionNumbers = async () => (await testDb.decisionVersion.findMany({
  where: { projectId: project.id, questionId: 'Q-PP-01' }, select: { versionNumber: true }, orderBy: { versionNumber: 'asc' },
})).map((v) => v.versionNumber);

describe('decision saves under concurrency (NFR-INT-02, NFR-INT-03)', () => {
  it('NFR-INT-03: of 20 concurrent saves based on version 1, one makes version 2 and 19 answer 409 with version 2', async () => {
    await save('assessor', body());
    const outs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => save('assessor', body({ baseVersionNumber: 1, reason: `Concurrent ${i}` }))));
    const rejected = outs.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(outs.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(rejected.map((r) => [r.reason.code, r.reason.extra?.current?.versionNumber])).toEqual(Array.from({ length: 19 }, () => ['base_version_moved', 2]));
    expect(await versionNumbers()).toEqual([1, 2]);
  });

  it('NFR-INT-02: 20 concurrent copies of one save create one version and 20 2xx answers with one version number', async () => {
    const b = body();
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('assessor', b)));
    expect(rs.map((r) => r.status).filter((s) => s !== 200 && s !== 201)).toEqual([]);
    expect(new Set(await Promise.all(rs.map(async (r) => (await r.json()).versionNumber)))).toEqual(new Set([1]));
    expect(await countVersions()).toBe(1);
  });
});
