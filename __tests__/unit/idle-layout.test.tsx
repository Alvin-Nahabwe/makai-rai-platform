import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';

/**
 * UX-43 (SRS line 2645): the signed-in layout reads the session cookie's deadlines on the server and
 * hands them to the warning as relative seconds. The layout is an async server component, so the
 * returned element tree is walked for an IdleWarning element instead of being rendered.
 */

const headersMock = vi.hoisted(() => vi.fn());
const readSessionDeadlinesMock = vi.hoisted(() => vi.fn());
const membershipsMock = vi.hoisted(() => vi.fn());
const orgRoleLabelMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/auth/identity', () => ({
  requireIdentity: vi.fn(async () => ({
    userId: 'user-1',
    email: 'a@example.test',
    name: 'A',
    platformRole: 'assessor',
    mustChangePassword: false,
  })),
  // The ordinary person has passed the sign-in gates; lib/shell/data.ts asks before reading the memberships.
  identityPassesGates: vi.fn(async () => true),
}));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: readSessionDeadlinesMock }));
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: membershipsMock }));
vi.mock('@/lib/authz/roleLabel', () => ({ orgRoleLabel: orgRoleLabelMock }));
// The last-active hint lib/shell/data.ts reads for a person in two organisations (S4): this one names b.
vi.mock('@/lib/data/identity', () => ({ identityDb: { user: { findUnique: vi.fn(async () => ({ lastActiveOrgId: 'org-b' })) } } }));
vi.mock('@/components/layout/AppShell', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', redirect: vi.fn() }));

import AuthenticatedLayout from '@/app/(authenticated)/layout';
import IdleWarning from '@/components/layout/IdleWarning';
import AppShell from '@/components/layout/AppShell';
import { NewerLegalTextNotice } from '@/components/legal/NewerLegalTextNotice';

function findElements(node: ReactNode, type: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, found);
  } else if (isValidElement(node)) {
    if (node.type === type) found.push(node);
    findElements((node.props as { children?: ReactNode }).children, type, found);
  }
  return found;
}

describe('the signed-in layout and the idle warning', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const requestHeaders = new Headers({ cookie: 'authjs.session-token=x' });

  beforeEach(() => {
    headersMock.mockReset();
    headersMock.mockResolvedValue(requestHeaders);
    readSessionDeadlinesMock.mockReset();
    // The ordinary person: two organisations, and a stub label function that knows nothing yet.
    membershipsMock.mockReset();
    membershipsMock.mockResolvedValue([{ orgId: 'org-a', org: { slug: 'a', name: 'A lab' } }, { orgId: 'org-b', org: { slug: 'b', name: 'B lab' } }]);
    orgRoleLabelMock.mockReset();
    orgRoleLabelMock.mockResolvedValue(null);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("UX-43: the signed-in layout passes the cookie's deadlines to IdleWarning", async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    const tree = await AuthenticatedLayout({ children: null });
    const warnings = findElements(tree, IdleWarning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].props).toEqual({ idleSeconds: 43200, secondsLeft: 600, absoluteSecondsLeft: 100000 });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(readSessionDeadlinesMock).toHaveBeenCalledTimes(1);
    expect(readSessionDeadlinesMock.mock.calls[0][0]).toBe(requestHeaders); // the value headers() returned
  });

  it('UX-43: the signed-in layout renders no warning and logs idle_deadline_unreadable when the cookie cannot be read', async () => {
    readSessionDeadlinesMock.mockResolvedValue(null);
    const tree = await AuthenticatedLayout({ children: null });
    expect(findElements(tree, IdleWarning)).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('idle_deadline_unreadable'); // a fixed line, no token content and no other argument
  });

  it("UX-02: the layout gives the Sidebar the person's role in each of their organisations, the platform label and no platform role", async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    orgRoleLabelMock.mockImplementation(async (_identity: unknown, slug: string | undefined) =>
      slug === 'a' ? 'viewer' : slug === 'b' ? 'owner' : null);
    const tree = await AuthenticatedLayout({ children: null });
    const shells = findElements(tree, AppShell);
    expect(shells).toHaveLength(1);
    const { shell } = shells[0].props as { shell: unknown };
    expect(shell).toEqual({
      userName: 'A', userId: 'user-1', roleLabels: { a: 'Viewer', b: 'Owner' }, platformLabel: null,
      orgs: [{ slug: 'a', name: 'A lab' }, { slug: 'b', name: 'B lab' }], homeSlug: 'b',
    });
    expect(membershipsMock).toHaveBeenCalledWith('user-1');
    expect(orgRoleLabelMock.mock.calls.map((c) => c[1]).sort()).toEqual(['a', 'b', undefined]); // once per organisation, once for the platform
    expect(orgRoleLabelMock.mock.calls[0][0]).toMatchObject({ userId: 'user-1' });
    // D-10: the account's platform role field (here 'assessor') never reaches the shell, through any prop
    expect(Object.keys(shells[0].props as object).sort()).toEqual(['children', 'shell']);
    const { children: _children, ...dataProps } = shells[0].props as { children?: unknown };
    expect(JSON.stringify(dataProps)).not.toContain('assessor');
  });

  it('UX-02: with the stub label function (null) the layout passes no role label at all', async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    const tree = await AuthenticatedLayout({ children: null });
    expect((findElements(tree, AppShell)[0].props as { shell: unknown }).shell).toMatchObject({ roleLabels: {}, platformLabel: null, orgs: [{ slug: 'a' }, { slug: 'b' }] });
  });

  it('UX-02: a MAK-AI administrator with no organisation gets the platform label', async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    membershipsMock.mockResolvedValue([]);
    orgRoleLabelMock.mockImplementation(async (_identity: unknown, slug: string | undefined) => (slug === undefined ? 'MAK-AI administrator' : null));
    const tree = await AuthenticatedLayout({ children: null });
    expect((findElements(tree, AppShell)[0].props as { shell: unknown }).shell).toMatchObject({ roleLabels: {}, platformLabel: 'MAK-AI administrator', orgs: [] });
  });

  it('M-39: the layout renders the newer-text notice first inside main, for the signed-in person', async () => {
    readSessionDeadlinesMock.mockResolvedValue({ secondsLeft: 600, absoluteSecondsLeft: 100000 });
    const tree = await AuthenticatedLayout({ children: <p>page</p> });
    const notices = findElements(tree, NewerLegalTextNotice);
    expect(notices).toHaveLength(1);
    expect(notices[0].props).toEqual({ userId: 'user-1' });
    // AppShell puts the children it is handed first inside its <main> (__tests__/unit/ui/shell.test.tsx).
    const shells = findElements(tree, AppShell) as ReactElement<{ children?: ReactNode }>[];
    expect(shells).toHaveLength(1);
    const first = (Array.isArray(shells[0].props.children) ? shells[0].props.children : [shells[0].props.children])[0];
    expect(first.type).toBe(NewerLegalTextNotice);
  });
});
