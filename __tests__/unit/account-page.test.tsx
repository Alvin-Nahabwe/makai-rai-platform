import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';

/**
 * S-21 My account (W-12, SRS lines 2253-2283; FR-ACC-04, FR-ACC-07, FR-ACC-08, FR-EXP-03) and S-29's form. The four
 * slots belong to other units and are rendered with their contract props (contract "Screens and slots"); each is mocked
 * here to record what it was given. vitest runs in `node` with no jsdom or testing-library (an install is a download,
 * G-23), so the markup is read from react-dom/server and the button's work is a pure function driven with fakes; the
 * clicks run in e2e/account.spec.ts.
 */
vi.mock('@/components/legal/MyAcceptances', () => ({ MyAcceptances: vi.fn(() => null) }));
vi.mock('@/components/followup/ReminderEmailsSetting', () => ({ ReminderEmailsSetting: vi.fn(() => null) }));
vi.mock('@/components/account/PersonalExportAndDeletion', () => ({ PersonalExportAndDeletion: vi.fn(() => null) }));
vi.mock('@/components/decision/DraftsOnThisDevice', () => ({ DraftsOnThisDevice: vi.fn(() => null) }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn() }) }));

const { MyAcceptances } = await import('@/components/legal/MyAcceptances');
const { ReminderEmailsSetting } = await import('@/components/followup/ReminderEmailsSetting');
const { PersonalExportAndDeletion } = await import('@/components/account/PersonalExportAndDeletion');
const { DraftsOnThisDevice } = await import('@/components/decision/DraftsOnThisDevice');
const { AccountRegions } = await import('@/components/account/AccountRegions');
const { signOutEverywhere } = await import('@/components/account/SignOutEverywhere');
const { ChangePasswordView, changePasswordOutcome } = await import('@/app/(authenticated)/change-password/ChangePasswordForm');

const id: Identity = { userId: 'u1', email: 'amina@fixture.test', name: 'Amina N.', platformRole: 'assessor', mustChangePassword: false };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tagOf = (markup: string, elId: string) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${elId}"[^>]*>`))?.[0] ?? '';
const noop = () => {};

describe('S-21 My account', () => {
  it('M-38 FR-EXP-03 (S-21): the page passes the organisations where the account is the only active owner', () => {
    html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={['Lab One']} />);
    expect(vi.mocked(PersonalExportAndDeletion)).toHaveBeenLastCalledWith({ lastActiveOwnerOf: ['Lab One'] }, undefined);
  });

  it('FR-ACC-07 FR-ACC-08: S-21 offers sign out everywhere and change password, and renders every slot with its props', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails={false} lastActiveOwnerOf={[]} />);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Sign out everywhere<\/button>/);
    expect(markup).toContain('Ends every session, including this one.');
    expect(markup).toMatch(/<a [^>]*href="\/change-password"[^>]*>Change password<\/a>/);
    expect(vi.mocked(MyAcceptances)).toHaveBeenLastCalledWith({ userId: id.userId }, undefined);
    expect(vi.mocked(ReminderEmailsSetting)).toHaveBeenLastCalledWith({ enabled: false }, undefined);
    expect(vi.mocked(DraftsOnThisDevice)).toHaveBeenLastCalledWith({ userId: id.userId }, undefined);
    expect(vi.mocked(PersonalExportAndDeletion)).toHaveBeenLastCalledWith({ lastActiveOwnerOf: [] }, undefined);
  });

  it('FR-ACC-04 (S-21, W-12): the regions come in W-12 order, each a labelled section', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);
    const headings = [...markup.matchAll(/<section aria-labelledby="([^"]+)"><h2 id="\1">([^<]+)<\/h2>/g)].map((m) => m[2]);
    expect(headings).toEqual(['My account', 'Password', 'Sessions']);
    expect(markup).toMatch(/<h1[^>]*>My account<\/h1>/);
  });

  it('FR-ACC-07: Sign out everywhere ends the sessions, then signs this browser out', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => { calls.push(`${init?.method} ${url}`); return new Response('{"success":true}', { status: 200 }); });
    const signOutImpl = vi.fn(async (o: { callbackUrl?: string; redirect?: boolean }) => { calls.push(`signOut ${o.callbackUrl}`); });
    expect(await signOutEverywhere(fetchImpl as unknown as typeof fetch, signOutImpl)).toEqual({ kind: 'done' });
    expect(calls).toEqual(['DELETE /api/users/me/sessions', 'signOut /login']);
  });

  it('FR-ACC-07: a refused or lost Sign out everywhere says so and does not pretend', async () => {
    const signOutImpl = vi.fn(async () => {});
    const refused = vi.fn(async () => new Response('{}', { status: 500 }));
    expect(await signOutEverywhere(refused as unknown as typeof fetch, signOutImpl)).toMatchObject({ kind: 'error' });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await signOutEverywhere(offline as unknown as typeof fetch, signOutImpl)).toMatchObject({ kind: 'error' });
    expect(signOutImpl).not.toHaveBeenCalled();
  });

  it('FR-ACC-07 (C4 ruling F1): a 401 is not reported as done; this browser is signed out and the page says what to do', async () => {
    // A 401 can come from this session's own 7-day limit while the other sessions live, so nothing says they ended.
    const signOutImpl = vi.fn(async () => {});
    const gone = vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));
    expect(await signOutEverywhere(gone as unknown as typeof fetch, signOutImpl)).toEqual({ kind: 'error',
      message: 'Not signed out everywhere: you have been signed out of this browser. Sign in again and choose Sign out everywhere.' });
    expect(signOutImpl).toHaveBeenCalledWith({ redirect: false });
    // The alert is not a paragraph inside the region's paragraph (C4 CR-3: <p> in <p> is invalid HTML).
    const markup = html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);
    expect(markup).not.toMatch(/<p>(?:(?!<\/p>).)*<button/);
  });

  it('FR-ACC-04 (S-21): the name is read only and the page reads no acceptance data itself', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);
    expect(markup).not.toMatch(/Save name/);
    expect(markup).not.toMatch(/Name saved/);
    expect(markup).toContain('Amina N.');
    expect(markup).toContain('amina@fixture.test');
    expect(markup).not.toMatch(/<input/);
    for (const f of ['app/(authenticated)/account/page.tsx', 'components/account/AccountRegions.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/@\/lib\/data\/acceptances/);
    }
  });

  it('FR-ACC-04 UX-01: the page runs the gates itself (requireIdentity), and its owners list is the caller\'s own', () => {
    const src = readFileSync('app/(authenticated)/account/page.tsx', 'utf8');
    expect(src).toMatch(/await requireIdentity\(\)/);
    expect(src).toMatch(/lastActiveOwnerOf\(identity\.userId\)/);
  });
});

