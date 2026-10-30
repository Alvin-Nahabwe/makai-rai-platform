import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Invitation } from '@prisma/client';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * S-04, the invitation page (FR-ACC-01, FR-ACC-03, FR-MEM-01; W-11 and note 1, SRS lines 2214-2227;
 * 7.4.2 row S-04 / S-05, line 2388).
 *
 * vitest's environment is `node` and no DOM library is installed (G-23; reviews/fix-r12.md R12-15),
 * so this file reads react-dom/server markup of each state and the pure rules the client applies;
 * the clicks (Continue, the three ticks, Create account, Try again) are driven in a browser by
 * e2e/acceptances.spec.ts.
 */

vi.mock('@/lib/data/preauth', () => ({ invitationByToken: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ tryResolveIdentity: vi.fn(async () => null) }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: InvitationPage } = await import('@/app/(public)/invitations/[token]/page');
const client = await import('@/app/(public)/invitations/[token]/AcceptInvitationClient');
const { default: AcceptInvitationClient, NewAccountView, signUpErrors, registerOutcome, welcomePath } = client;
const { invitationByToken } = await import('@/lib/data/preauth');
const { tryResolveIdentity } = await import('@/lib/auth/identity');
const { PASSWORD_MIN_LENGTH } = await import('@/lib/validate');

const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';
const TEXTS = STUB_LEGAL_TEXTS.slice();
const pendingInvitation: Invitation & { org: { name: string }; invitedBy: { name: string } } = {
  id: 'inv1', orgId: 'org1', email: 'head.of.lab@example.ac.ug', role: 'assessor', tokenHash: 'h'.repeat(64), status: 'pending',
  invitedById: 'u0', expiresAt: new Date('2026-11-04T09:00:00Z'), createdAt: new Date('2026-10-28T09:00:00Z'), acceptedAt: null,
  kind: 'member', linkShownAt: null, requestReference: null, org: { name: 'Makerere CAI Lab' }, invitedBy: { name: 'Amina N.' },
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
    expect(markup).toContain(`<p>${M23}</p>`);
    expect(markup).not.toMatch(/<input|<button|<form/);
    expect(text(markup)).not.toMatch(/invited you as|The invitation expires|Create your account/);       // no organisation, role or inviter name
  });

  it('FR-MEM-01 FR-ACC-01: S-04 shows the inviter\'s account name, the role and the expiry date', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(pendingInvitation);
    const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
    expect(markup).toContain('<h1>You are invited to Makerere CAI Lab</h1>');
    expect(text(markup)).toContain('Amina N. invited you as an assessor. The invitation expires on 4 Nov 2026.');
    expect(markup).toContain('value="head.of.lab@example.ac.ug"');
  });

  it('FR-MEM-01 NFR-SEC-11: the organisation and inviter names are rendered as text', async () => {
    vi.mocked(invitationByToken).mockResolvedValue({ ...pendingInvitation, org: { name: '<script>alert(1)</script>' }, invitedBy: { name: '"><img src=x onerror=alert(1)>' } });
    const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
    expect(markup).not.toMatch(/<script|<img/);
  });

  it('FR-MEM-01: the invited line uses "a" or "an" for the role', async () => {
    for (const [role, article] of [['owner', 'an'], ['admin', 'an'], ['assessor', 'an'], ['reviewer', 'a'], ['viewer', 'a']] as const) {
      vi.mocked(invitationByToken).mockResolvedValue({ ...pendingInvitation, role });
      const markup = html(await InvitationPage({ params: Promise.resolve({ token: 't'.repeat(64) }) }));
      expect(text(markup)).toContain(`Amina N. invited you as ${article} ${role}. The invitation expires on 4 Nov 2026.`);
    }
  });

  it('FR-ACC-01: after creation S-04 lands on the dashboard with welcome=1 and nothing else in the address', () => {
    expect(welcomePath('lab')).toBe('/orgs/lab/dashboard?welcome=1');
    expect(registerOutcome(201, { orgSlug: 'lab' })).toEqual({ kind: 'created', orgSlug: 'lab' });
  });

  it('FR-ACC-01 (7.4.2 S-04): while sending, S-04 shows "Creating your account..."', () => {
    const markup = view({ step: 'acceptances', send: { state: 'sending' } });
    expect(markup).toMatch(/<p[^>]*role="status"[^>]*>Creating your account\.\.\.<\/p>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create account<\/button>/);
  });

  it('FR-ACC-01 (7.4.2 S-04): a lost connection shows the not-created text with Try again', () => {
    const markup = view({ step: 'acceptances', send: { state: 'lost' } });
    expect(text(markup.match(/<div[^>]*role="alert"[^>]*>.*?<\/div>/)?.[0] ?? '')).toBe('Not created: connection lost. Nothing was created. Try again');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
  });

  it('FR-ACC-01 (7.4.2 S-04 validation): an empty name and a short password are named on their fields and nothing is posted', () => {
    expect(signUpErrors('', 'short')).toEqual({ name: 'Name is required', password: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    expect(signUpErrors('  Amina  ', 'a'.repeat(PASSWORD_MIN_LENGTH))).toEqual({});
    const markup = view({ errors: { name: 'Name is required', password: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` } });
    expect(tagOf(markup, 'name')).toContain('aria-invalid="true"');
    expect(tagOf(markup, 'name')).toMatch(/aria-describedby="name-error"/);
    expect(tagOf(markup, 'name-error')).not.toBe('');
    expect(markup).toMatch(/id="name-error"[^>]*>Name is required</);
    expect(tagOf(markup, 'new-password')).toContain('aria-invalid="true"');
    expect(tagOf(markup, 'new-password')).toMatch(/aria-describedby="password-hint password-error"/);
    expect(markup).toMatch(new RegExp(`id="password-error"[^>]*>Password must be at least ${PASSWORD_MIN_LENGTH} characters<`));
    expect(markup).not.toContain('accept-terms');      // still on step 1: the acceptances are not shown
  });

  it('FR-ACC-01: the server answers map to what S-04 shows', () => {
    expect(registerOutcome(410, { error: M23, code: 'invitation_unusable' })).toEqual({ kind: 'message', text: M23 });
    expect(registerOutcome(409, { error: 'An account with this email already exists. Sign in to accept.', code: 'account_exists' }))
      .toEqual({ kind: 'message', text: 'An account with this email already exists. Sign in to accept.' });
    expect(registerOutcome(422, { code: 'validation', error: 'x', fields: [{ field: 'name', message: 'name is required' }] }))
      .toEqual({ kind: 'fields', errors: { name: 'name is required' } });
    expect(registerOutcome(422, { code: 'validation', error: 'To continue, accept the privacy notice.', missing: ['privacy'], fields: [] }))
      .toEqual({ kind: 'message', text: 'To continue, accept the privacy notice.' });
    expect(registerOutcome(503, { error: 'Service unavailable', code: 'database_unavailable' })).toEqual({ kind: 'refused' });
    expect(registerOutcome(500, null)).toEqual({ kind: 'refused' });
  });

  it('M-24: a different signed-in account sees both emails', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail="b@x.test" />);
    expect(text(markup.match(/<p[^>]*role="alert"[^>]*>.*?<\/p>/)?.[0] ?? '')).toBe('You are signed in as b@x.test, but this invitation is for a@x.test. Sign out, then open the link again.');
    expect(markup).toMatch(/<button[^>]*>Sign out<\/button>/);
  });

  it('FR-ACC-01: the invited account, signed in, gets one Accept invitation button', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail="A@x.test" />);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Accept invitation<\/button>/);
    expect(markup).not.toContain('type="password"');
  });

  it('NFR-A11Y-04 FR-ACC-01: the new-account form takes a pasted password and offers the email to password managers', () => {
    const markup = html(<AcceptInvitationClient {...props} viewerEmail={null} />);
    const email = tagOf(markup, 'email');
    expect(email).toMatch(/autocomplete="username"/i);   // react-dom writes the attribute as autoComplete; HTML ignores case
    expect(email).toMatch(/readOnly=""|readonly=""/);
    expect(email).toContain('type="email"');
    expect(markup).toMatch(/<label for="email"[^>]*>Email <span[^>]*>\(from the invitation; cannot be changed\)<\/span><\/label>/);
    const pw = tagOf(markup, 'new-password');
    expect(pw).toMatch(/autocomplete="new-password"/i);
    expect(pw).toContain('type="password"');
    expect(markup).toMatch(/<label for="new-password"[^>]*>Password<\/label>/);
    expect(markup).toMatch(/<label for="name"[^>]*>Your name<\/label>/);
    expect(tagOf(markup, 'name')).toMatch(/autocomplete="name"/i);
    expect(markup).toContain(`At least ${PASSWORD_MIN_LENGTH} characters.`);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Show<\/button>/);
    expect(markup).not.toMatch(/onpaste|oncopy|autocomplete="off"/i);
    expect(markup).toMatch(/Already have an account with this email\? <a href="\/login\?callbackUrl=%2Finvitations%2Ft{64}"[^>]*>Sign in to accept<\/a>/);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
  });

  it('FR-ACC-03: Continue shows the three boxes, unticked, with Create account', () => {
    const markup = view({ step: 'acceptances', name: 'Amina', password: 'a'.repeat(12) });
    expect(markup.match(/<input[^>]*type="checkbox"[^>]*>/g)?.filter((b) => !/\bchecked\b/.test(b))).toHaveLength(3);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Create account<\/button>/);
    expect(markup).toContain('If you do not want to accept, close this page. Nothing has been created.');
    expect(markup).not.toContain('type="password"');      // step 1 is done; the password is kept, not shown again
  });
});
