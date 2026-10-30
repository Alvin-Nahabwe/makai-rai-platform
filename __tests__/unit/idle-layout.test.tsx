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

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/auth/identity', () => ({
  requireIdentity: vi.fn(async () => ({
    userId: 'user-1',
    email: 'a@example.test',
    name: 'A',
    platformRole: 'assessor',
    mustChangePassword: false,
  })),
}));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: readSessionDeadlinesMock }));
vi.mock('@/components/layout/Sidebar', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', redirect: vi.fn() }));

import AuthenticatedLayout from '@/app/(authenticated)/layout';
import IdleWarning from '@/components/layout/IdleWarning';

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
});
