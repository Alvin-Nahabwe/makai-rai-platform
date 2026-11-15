import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Invitation } from '@prisma/client';
import { STUB_LEGAL_TEXTS } from '../../helpers/legalStub';
import { textOf } from '../../helpers/markup';

vi.mock('@/lib/data/preauth', () => ({ invitationByToken: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ tryResolveIdentity: vi.fn(async () => null) }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: InvitationPage } = await import('@/app/(public)/invitations/[token]/page');
const { NewAccountView } = await import('@/app/(public)/invitations/[token]/AcceptInvitationClient');
const { invitationByToken } = await import('@/lib/data/preauth');
const { tryResolveIdentity } = await import('@/lib/auth/identity');
const { INVITATION_PAGE_COPY, roleTerm } = await import('@/lib/org/copy');
const { INVITATION_COPY } = await import('@/lib/invitations/copy');
const { TERM_ASSESSOR } = await import('@/lib/vocabulary/terms');
const { GATE_COPY } = await import('@/lib/shell/copy');

/**
 * Plan 1B Task 6 (rulings L5-14, L5-15): S-04 in the gate frame's public variant. The card says who invited the person, as
 * what, what that role means (the vocabulary's sentence), and until when; the frame's route is this door's steps. An
 * unusable link shows M-23 under its heading and nothing about the organisation, role or inviter, in the card or the frame.
 */
const TOKEN = 't'.repeat(64);
const invitation: Invitation & { org: { name: string; slug: string }; invitedBy: { name: string } } = {
  id: 'inv1', orgId: 'org1', email: 'head.of.lab@example.ac.ug', role: 'assessor', tokenHash: 'h'.repeat(64), status: 'pending',
  invitedById: 'u0', expiresAt: new Date('2026-11-04T09:00:00Z'), createdAt: new Date('2026-10-28T09:00:00Z'), acceptedAt: null,
  kind: 'member', linkShownAt: null, requestReference: null, org: { name: 'Makerere CAI Lab', slug: 'makerere-cai-lab' }, invitedBy: { name: 'Amina N.' },
};
type FrameProps = { variant: string; route?: ReadonlyArray<{ label: string; state: string }> };
const page = async () => (await InvitationPage({ params: Promise.resolve({ token: TOKEN }) })) as ReactElement<FrameProps>;

beforeEach(() => {
  vi.mocked(invitationByToken).mockReset();
  vi.mocked(tryResolveIdentity).mockResolvedValue(null);
});

describe('S-04 in the gate frame (plan 1B Task 6)', () => {
  it('S-04 explains the role with its vocabulary sentence, after the invited line and before the end date', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(invitation);
    const text = textOf(renderToStaticMarkup(await page()));
    expect(text).toContain(TERM_ASSESSOR.definition);
    expect(roleTerm('assessor')).toBe(TERM_ASSESSOR);
    const invited = text.indexOf(INVITATION_PAGE_COPY.invitedBy('Amina N.', 'an Assessor'));
    const meaning = text.indexOf(TERM_ASSESSOR.definition);
    const ends = text.indexOf(INVITATION_PAGE_COPY.endsOn('4 Nov 2026'));
    expect(invited).toBeGreaterThan(-1);
    expect(meaning).toBeGreaterThan(invited);
    expect(ends).toBeGreaterThan(meaning);
    expect(INVITATION_PAGE_COPY.invitedBy('Amina N.', 'an Assessor')).toBe('Amina N. invited you to join as an Assessor.');
  });

  it('L5-14: signed out, the frame\'s route is the three steps of a new account, the first current', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(invitation);
    const el = await page();
    expect(el.props.variant).toBe('public');
    expect(el.props.route).toEqual([
      { label: INVITATION_PAGE_COPY.stops.details, state: 'current' },
      { label: GATE_COPY.stops.accept, state: 'upcoming' },
      { label: INVITATION_PAGE_COPY.stops.join, state: 'upcoming' },
    ]);
  });

  it('L5-14: signed in as the invited email, the one step left is Join; signed in as someone else (M-24), no route', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(invitation);
    vi.mocked(tryResolveIdentity).mockResolvedValue({ userId: 'u1', email: 'Head.Of.Lab@example.ac.ug', name: 'H', platformRole: 'assessor', mustChangePassword: false });
    expect((await page()).props.route).toEqual([{ label: INVITATION_PAGE_COPY.stops.join, state: 'current' }]);
    vi.mocked(tryResolveIdentity).mockResolvedValue({ userId: 'u2', email: 'someone@else.test', name: 'S', platformRole: 'assessor', mustChangePassword: false });
    expect((await page()).props.route).toBeUndefined();
  });

  it('T6.1: an unusable link shows only M-23 under its heading: no route, and nothing about the organisation, role or inviter', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(null);
    const el = await page();
    expect(el.props.variant).toBe('public');
    expect(el.props.route).toBeUndefined();
    const markup = renderToStaticMarkup(el);
    expect(markup).toContain(`<h1>${INVITATION_PAGE_COPY.unusableHeading}</h1>`);
    expect(textOf(markup)).toContain(INVITATION_PAGE_COPY.unusable);
    expect(markup).not.toMatch(/<input|<button|<form|gate-route/);
    expect(textOf(markup)).not.toMatch(/invited you to join|This invitation ends|Create your account|Assessor|Your details/);
  });

  it('T6.3: the token appears in no heading or visible text', async () => {
    vi.mocked(invitationByToken).mockResolvedValue(invitation);
    expect(textOf(renderToStaticMarkup(await page()))).not.toContain(TOKEN);
  });
});

describe('the new-account form (F17, A row 173)', () => {
  const html = renderToStaticMarkup(<NewAccountView token={TOKEN} invitedEmail="a@x.test" orgName="Lab" role="assessor" inviterName="A"
    viewerEmail={null} expiresOn="2026-11-09" texts={STUB_LEGAL_TEXTS.slice()} step="details" name="" password="" showPassword={false}
    errors={{}} send={{ state: 'idle' }} onName={vi.fn()} onPassword={vi.fn()} onToggleShow={vi.fn()} onContinue={vi.fn()}
    onAccepted={vi.fn(async () => {})} onRetry={vi.fn()} />);
  const tag = (id: string) => html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';

  it('F17: email is the read-only username, name is autocomplete="name", password is new-password', () => {
    expect(tag('email')).toMatch(/autoComplete="username"|autocomplete="username"/i);
    expect(tag('email')).toMatch(/readonly/i);
    expect(tag('name')).toMatch(/autocomplete="name"/i);
    expect(tag('new-password')).toMatch(/autocomplete="new-password"/i);
  });

  it('A row 173: the name hint says colleagues see it and it cannot be changed', () => {
    expect(INVITATION_COPY.nameHint).toBe('Your colleagues will see this name. You cannot change it later.');
    expect(textOf(html)).toContain(INVITATION_COPY.nameHint);
  });
});
