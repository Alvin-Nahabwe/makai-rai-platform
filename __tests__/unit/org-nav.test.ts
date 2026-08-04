import { describe, it, expect } from 'vitest';
import { currentOrgSlug, resolveOrgHref, isNavActive } from '../../lib/org-nav';

/**
 * Pure-logic extraction from Sidebar.tsx (constraint 4 of the Task 6 brief:
 * "pathname.startsWith(item.href) breaks once paths gain a prefix — fix
 * it"). Tested here, without React/DOM, rather than as a component test —
 * this project has no React Testing Library / jsdom setup (vitest.config.ts
 * runs `environment: 'node'`, and no __tests__ file renders a component
 * anywhere), so adding one would be new test infrastructure outside this
 * task's scope. Extracting the href/active-state logic into pure functions
 * makes the actual bug fix testable with the tooling already here.
 */
describe('currentOrgSlug', () => {
  it('extracts the slug from an org-scoped pathname', () => {
    expect(currentOrgSlug('/orgs/acme-university/dashboard')).toBe('acme-university');
  });

  it('extracts the slug when nested deeper', () => {
    expect(currentOrgSlug('/orgs/acme-university/projects/123/compare')).toBe('acme-university');
  });

  it('returns undefined outside org scope', () => {
    expect(currentOrgSlug('/explore/framework')).toBeUndefined();
    expect(currentOrgSlug('/admin/users')).toBeUndefined();
    expect(currentOrgSlug('/change-password')).toBeUndefined();
    expect(currentOrgSlug('/')).toBeUndefined();
  });

  it('does not treat "orgs/new" as a slug-bearing path humans would confuse with a real org', () => {
    // Not a security boundary (the layout/requireOrgContext gate that), but
    // the sidebar must not silently compute '/orgs/new/dashboard' as a
    // destination href.
    expect(currentOrgSlug('/orgs/new')).toBe('new');
  });
});

describe('resolveOrgHref', () => {
  it('prefixes the path with the current org slug when inside one', () => {
    expect(resolveOrgHref('/orgs/acme/projects', '/dashboard')).toBe('/orgs/acme/dashboard');
  });

  it('falls back to "/" (the dispatcher) when not inside an org', () => {
    expect(resolveOrgHref('/explore/framework', '/dashboard')).toBe('/');
  });
});

describe('isNavActive', () => {
  it('matches when the current path is the resolved org-scoped href', () => {
    expect(isNavActive('/orgs/acme/dashboard', '/orgs/acme/dashboard')).toBe(true);
  });

  it('matches a nested route under the resolved href', () => {
    expect(isNavActive('/orgs/acme/projects/123', '/orgs/acme/projects')).toBe(true);
  });

  it('does NOT match a stale unprefixed href once the path gains a prefix — the exact bug this replaces', () => {
    expect(isNavActive('/orgs/acme/dashboard', '/dashboard')).toBe(false);
  });

  it('never treats the "/" fallback href as active, even though every pathname starts with "/"', () => {
    expect(isNavActive('/explore/framework', '/')).toBe(false);
    expect(isNavActive('/admin/users', '/')).toBe(false);
  });
});
