import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import { escapeRe } from '../helpers/escapeRe';

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
const { DeleteConfirm, PersonalExportAndDeletionForm } = await import('@/components/account/PersonalExportAndDeletionForm');
const { ChangePasswordView, changePasswordOutcome } = await import('@/app/(authenticated)/change-password/ChangePasswordForm');
const { CHANGE_PASSWORD_COPY } = await import('@/lib/auth/copy');
const { ACCOUNT_COPY, SIGN_OUT_EVERYWHERE_COPY, PERSONAL_DATA_COPY, phraseLabel } = await import('@/lib/account/copy');
const { ORG_COPY, welcomeLine } = await import('@/lib/org/copy');
const { VALIDATION_COPY } = await import('@/lib/http/copy');

const id: Identity = { userId: 'u1', email: 'amina@fixture.test', name: 'Amina N.', platformRole: 'assessor', mustChangePassword: false };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tagOf = (markup: string, elId: string) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${elId}"[^>]*>`))?.[0] ?? '';
const noop = () => {};
/** The words inside the page's live region of this role (the kit's StatusRegion), tags removed. */
const regionText = (markup: string, role: 'alert' | 'status') =>
  (markup.match(new RegExp(`<div role="${role}"[^>]*>(.*?)</div>`))?.[1] ?? '').replace(/<[^>]*>/g, '');