describe('S-29 and S-21\'s password change', () => {
  it('FR-ACC-08 NFR-SEC-18: one new-password field with the hint, the current password, and Show on both', () => {
    const markup = html(<ChangePasswordView currentPassword="" newPassword="" show={false} state={{ kind: 'idle' }}
      onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(tagOf(markup, 'currentPassword')).toMatch(/autocomplete="current-password"/i);
    expect(tagOf(markup, 'newPassword')).toMatch(/autocomplete="new-password"/i);
    expect(tagOf(markup, 'newPassword')).toMatch(/aria-describedby="newPassword-hint"/);
    expect(markup).toContain('At least 12 characters.');
    expect(markup.match(/type="password"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/confirm/i);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Change password<\/button>/);
  });

  it('FR-ACC-08 NFR-SEC-18: a 422 is shown under the new password and named by aria-describedby; a 400 is shown at the top', async () => {
    const r422 = await changePasswordOutcome(new Response(JSON.stringify({ code: 'validation', fields: [{ field: 'newPassword', message: 'Password must be at least 12 characters' }] }), { status: 422 }));
    expect(r422).toEqual({ kind: 'invalid', field: 'newPassword', message: 'Password must be at least 12 characters' });
    const markup = html(<ChangePasswordView currentPassword="x" newPassword="y" show={false} state={r422} onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(tagOf(markup, 'newPassword')).toMatch(/aria-describedby="newPassword-hint newPassword-error"/);
    expect(tagOf(markup, 'newPassword')).toMatch(/aria-invalid="true"/);
    expect(markup).toMatch(/id="newPassword-error"[^>]*>Password must be at least 12 characters</);
    const r400 = await changePasswordOutcome(new Response(JSON.stringify({ error: 'Current password is incorrect' }), { status: 400 }));
    expect(r400).toEqual({ kind: 'error', message: 'Current password is incorrect' });
    expect(html(<ChangePasswordView currentPassword="x" newPassword="y" show={false} state={r400} onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />))
      .toMatch(/role="alert"[^>]*>Current password is incorrect</);
    expect(await changePasswordOutcome(new Response('{"success":true}', { status: 200 }))).toEqual({ kind: 'done' });
    // A failure on the server is said as such, with its support reference, and never as "your password is as it was".
    expect(await changePasswordOutcome(new Response('{"error":"Service unavailable","code":"database_unavailable","reference":"0a1b2c3d"}', { status: 503 })))
      .toEqual({ kind: 'error', message: 'The server had a problem (reference 0a1b2c3d). Try again.' });
    expect(await changePasswordOutcome(new Response('<html>Bad gateway</html>', { status: 502 })))
      .toEqual({ kind: 'error', message: 'The server had a problem. Try again.' });
  });
});
