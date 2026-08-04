import { describe, it, expect } from 'vitest';
import { invitationEmail } from '../../lib/email/templates';

/**
 * Task 9: `lib/email/templates.ts` holds the invitation body as a pure
 * function — no I/O, no network, no env reads — so it is testable without
 * touching the real Resend transport at all. These tests exercise the
 * template directly, mirroring how `resolveOrgDispatch`
 * (__tests__/unit/org-dispatch.test.ts) tests a pure decision core.
 */
describe('invitationEmail', () => {
  const input = {
    orgName: 'Acme Corp',
    role: 'assessor',
    acceptUrl: 'https://example.org/invitations/abc123token',
  };

  it('returns a subject naming the organization', () => {
    const content = invitationEmail(input);
    expect(content.subject).toContain('Acme Corp');
  });

  it('embeds the accept URL in both the html and text bodies', () => {
    const content = invitationEmail(input);
    expect(content.html).toContain(input.acceptUrl);
    expect(content.text).toContain(input.acceptUrl);
  });

  it('names the invited role in the body', () => {
    const content = invitationEmail(input);
    expect(content.text).toContain('assessor');
    expect(content.html).toContain('assessor');
  });

  it('HTML-escapes an org name containing markup, so a malicious org name cannot inject into the email HTML', () => {
    const content = invitationEmail({
      ...input,
      orgName: '<script>alert(1)</script>',
    });
    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('is a pure function: same input produces byte-identical output on repeated calls', () => {
    const a = invitationEmail(input);
    const b = invitationEmail(input);
    expect(a).toEqual(b);
  });
});