describe('S-21 My account', () => {
  it('M-38 FR-EXP-03 (S-21): the page passes the organisations where the account is the only active owner', () => {
    html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={['Lab One']} />);
    expect(vi.mocked(PersonalExportAndDeletion)).toHaveBeenLastCalledWith({ userId: 'u1', lastActiveOwnerOf: ['Lab One'] }, undefined);
  });

  it('FR-ACC-07 FR-ACC-08: S-21 offers sign out everywhere and change password, and renders every slot with its props', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails={false} lastActiveOwnerOf={[]} />);
    expect(markup).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>${escapeRe(SIGN_OUT_EVERYWHERE_COPY.button)}</button>`));
    expect(markup).toContain(SIGN_OUT_EVERYWHERE_COPY.explains);
    expect(markup).toMatch(new RegExp(`<a [^>]*href="/change-password"[^>]*>${escapeRe(ACCOUNT_COPY.page.changePassword)}</a>`));
    expect(vi.mocked(MyAcceptances)).toHaveBeenLastCalledWith({ userId: id.userId }, undefined);
    // FX2: the page also hands the setting its label with "mitigation" marked, and that term's definition (account-terms.test.tsx).
    expect(vi.mocked(ReminderEmailsSetting)).toHaveBeenLastCalledWith({ enabled: false, label: expect.anything(), hint: { id: 'account-mitigation-definition', node: expect.anything() } }, undefined);
    expect(vi.mocked(DraftsOnThisDevice)).toHaveBeenLastCalledWith({ userId: id.userId }, undefined);
    expect(vi.mocked(PersonalExportAndDeletion)).toHaveBeenLastCalledWith({ userId: 'u1', lastActiveOwnerOf: [] }, undefined);
  });

  it('FR-ACC-04 (S-21, W-12): the regions come in W-12 order, each a labelled section', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);
    const headings = [...markup.matchAll(/<section aria-labelledby="([^"]+)"><h2 id="\1"[^>]*>([^<]+)<\/h2>/g)].map((m) => m[2]);
    expect(headings).toEqual([ACCOUNT_COPY.page.detailsHeading, ACCOUNT_COPY.page.passwordHeading, ACCOUNT_COPY.page.devicesHeading]);
    expect(headings).toEqual(['Name and email', 'Password', 'Signed-in devices']); // audit A 78, 81, 83: the h2 no longer repeats the h1
    expect(markup).toMatch(new RegExp(`<h1[^>]*>${escapeRe(ACCOUNT_COPY.page.heading)}</h1>`));
    // One column that may shrink below its content's width, and the name and email wrap anywhere, so a long unbroken
    // value stays inside the page.
    expect(markup).toMatch(/<div class="page-content" style="[^"]*grid-template-columns:minmax\(0, 1fr\)[^"]*">/);
    expect(markup).toMatch(new RegExp(`<dd style="overflow-wrap:anywhere">${escapeRe('Amina N.')}</dd>`));
    expect(markup).toMatch(new RegExp(`<dd style="overflow-wrap:anywhere">${escapeRe(id.email)}</dd>`));
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
    expect(await signOutEverywhere(refused as unknown as typeof fetch, signOutImpl)).toEqual({ kind: 'error', message: SIGN_OUT_EVERYWHERE_COPY.notDone });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await signOutEverywhere(offline as unknown as typeof fetch, signOutImpl)).toEqual({ kind: 'error', message: SIGN_OUT_EVERYWHERE_COPY.notDone });
    expect(signOutImpl).not.toHaveBeenCalled();
  });

  it('FR-ACC-07 (C4 ruling F1): a 401 is not reported as done; this browser is signed out and the page says what to do', async () => {
    // A 401 can come from this session's own 7-day limit while the other sessions live, so nothing says they ended.
    const signOutImpl = vi.fn(async () => {});
    const gone = vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));
    expect(await signOutEverywhere(gone as unknown as typeof fetch, signOutImpl)).toEqual({ kind: 'error', message: SIGN_OUT_EVERYWHERE_COPY.signedOutHere });
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
    expect(markup).toContain(CHANGE_PASSWORD_COPY.hint(12));
    expect(markup.match(/type="password"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/confirm/i);
    expect(markup).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${escapeRe(CHANGE_PASSWORD_COPY.submit)}</button>`));
    expect(markup).toMatch(new RegExp(`<button[^>]*type="button"[^>]*aria-controls="currentPassword newPassword"[^>]*>${escapeRe(CHANGE_PASSWORD_COPY.showPasswords)}</button>`));
  });

  it('FR-ACC-08 NFR-SEC-18: a 422 is shown under the new password and named by aria-describedby; a 400 is shown at the top', async () => {
    const tooShort = VALIDATION_COPY.passwordTooShort(12);
    const r422 = await changePasswordOutcome(new Response(JSON.stringify({ code: 'validation', fields: [{ field: 'newPassword', message: tooShort }] }), { status: 422 }));
    expect(r422).toEqual({ kind: 'invalid', field: 'newPassword', message: tooShort });
    const markup = html(<ChangePasswordView currentPassword="x" newPassword="y" show={false} state={r422} onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(tagOf(markup, 'newPassword')).toMatch(/aria-describedby="newPassword-hint newPassword-error"/);
    expect(tagOf(markup, 'newPassword')).toMatch(/aria-invalid="true"/);
    expect(markup).toMatch(new RegExp(`id="newPassword-error"[^>]*>${escapeRe(tooShort)}<`));
    const r400 = await changePasswordOutcome(new Response(JSON.stringify({ error: 'Current password is incorrect' }), { status: 400 }));
    expect(r400).toEqual({ kind: 'error', message: 'Current password is incorrect' });
    expect(regionText(html(<ChangePasswordView currentPassword="x" newPassword="y" show={false} state={r400} onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />), 'alert'))
      .toBe('Current password is incorrect');
    expect(await changePasswordOutcome(new Response('{"success":true}', { status: 200 }))).toEqual({ kind: 'done' });
    // A failure on the server is said as such, with its support reference, and never as "your password is as it was".
    expect(await changePasswordOutcome(new Response('{"error":"Service unavailable","code":"database_unavailable","reference":"0a1b2c3d"}', { status: 503 })))
      .toEqual({ kind: 'error', message: CHANGE_PASSWORD_COPY.serverProblem('0a1b2c3d') });
    expect(await changePasswordOutcome(new Response('<html>Bad gateway</html>', { status: 502 })))
      .toEqual({ kind: 'error', message: CHANGE_PASSWORD_COPY.serverProblem(null) });
    // An empty reference is said as no reference, never as "give this reference: .".
    expect(await changePasswordOutcome(new Response('{"error":"x","code":"internal_error","reference":""}', { status: 500 })))
      .toEqual({ kind: 'error', message: CHANGE_PASSWORD_COPY.serverProblem(null) });
  });
});

describe('1A-16c: the words of My account, word for word (audit A 78 to 87)', () => {
  it('A 84, 85, 87: the three sentences of Sign out everywhere', () => {
    expect(SIGN_OUT_EVERYWHERE_COPY.notDone).toBe('You are still signed in on your other devices. Check your internet connection and try again.');
    expect(SIGN_OUT_EVERYWHERE_COPY.signedOutHere).toBe('You are signed out in this browser. You may still be signed in on other devices. Sign in again, then select Sign out everywhere.');
    expect(SIGN_OUT_EVERYWHERE_COPY.explains).toBe('Signs you out on every device, including this one.');
  });

  it('A 84 to 87: the error is the kit StatusRegion and the button is the kit secondary button, in the order the page had them', () => {
    const markup = html(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);
    expect(markup).toMatch(/<button class="ui-button ui-button--secondary" type="button">Sign out everywhere<\/button>/);
    expect(markup).toMatch(/<div role="alert" class="ui-status ui-status--error"><\/div>/); // mounted empty: the region exists before its text
    expect(markup.indexOf('Sign out everywhere</button>')).toBeLessThan(markup.indexOf(SIGN_OUT_EVERYWHERE_COPY.explains));
  });
});

