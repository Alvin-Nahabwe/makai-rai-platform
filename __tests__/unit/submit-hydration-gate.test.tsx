import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * NFR-SEC password-in-URL (unit FIXPW). Each form that carries a credential or an email address names method="post"
 * and keeps its submit button disabled until React has hydrated, so a native submit before then does nothing. These
 * render each view with `hydrated={false}` (the server render's value) and with the prop left out (a static render of
 * the view alone), and read the submit button's `disabled` attribute. vitest runs in `node`, so the markup is the evidence.
 */
vi.mock('@/lib/data/preauth', () => ({ invitationByToken: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ tryResolveIdentity: vi.fn(async () => null) }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), getSession: vi.fn(), signOut: vi.fn() }));

const { LoginView } = await import('@/app/(public)/login/LoginClient');
const { ForgotPasswordView, ForgotPasswordClient } = await import('@/app/(public)/forgot-password/ForgotPasswordClient');
const { ResetPasswordView } = await import('@/app/(public)/reset-password/ResetPasswordClient');
const { ChangePasswordView, ChangePasswordForm } = await import('@/app/(gate)/change-password/ChangePasswordForm');
const { NewAccountView, default: AcceptInvitationClient } = await import('@/app/(public)/invitations/[token]/AcceptInvitationClient');
const { CreateOrganisationFormView, CreateOrganisationForm } = await import('@/components/admin/CreateOrganisationForm');
const { IssueInvitationFormView } = await import('@/components/admin/OwnerInvitationBox');

const noop = () => {};
/** The opening tag of the form's submit button. */
const submitTag = (markup: string) => markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
const formTag = (markup: string) => markup.match(/<form[^>]*>/)?.[0] ?? '';

const NewAccount = (over: Record<string, unknown>) => (
  <NewAccountView token={'t'.repeat(64)} invitedEmail="a@x.test" orgName="Lab" role="assessor" inviterName="Amina N." expiresOn="2026-11-09"
    texts={STUB_LEGAL_TEXTS.slice()} viewerEmail={null} step="details" name="" password="" showPassword={false} errors={{}} send={{ state: 'idle' }}
    onName={noop} onPassword={noop} onToggleShow={noop} onContinue={noop} onAccepted={async () => {}} onRetry={noop} {...over} />);

const views: Array<[string, (over: Record<string, unknown>) => React.ReactElement]> = [
  ['S-01 sign in', (o) => <LoginView email="" password="" showPassword={false} error="" notice={null} loading={false}
    onEmail={noop} onPassword={noop} onToggleShow={noop} onSubmit={noop} {...o} />],
  ['S-02 forgot password', (o) => <ForgotPasswordView email="" state={{ kind: 'idle' }} onEmail={noop} onSubmit={noop} {...o} />],
  ['S-03 reset password', (o) => <ResetPasswordView token={'t'.repeat(20)} password="" showPassword={false} state={{ kind: 'idle' }}
    onPassword={noop} onToggleShow={noop} onSubmit={noop} {...o} />],
  ['S-29 change password', (o) => <ChangePasswordView forced={false} currentPassword="" newPassword="" show={false} state={{ kind: 'idle' }}
    onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} {...o} />],
  ['S-04 create account', (o) => NewAccount(o)],
  ['S-24 create organisation', (o) => <CreateOrganisationFormView draft={{ name: '', legalName: '', ownerEmail: '', showLink: false }} errors={{}}
    status="" busy={false} result={null} onChange={noop} onSubmit={noop} onRetry={noop} {...o} />],
  ['S-24 issue first-owner invitation', (o) => <IssueInvitationFormView formId="f" draft={{ email: '', requestReference: '', showLink: false }}
    errors={{}} busy={false} onDraft={noop} onSubmit={noop} onCancel={noop} {...o} />],
];

describe('submit buttons wait for hydration (NFR-SEC)', () => {
  for (const [name, render] of views) {
    it(`NFR-SEC: ${name}: method="post", submit disabled while hydrated is false, enabled when true or not given`, () => {
      const early = renderToStaticMarkup(render({ hydrated: false }));
      expect(formTag(early)).toMatch(/\smethod="post"/);
      expect(submitTag(early)).toMatch(/\sdisabled(=""|\s|>)/);
      for (const over of [{ hydrated: true }, {}]) expect(submitTag(renderToStaticMarkup(render(over)))).not.toMatch(/\sdisabled(=""|\s|>)/);
    });
  }
});

/**
 * The containers own the hook: a view test cannot see `hydrated={hydrated}` dropped from the container. A server render
 * is the pre-hydration state, so each container, rendered whole, must show a disabled submit button.
 */
describe('containers pass the hydration state to their view (NFR-SEC)', () => {
  const containers: Array<[string, () => React.ReactElement]> = [
    ['S-02 ForgotPasswordClient', () => <ForgotPasswordClient />],
    ['S-29 ChangePasswordForm', () => <ChangePasswordForm forced={false} />],
    ['S-04 AcceptInvitationClient (signed out)', () => <AcceptInvitationClient token={'t'.repeat(64)} invitedEmail="a@x.test" orgName="Lab" role="assessor"
      inviterName="Amina N." viewerEmail={null} viewerUserId={null} expiresOn="2026-11-09" texts={STUB_LEGAL_TEXTS.slice()} />],
    ['S-24 CreateOrganisationForm', () => <CreateOrganisationForm />],
  ];
  for (const [name, element] of containers) {
    it(`NFR-SEC: ${name}: rendered whole, its submit button is disabled`, () => {
      expect(submitTag(renderToStaticMarkup(element()))).toMatch(/\sdisabled(=""|\s|>)/);
    });
  }
});

/**
 * S-22's invite form names its fields (the kit's TextInput, Select and Checkbox require `name`), so a native submit
 * before hydration would post a third person's email address and role to the page (plan 1A Task 19 fix round 1;
 * security review M1). A server render is the pre-hydration state: the manager, rendered whole, must show its submit
 * button disabled. The browser specs press Invite after hydration (e2e/members.spec.ts).
 */
describe('S-22 invite form waits for hydration (NFR-SEC)', () => {
  it('NFR-SEC: S-22 MembersManager: rendered whole, the invite form is method="post" and its submit button is disabled', async () => {
    const { default: MembersManager } = await import('@/app/(authenticated)/orgs/[slug]/settings/members/MembersManager');
    const { memberRoleWords } = await import('@/lib/org/copy');
    const html = renderToStaticMarkup(<MembersManager slug="acme" currentUserId="u-1" currentRole="owner" invitations={[]} roleWords={memberRoleWords()}
      members={[{ userId: 'u-1', name: 'Nakato Sarah', role: 'owner', joinedAt: '2026-10-01T00:00:00.000Z', createdFromShownLink: false }]} />);
    const form = /<form[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(form).toContain('name="email"');
    expect(formTag(form)).toMatch(/\smethod="post"/);
    expect(submitTag(form)).toMatch(/\sdisabled(=""|\s|>)/);
  });
});
