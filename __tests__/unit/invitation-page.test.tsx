import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Invitation } from '@prisma/client';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';
import { escapeRe } from '../helpers/escapeRe';

/**
 * S-04, the invitation page (FR-ACC-01, FR-ACC-03, FR-MEM-01; W-11 and note 1, SRS lines 2214-2227;
 * 7.4.2 row S-04 / S-05, line 2388).
 *
 * vitest's environment is `node` and no DOM library is installed (G-23; reviews/fix-r12.md R12-15),
 * so this file reads react-dom/server markup of each state and the pure rules the client applies.
 * The clicks (Continue, the three ticks, Create account) and Try again's resend (after a lost
 * connection the same body is sent again, on both of S-04's branches and on S-05) are driven in a
 * browser by e2e/acceptances.spec.ts; here only the not-created alert's markup is read.
 */

vi.mock('@/lib/data/preauth', () => ({ invitationByToken: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ tryResolveIdentity: vi.fn(async () => null) }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: InvitationPage } = await import('@/app/(public)/invitations/[token]/page');
const client = await import('@/app/(public)/invitations/[token]/AcceptInvitationClient');
const { default: AcceptInvitationClient, NewAccountView, signUpErrors, registerOutcome, joinOutcome, welcomePath, afterCreated, signInAfterCreated } = client;
const { SendStatus } = await import('@/components/legal/AcceptancesForm');
const { invitationByToken } = await import('@/lib/data/preauth');
const { tryResolveIdentity } = await import('@/lib/auth/identity');
const { PASSWORD_MIN_LENGTH } = await import('@/lib/validate');
const { VALIDATION_COPY } = await import('@/lib/http/copy');
const { INVITATION_COPY } = await import('@/lib/invitations/copy');
const { ACCEPTANCES_COPY } = await import('@/lib/legal/acceptances/copy');
const { INVITATION_PAGE_COPY, roleWithArticle } = await import('@/lib/org/copy');

const M23 = INVITATION_PAGE_COPY.unusable;
const TEXTS = STUB_LEGAL_TEXTS.slice();
const pendingInvitation: Invitation & { org: { name: string; slug: string }; invitedBy: { name: string } } = {
  id: 'inv1', orgId: 'org1', email: 'head.of.lab@example.ac.ug', role: 'assessor', tokenHash: 'h'.repeat(64), status: 'pending',
  invitedById: 'u0', expiresAt: new Date('2026-11-04T09:00:00Z'), createdAt: new Date('2026-10-28T09:00:00Z'), acceptedAt: null,
  kind: 'member', linkShownAt: null, requestReference: null, org: { name: 'Makerere CAI Lab', slug: 'makerere-cai-lab' }, invitedBy: { name: 'Amina N.' },
};
const props = { token: 't'.repeat(64), invitedEmail: 'a@x.test', orgName: 'Lab', role: 'assessor' as const, inviterName: 'Amina N.',
  expiresOn: '2026-11-09', texts: TEXTS };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const tagOf = (markup: string, id: string) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
const view = (over: Partial<Parameters<typeof NewAccountView>[0]> = {}) => html(<NewAccountView {...props} viewerEmail={null} step="details" name="" password=""
  showPassword={false} errors={{}} send={{ state: 'idle' }} onName={vi.fn()} onPassword={vi.fn()} onToggleShow={vi.fn()}
  onContinue={vi.fn()} onAccepted={vi.fn(async () => {})} onRetry={vi.fn()} {...over} />);

beforeEach(() => {
  vi.mocked(invitationByToken).mockReset();
  vi.mocked(tryResolveIdentity).mockResolvedValue(null);
});

describe('S-04, the invitation page (FR-ACC-01)', () => {
  it('M-23 FR-ACC-01: an unusable link shows one message', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(null);
    const markup = html(await InvitationPage({ params: Promise.resolve({ token: 'x' }) }));
    expect(markup).toContain(`<h1>${INVITATION_PAGE_COPY.unusableHeading}</h1><p>${M23}</p>`);
    expect(markup).not.toMatch(/<input|<button|<form/);
    expect(text(markup)).not.toMatch(/invited you to join|This invitation ends|Create your account/);       // no organisation, role or inviter name
  });

  it('FR-MEM-01 FR-ACC-01: S-04 shows the inviter\'s account name, the role and the expiry date', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(pendingInvitation);
    const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
    expect(markup).toContain('<h1>You are invited to Makerere CAI Lab</h1>');
    expect(text(markup)).toContain(INVITATION_PAGE_COPY.invitedLine('Amina N.', 'an Assessor', '4 Nov 2026'));
    expect(text(markup)).toContain('Amina N. invited you to join as an Assessor. This invitation ends on 4 Nov 2026.');
    expect(markup).toContain('value="head.of.lab@example.ac.ug"');
  });

  it('FR-MEM-01 NFR-SEC-11: the organisation and inviter names are rendered as text', async () => {
    vi.mocked(invitationByToken).mockResolvedValue({ ...pendingInvitation, org: { name: '<script>alert(1)</script>', slug: 'lab' }, invitedBy: { name: '"><img src=x onerror=alert(1)>' } });
    const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
    expect(markup).not.toMatch(/<script|<img/);
  });

  it('FR-MEM-01: the invited line uses "a" or "an" for the role', async () => {
    for (const [role, withArticle] of [['owner', 'an Owner'], ['admin', 'an Admin'], ['assessor', 'an Assessor'], ['reviewer', 'a Reviewer'], ['viewer', 'a Viewer']] as const) {
      expect(roleWithArticle(role)).toBe(withArticle);
      vi.mocked(invitationByToken).mockResolvedValue({ ...pendingInvitation, role });
      const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
      expect(text(markup)).toContain(`Amina N. invited you to join as ${withArticle}. This invitation ends on 4 Nov 2026.`);
    }
  });

  it('FR-ACC-01: after creation S-04 lands on the dashboard with welcome=1 and nothing else in the address', () => {
    expect(welcomePath('lab')).toBe('/orgs/lab/dashboard?welcome=1');
    expect(registerOutcome(201, { orgSlug: 'lab' }, 't')).toEqual({ kind: 'created', orgSlug: 'lab' });
  });

  it('FR-ACC-01 (7.4.2 S-04): while sending, S-04 shows "Creating your account..."', () => {
    const markup = view({ step: 'acceptances', send: { state: 'sending' } });
    expect(markup).toMatch(/<div[^>]*role="status"[^>]*class="ui-status"[^>]*>Creating your account\.\.\.<\/div>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create account<\/button>/);
  });

  it('FR-ACC-01 (7.4.2 S-04): a lost reply shows that the account may already be created, with Try again', () => {
    const markup = view({ step: 'acceptances', send: { state: 'lost' } });
    expect(text(markup.match(/<div[^>]*role="alert"[^>]*>.*?<\/div>/)?.[0] ?? '')).toBe(ACCEPTANCES_COPY.send.account.lost);
    expect(ACCEPTANCES_COPY.send.account.lost).toBe('We did not get a reply, so your account may already be created. Select Try again. If the link no longer works, sign in with the password you chose.');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
    // A server fault on the new-account branch, and both texts on the other kind of send.
    expect(text(html(<SendStatus send={{ state: 'refused' }} what="account" sendingText="x" onRetry={vi.fn()} />))).toContain('Your account was not created because of a problem on our side. Try again.');
    expect(text(html(<SendStatus send={{ state: 'lost' }} what="choice" sendingText="x" onRetry={vi.fn()} />))).toContain('Your choice was not saved. Check your internet connection and try again.');
    expect(text(html(<SendStatus send={{ state: 'refused' }} what="choice" sendingText="x" onRetry={vi.fn()} />))).toContain('Your choice was not saved because of a problem on our side. Try again.');
  });

  it('FR-ACC-01 (7.4.2 S-04 validation): an empty name and a short password are named on their fields and nothing is posted', () => {
    expect(signUpErrors('', 'short')).toEqual({ name: INVITATION_COPY.nameRequired, password: VALIDATION_COPY.passwordTooShort(PASSWORD_MIN_LENGTH) });
    expect(signUpErrors('   ', 'a'.repeat(PASSWORD_MIN_LENGTH))).toEqual({ name: INVITATION_COPY.nameRequired });
    expect(INVITATION_COPY.nameRequired).toBe('Enter your name.');
    expect(signUpErrors('  Amina  ', 'a'.repeat(PASSWORD_MIN_LENGTH))).toEqual({});
    const markup = view({ errors: { name: INVITATION_COPY.nameRequired, password: VALIDATION_COPY.passwordTooShort(PASSWORD_MIN_LENGTH) } });
    expect(tagOf(markup, 'name')).toContain('aria-invalid="true"');
    expect(tagOf(markup, 'name')).toMatch(/aria-describedby="name-hint name-error"/);
    expect(tagOf(markup, 'name-error')).not.toBe('');
    expect(markup).toMatch(new RegExp(`id="name-error"[^>]*>${escapeRe(INVITATION_COPY.nameRequired)}<`));
    expect(tagOf(markup, 'new-password')).toContain('aria-invalid="true"');
    expect(tagOf(markup, 'new-password')).toMatch(/aria-describedby="new-password-hint new-password-error"/);
    expect(markup).toMatch(new RegExp(`id="new-password-error"[^>]*>${escapeRe(VALIDATION_COPY.passwordTooShort(PASSWORD_MIN_LENGTH))}<`));
    expect(markup).not.toContain('accept-terms');      // still on step 1: the acceptances are not shown
  });

  it('FR-ACC-01: the server answers map to what S-04 shows', () => {
    expect(registerOutcome(410, { error: M23, code: 'invitation_unusable' }, 't')).toEqual({ kind: 'message', text: M23 });
    // A 409 `account_exists` carries the sign-in link with the text (A 270): matched on status and code, never on the words.
    const signInHref = `/login?callbackUrl=${encodeURIComponent(`/invitations/${'t'.repeat(64)}`)}`;
    expect(registerOutcome(409, { error: 'any words at all', code: 'account_exists' }, 't'.repeat(64)))
      .toEqual({ kind: 'message', text: INVITATION_COPY.accountExists, link: { href: signInHref, label: INVITATION_COPY.signIn } });
    expect(INVITATION_COPY.accountExists).toBe('You already have an account with this email. Sign in to accept the invitation.');
    expect(registerOutcome(409, { error: 'x', code: 'legal_text_changed' }, 't'.repeat(64))).toEqual({ kind: 'reload', text: 'x' });
    expect(registerOutcome(422, { code: 'validation', error: 'x', fields: [{ field: 'name', message: 'name is required' }] }, 't'))
      .toEqual({ kind: 'fields', errors: { name: 'name is required' } });
    expect(registerOutcome(422, { code: 'validation', error: 'To continue, accept the privacy notice.', missing: ['privacy'], fields: [] }, 't'))
      .toEqual({ kind: 'message', text: 'To continue, accept the privacy notice.' });
    expect(registerOutcome(503, { error: 'Service unavailable', code: 'database_unavailable' }, 't')).toEqual({ kind: 'refused' });
    expect(registerOutcome(500, null, 't')).toEqual({ kind: 'refused' });
  });

  it('FR-ACC-03: a 403 acceptances_required from route 32 (a kind missing, or a current version only offered) shows the form for those kinds', () => {
    expect(joinOutcome(403, { error: 'Acceptances required', code: 'acceptances_required', missing: ['privacy'] }))
      .toEqual({ kind: 'accept-first', missing: ['privacy'] });
    expect(joinOutcome(200, { orgSlug: 'lab' })).toEqual({ kind: 'joined', orgSlug: 'lab' });
    expect(joinOutcome(410, { error: M23, code: 'invitation_unusable' })).toEqual({ kind: 'message', text: M23 });
  });

  it('FR-ACC-03 (threat A5): a 409 legal_text_changed from route 31 reloads S-04 with the new text and shows M-39', () => {
    const m39 = 'A new version of the privacy notice was published on 2 Dec 2026.';
    expect(registerOutcome(409, { error: m39, code: 'legal_text_changed', missing: ['privacy'] }, 't')).toEqual({ kind: 'reload', text: m39 });
  });

  it('FR-ACC-01 (7.4.2 S-04): an account created whose automatic sign-in fails says so, with a link to sign in and land on the welcome', () => {
    expect(afterCreated(true, 'lab')).toEqual({ push: '/orgs/lab/dashboard?welcome=1' });
    const failed = afterCreated(false, 'lab');
    expect(failed).toEqual({ send: { state: 'message', text: INVITATION_COPY.accountCreated,
      link: { href: '/login?callbackUrl=%2Forgs%2Flab%2Fdashboard%3Fwelcome%3D1', label: INVITATION_COPY.signIn } } });
    expect(INVITATION_COPY.accountCreated).toBe('Your account was created. Sign in to continue.');
    // The link follows the alert region directly, outside it (a region holds a string only).
    const markup = html(<SendStatus send={'send' in failed ? failed.send : { state: 'idle' }} what="account" sendingText="x" onRetry={vi.fn()} />);
    expect(markup).toMatch(/<div[^>]*role="alert"[^>]*>(<span[^>]*>.*?<\/span>)?Your account was created\. Sign in to continue\.<\/div><p[^>]*><a[^>]*href="\/login\?callbackUrl=%2Forgs%2Flab%2Fdashboard%3Fwelcome%3D1"[^>]*>Sign in<\/a>/);
  });

  it('NFR-PERF-02 T16-Q11: when the sign-in library cannot load after the 201, S-04 shows that the account was created, with its sign-in link', async () => {
    const load = vi.fn(() => Promise.reject(new Error('chunk load failed')));
    const signedIn = await signInAfterCreated('a@x.test', 'pw-typed', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(signedIn).toBe(false);
    expect(afterCreated(signedIn, 'lab')).toEqual(afterCreated(false, 'lab'));
    // The library's own answers keep their meaning: ok signs in, anything else (a rejection too) does not.
    const signIn = vi.fn(async () => ({ ok: true }));
    expect(await signInAfterCreated('a@x.test', 'pw-typed', async () => ({ signIn }) as never)).toBe(true);
    expect(signIn).toHaveBeenCalledWith('credentials', { email: 'a@x.test', password: 'pw-typed', redirect: false });
    expect(await signInAfterCreated('a@x.test', 'pw-typed', async () => ({ signIn: async () => ({ ok: false }) }) as never)).toBe(false);
    expect(await signInAfterCreated('a@x.test', 'pw-typed', async () => ({ signIn: () => Promise.reject(new Error('x')) }) as never)).toBe(false);
  });

  it('T16-Q11: the M-24 Sign out is idle, with an empty alert region directly under it', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail="b@x.test" viewerUserId="u-b" />);
    const button = markup.match(/<button[^>]*>Sign out<\/button>/)?.[0] ?? '';
    expect(button).not.toContain('aria-busy');
    expect(markup).toMatch(/<button[^>]*>Sign out<\/button><div role="alert" class="ui-status ui-status--error"><\/div>/);
  });

  it('M-24: a different signed-in account sees both emails', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail="b@x.test" viewerUserId="u-b" />);
    expect(text(markup.match(/<div[^>]*role="alert"[^>]*>.*?<\/div>/)?.[0] ?? '')).toBe(INVITATION_COPY.wrongAccount('b@x.test', 'a@x.test'));
    expect(INVITATION_COPY.wrongAccount('b@x.test', 'a@x.test')).toBe('You are signed in as b@x.test, but this invitation is for a@x.test. Sign out, then open the link again.');
    expect(markup).toMatch(/<button[^>]*>Sign out<\/button>/);
  });

  it('FR-ACC-01: the invited account, signed in, gets one Accept invitation button', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail="A@x.test" viewerUserId="u-a" />);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Accept invitation<\/button>/);
    expect(markup).not.toContain('type="password"');
  });

  it('NFR-A11Y-04 FR-ACC-01: the new-account form takes a pasted password and offers the email to password managers', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail={null} viewerUserId={null} />);
    const email = tagOf(markup, 'email');
    expect(email).toMatch(/autocomplete="username"/i);   // react-dom writes the attribute as autoComplete; HTML ignores case
    expect(email).toMatch(/readOnly=""|readonly=""/);
    expect(email).toContain('type="email"');
    expect(markup).toMatch(/<label[^>]*for="email"[^>]*>Email<\/label>/);
    expect(markup).toContain('This is the email your invitation was sent to. You cannot change it.');
    const pw = tagOf(markup, 'new-password');
    expect(pw).toMatch(/autocomplete="new-password"/i);
    expect(pw).toContain('type="password"');
    expect(markup).toMatch(/<label[^>]*for="new-password"[^>]*>Password[^<]*(<span[^>]*>[^<]*<\/span>)?<\/label>/);
    expect(markup).toMatch(/<label[^>]*for="name"[^>]*>Your name[^<]*(<span[^>]*>[^<]*<\/span>)?<\/label>/);
    expect(markup).toContain('Your colleagues will see this name. You cannot change it later.');
    expect(tagOf(markup, 'name')).toMatch(/autocomplete="name"/i);
    expect(markup).toContain(`At least ${PASSWORD_MIN_LENGTH} characters.`);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Show password<\/button>/);
    expect(markup).not.toMatch(/onpaste|oncopy|autocomplete="off"/i);
    expect(markup).toMatch(/Already have an account with this email\? <a href="\/login\?callbackUrl=%2Finvitations%2Ft{64}"[^>]*>Sign in to accept<\/a>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
  });

  it('FR-ACC-03: Continue shows the three boxes, unticked, with Create account', () => {
    const markup = view({ step: 'acceptances', name: 'Amina', password: 'a'.repeat(12) });
    expect(markup.match(/<input[^>]*type="checkbox"[^>]*>/g)?.filter((b) => !/\bchecked\b/.test(b))).toHaveLength(3);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Create account<\/button>/);
    expect(markup).toContain('If you do not want to accept, close this page. Your account will not be created.');
    expect(markup).not.toContain('type="password"');      // step 1 is done; the password is kept, not shown again
  });
});