describe('1A-16c: the words of My data and Delete my account, word for word (audit A 88 to 98)', () => {
  it('A 89, 90, 94, 96: the rewritten texts', () => {
    expect(PERSONAL_DATA_COPY.downloadIntro).toBe('You can download a file with your data. It has your account details, your memberships, the legal texts you accepted and your reminder setting. It also lists the records you entered or were named in. It does not include the text of those records. That text belongs to your organisation.');
    // Owner's written exception (15 Nov 2026): a deleted account is shown as "Deleted user", the name lib/data/identity.ts writes and the approved legal texts promise.
    expect(PERSONAL_DATA_COPY.deleteConsequence).toBe('Your name and email are removed and you are signed out everywhere. Records you entered stay with your organisations, shown as entered by "Deleted user". This cannot be undone.');
    expect(PERSONAL_DATA_COPY.passwordLabel).toBe('Your current password');
    expect(PERSONAL_DATA_COPY.download).toBe('Download my data');
  });

  it('A 89 and account deletion: the confirm button is destructive, the typed phrase keeps its input attributes, and the download sentence comes before the link', () => {
    const confirm = html(<DeleteConfirm userId="u1" onCancel={noop} />);
    expect(confirm).toMatch(new RegExp(`<button[^>]*class="[^"]*\\bui-button--destructive\\b[^"]*"[^>]*>${escapeRe(PERSONAL_DATA_COPY.deleteAction)}</button>`));
    // React writes these three names in camel case (autoCapitalize=…); HTML attribute names ignore case.
    const phraseInput = confirm.match(/<input[^>]*name="phrase"[^>]*>/)?.[0] ?? '';
    expect(phraseInput).toMatch(/autocapitalize="characters"/i);
    expect(phraseInput).toMatch(/autocomplete="off"/i);
    expect(phraseInput).toMatch(/spellcheck="false"/i);
    const data = html(<PersonalExportAndDeletionForm userId="u1" lastActiveOwnerOf={[]} />);
    expect(data.indexOf(`<p>${PERSONAL_DATA_COPY.downloadIntro}</p>`)).toBeGreaterThan(-1);
    expect(data.indexOf(`<p>${PERSONAL_DATA_COPY.downloadIntro}</p>`)).toBeLessThan(data.indexOf('href="/api/users/me/export"'));
  });

  it('A 91: the typed phrase label is built from the phrase, which stays in lib/export/messages', () => {
    expect(phraseLabel('DELETE MY ACCOUNT')).toBe('Type DELETE MY ACCOUNT to confirm');
  });

  it('A 79 to 82, 86, 88, 92, 93, 95, 97, 98 KEEP: unchanged words, moved', () => {
    expect([ACCOUNT_COPY.page.name, ACCOUNT_COPY.page.email, ACCOUNT_COPY.page.passwordHeading, ACCOUNT_COPY.page.changePassword]).toEqual(['Name', 'Email', 'Password', 'Change password']);
    expect([PERSONAL_DATA_COPY.dataHeading, PERSONAL_DATA_COPY.preparing, PERSONAL_DATA_COPY.objectName, PERSONAL_DATA_COPY.deleteAction, PERSONAL_DATA_COPY.deleteHeading, PERSONAL_DATA_COPY.deleteTrigger])
      .toEqual(['My data', 'Preparing your file...', 'Your account', 'Delete my account', 'Delete my account', 'Delete my account...']);
  });
});

describe('1A-16c: the chooser and the welcome line, word for word (audit A 3 to 6, 100)', () => {
  it('A 3 to 6: the chooser says organisation with an s, and the empty state says who to ask and how the invitation comes', () => {
    expect(ORG_COPY.chooser.heading).toBe('Choose an organisation');
    expect(ORG_COPY.chooser.listLabel).toBe('Your organisations');
    expect(ORG_COPY.chooser.emptyHeading).toBe('Welcome');
    expect(ORG_COPY.chooser.emptyBody).toBe("You are not a member of any organisation yet. Ask the Owner of your team's organisation to invite you. You will get the invitation by email.");
  });

  it('A 100: the welcome names the role with its article, from the vocabulary, never the raw value', () => {
    expect(welcomeLine('Lab One', 'an Owner')).toBe('Welcome to Lab One. You are an Owner.');
  });
});
