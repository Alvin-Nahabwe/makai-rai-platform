import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const signOutMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ usePathname: () => '/orgs/a/dashboard' }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/client/signOutClearingDrafts', () => ({ signOutClearingDrafts: signOutMock }));
vi.mock('@/lib/client/lastProject', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/client/lastProject')>()), clearLastProjects: vi.fn() }));

import Rail, { signOutFromRail } from '@/components/layout/Rail';
import { deleteDraftsAndSignOut } from '@/components/decision/SignOutWithDraftsGuard';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { signOutMessage, type SignOutPhase } from '@/lib/client/signOutPress';
import type { ShellData } from '@/lib/shell/types';

/**
 * A refused sign-out (the owner's rule, 15 November 2026): signOutClearingDrafts REJECTS (SignOutNotEnded, SignOutTimedOut or
 * the request's own error) when the session did not end, and navigates nowhere. The rail's Sign out and the drafts guard's
 * "Delete them and sign out" report that as the phase `stillSignedIn`, whose words are S-05's `stillSignedIn` sentence
 * (lib/client/signOutPress.ts), shown in the rail foot's assertive (role="alert") status region, as every other stillSignedIn surface; a successful press shows nothing.
 */
const shell: ShellData = { userId: 'u1', userName: 'A', platformLabel: null, roleLabels: { a: 'Owner' }, orgs: [{ slug: 'a', name: 'Alpha' }], homeSlug: null };

describe('a refused sign-out is said, not swallowed', () => {
  beforeEach(() => { signOutMock.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('the rail: a refused sign-out reports stillSignedIn after working, whose sentence is S-05\'s', async () => {
    signOutMock.mockRejectedValue(Object.assign(new Error('x'), { name: 'SignOutNotEnded' }));
    const phases: SignOutPhase[] = [];
    await signOutFromRail('u1', (p) => phases.push(p), { current: false });
    expect(signOutMock).toHaveBeenCalledWith('u1', '/login');
    expect(phases).toEqual(['working', 'stillSignedIn']);
    expect(signOutMessage('stillSignedIn')).toBe(ACCEPTANCES_COPY.stillSignedIn);
    expect(console.warn).toHaveBeenCalledWith('rail: a sign-out press was rejected', 'SignOutNotEnded');
  });

  it('the rail: a successful sign-out reports working only, so nothing is said', async () => {
    signOutMock.mockResolvedValue(undefined);
    const phases: SignOutPhase[] = [];
    await signOutFromRail('u1', (p) => phases.push(p), { current: false });
    expect(phases).toEqual(['working']);
    expect(signOutMessage('working')).toBeNull();
  });

  it('the guard: a refused sign-out reports stillSignedIn and says the warning can close; a successful one does not', async () => {
    signOutMock.mockRejectedValue(new Error('x'));
    const phases: SignOutPhase[] = [];
    expect(await deleteDraftsAndSignOut('u1', (p) => phases.push(p))).toBe(false);
    expect(phases).toEqual(['working', 'stillSignedIn']);
    signOutMock.mockResolvedValue(undefined);
    const ok: SignOutPhase[] = [];
    expect(await deleteDraftsAndSignOut('u1', (p) => ok.push(p))).toBe(true);
    expect(ok).toEqual(['working']);
  });

  it('the rail: a second press while the first is unsettled is ignored, and the latch opens again after a refusal', async () => {
    let reject: (e: Error) => void = () => {};
    signOutMock.mockReturnValue(new Promise<void>((_, r) => { reject = r; }));
    const pending = { current: false };
    const phases: SignOutPhase[] = [];
    const first = signOutFromRail('u1', (p) => phases.push(p), pending);
    await signOutFromRail('u1', (p) => phases.push(p), pending);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['working']);
    reject(Object.assign(new Error('x'), { name: 'SignOutNotEnded' }));
    await first;
    expect(phases).toEqual(['working', 'stillSignedIn']);
    expect(pending.current).toBe(false);
    signOutMock.mockResolvedValue(undefined);
    await signOutFromRail('u1', (p) => phases.push(p), pending);
    expect(signOutMock).toHaveBeenCalledTimes(2);
  });

  it('the rail renders an assertive status region (role alert), empty until a sign-out is refused', () => {
    const html = renderToStaticMarkup(<Rail shell={shell} />);
    expect(html).toMatch(/<div role="alert" class="ui-status ui-status--error"[^>]*><\/div>/);
    expect(html).not.toContain(ACCEPTANCES_COPY.stillSignedIn);
  });
});
