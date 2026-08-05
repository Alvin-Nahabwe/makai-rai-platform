import { describe, it, expect } from 'vitest';
import { resolveOrgDispatch } from '../../lib/org-dispatch';

/**
 * Pure decision core for app/page.tsx (Task 6, constraint 6): `/` reads
 * `lastActiveOrgId` as a HINT ONLY. Extracted so this logic is testable
 * without a session, cookies, Next.js `redirect()`, or a database — the
 * same shape this codebase already uses for `requireOrgContextFor`
 * (lib/auth/context.ts) and `resolveIdentity` (lib/auth/identity.ts).
 *
 * D-069 is the reason this exists at all: `users.lastActiveOrgId` is an
 * unconstrained, FK-less column that can name an org the user was removed
 * from. It must never be trusted on its own — only used to pick a redirect
 * target when it ALSO names one of the caller's own current, active
 * memberships (which is the only thing `requireOrgContext` at the
 * destination will accept anyway).
 */
describe('resolveOrgDispatch', () => {
  const orgA = { orgId: 'org-a', org: { slug: 'acme', name: 'Acme' } };
  const orgB = { orgId: 'org-b', org: { slug: 'beta', name: 'Beta Corp' } };

  it('redirects to the hinted org when the hint names a current membership', () => {
    const result = resolveOrgDispatch('org-b', [orgA, orgB]);
    expect(result).toEqual({ kind: 'redirect', slug: 'beta' });
  });

  it('falls back to the picker when there is no hint', () => {
    const result = resolveOrgDispatch(null, [orgA, orgB]);
    expect(result).toEqual({
      kind: 'picker',
      orgs: [
        { slug: 'acme', name: 'Acme' },
        { slug: 'beta', name: 'Beta Corp' },
      ],
    });
  });

  it('falls back to the picker when the hint names an org the caller is no longer a member of (D-069)', () => {
    // The exact trap D-069 records: lastActiveOrgId can survive a removal.
    // A stale hint must never grant a redirect the caller's real
    // memberships don't back.
    const result = resolveOrgDispatch('org-removed', [orgA, orgB]);
    expect(result.kind).toBe('picker');
  });

  it('falls back to an empty picker when the caller has no memberships at all', () => {
    const result = resolveOrgDispatch(null, []);
    expect(result).toEqual({ kind: 'picker', orgs: [] });
  });

  it('ignores the hint entirely if it happens to equal a membership id by coincidence but memberships is empty', () => {
    const result = resolveOrgDispatch('org-a', []);
    expect(result).toEqual({ kind: 'picker', orgs: [] });
  });
});
