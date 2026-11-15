import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@/lib/data/tenant';
import type { Identity } from '@/lib/auth/identity';

/**
 * lib/shell/project.ts without a database (S2, S3): which calls the loader makes and in what order, and that it turns only
 * NotFoundError into "no block". Any other error propagates (no fail-open catch), so a fault surfaces as the page's error,
 * never as a quiet rail with no block. The database-backed cases are __tests__/integration/shell-project.test.ts.
 */
const m = vi.hoisted(() => ({
  identityPassesGates: vi.fn(),
  requireOrgContextFor: vi.fn(),
  withOrg: vi.fn(),
}));
vi.mock('@/lib/auth/identity', () => ({ identityPassesGates: m.identityPassesGates }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: m.requireOrgContextFor }));
vi.mock('@/lib/data/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/tenant')>()), withOrg: m.withOrg,
}));

import { loadShellProject } from '@/lib/shell/project';
import { stageParam } from '@/lib/shell/nav';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const identity: Identity = { userId: 'u1', email: 'u1@x.test', name: 'U', platformRole: 'assessor', mustChangePassword: false };

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.identityPassesGates.mockResolvedValue(true);
  m.requireOrgContextFor.mockResolvedValue({ orgId: 'o1', role: 'viewer' });
  m.withOrg.mockResolvedValue(null);
});

describe('loadShellProject: the gates, in the project page\'s order', () => {
  it('S2: the identity the page\'s requireIdentity gave, then requireOrgContextFor(userId, slug, "project:read"), then the tenant read', async () => {
    expect(await loadShellProject(identity, { slug: 'a', id: ID })).toBeNull();
    expect(m.identityPassesGates).toHaveBeenCalledWith(identity);
    expect(m.requireOrgContextFor).toHaveBeenCalledWith('u1', 'a', 'project:read');
    expect(m.withOrg).toHaveBeenCalledTimes(1);
    expect(m.withOrg.mock.calls[0][0]).toEqual({ orgId: 'o1', role: 'viewer' });
  });

  it('S2: a malformed id reads nothing at all', async () => {
    for (const id of ['new', 'x', '', `${ID}/`]) expect(await loadShellProject(identity, { slug: 'a', id })).toBeNull();
    expect(m.requireOrgContextFor).not.toHaveBeenCalled();
    expect(m.withOrg).not.toHaveBeenCalled();
  });

  it('S3: a person held at a gate gets no block, and no organisation is read for them', async () => {
    m.identityPassesGates.mockResolvedValue(false);
    expect(await loadShellProject(identity, { slug: 'a', id: ID })).toBeNull();
    expect(m.requireOrgContextFor).not.toHaveBeenCalled();
    expect(m.withOrg).not.toHaveBeenCalled();
  });

  it('S2: NotFoundError from the membership gate (unknown slug, not a member) is no block', async () => {
    m.requireOrgContextFor.mockRejectedValue(new NotFoundError());
    expect(await loadShellProject(identity, { slug: 'a', id: ID })).toBeNull();
    expect(m.withOrg).not.toHaveBeenCalled();
  });

  it('S2: any other error propagates: ForbiddenError, a database error, a failure inside the tenant read', async () => {
    m.requireOrgContextFor.mockRejectedValueOnce(new ForbiddenError('project:read', 'viewer'));
    await expect(loadShellProject(identity, { slug: 'a', id: ID })).rejects.toBeInstanceOf(ForbiddenError);
    m.requireOrgContextFor.mockRejectedValueOnce(new Error('connection refused'));
    await expect(loadShellProject(identity, { slug: 'a', id: ID })).rejects.toThrow('connection refused');
    m.withOrg.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(loadShellProject(identity, { slug: 'a', id: ID })).rejects.toThrow('statement timeout');
    m.identityPassesGates.mockRejectedValueOnce(new Error('acceptances unreadable'));
    await expect(loadShellProject(identity, { slug: 'a', id: ID })).rejects.toThrow('acceptances unreadable');
  });
});

describe('stageParam: the stage a project page\'s [stage] param names', () => {
  it('names one of the three stages, and nothing else', () => {
    expect(stageParam(undefined)).toBeNull();
    for (const stage of ['pre-processing', 'in-processing', 'post-processing'] as const) expect(stageParam(stage)).toBe(stage);
    for (const bad of ['', 'nope', '__proto__', 'toString', 'Pre-processing', 'pre-processing/']) expect(stageParam(bad), bad).toBeNull();
  });
});
