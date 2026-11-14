import { describe, it, expect } from 'vitest';
import { invitationEmail } from '../../lib/email/templates';
import { EMAIL_COPY } from '../../lib/email/copy';
import { roleWithArticle } from '../../lib/org/copy';
import { escapeHtml } from '../../lib/email/escape';

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
    role: 'assessor' as const,
    acceptUrl: 'https://example.org/invitations/abc123token',
    expiresAt: new Date('2026-11-04T09:00:00Z'),
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
    expect(content.text).toContain('an Assessor');
    expect(content.html).toContain('<strong>an Assessor</strong>');
    expect(content.text).not.toContain('assessor');
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

  it('FR-MEM-01: E-01 names the organisation, the role and the expiry date, never the inviter', () => {
    const c = invitationEmail({ orgName: 'Lab <A>', role: 'reviewer', acceptUrl: 'https://h/invitations/t', expiresAt: new Date('2026-11-04T09:00:00Z') });
    expect(c.subject).toBe(EMAIL_COPY.invitation.subject('Lab <A>'));
    expect(c.subject).toBe('You are invited to Lab <A> on the MAK-AI RAI Platform');
    expect(c.html).toContain('Lab &lt;A&gt;');
    expect(c.text).not.toMatch(/invited by/i);
  });

  const ROLES = [
    ['owner', 'an Owner'],
    ['admin', 'an Admin'],
    ['assessor', 'an Assessor'],
    ['reviewer', 'a Reviewer'],
    ['viewer', 'a Viewer'],
  ] as const;

  it.each(ROLES)('16d: the whole text part and HTML part for the %s role, with & and < in the organisation name', (role, sentence) => {
    const orgName = 'Lab & <Co>';
    const c = invitationEmail({ ...input, orgName, role });
    expect(roleWithArticle(role)).toBe(sentence);
    expect(c.text).toBe(
      [
        EMAIL_COPY.invitation.intro(orgName, sentence),
        `${EMAIL_COPY.invitation.linkLead}\n${input.acceptUrl}`,
        EMAIL_COPY.invitation.closing('4 Nov 2026'),
      ].join('\n\n'),
    );
    expect(c.html).toBe(
      [
        `<p>${EMAIL_COPY.invitation.intro(`<strong>${escapeHtml(orgName)}</strong>`, `<strong>${sentence}</strong>`)}</p>`,
        `<p>${EMAIL_COPY.invitation.linkLead}</p>`,
        `<p><a href="${input.acceptUrl}">${input.acceptUrl}</a></p>`,
        `<p>${EMAIL_COPY.invitation.closing('4 Nov 2026')}</p>`,
      ].join('\n'),
    );
    // The two real line breaks of the rendered text, and a link alone on its line.
    expect(c.text.split('\n')).toEqual(expect.arrayContaining([input.acceptUrl, '']));
    expect(c.text.split('\n').filter((l) => l.includes('https://'))).toEqual([input.acceptUrl]);
  });

  it('16d: the rendered text reads as the ruled words (A 221, 222)', () => {
    const c = invitationEmail(input);
    expect(c.text).toBe(
      'You are invited to join Acme Corp on the MAK-AI RAI Platform. Research teams use the platform to record decisions about their AI systems. You will join as an Assessor.\n\n' +
        'To accept, open this link:\nhttps://example.org/invitations/abc123token\n\n' +
        'The link works once. It stops working on 4 Nov 2026. If you did not expect this email, you can ignore it.',
    );
  });

  it('16d: the HTML part has one link and it is the accept link', () => {
    const c = invitationEmail(input);
    expect([...c.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([input.acceptUrl]);
  });

  it('16d: no sentence of EMAIL_COPY holds a character HTML escapes, so one sentence serves both parts', () => {
    const all: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') all.push(v);
      else if (typeof v === 'function') all.push((v as (...a: string[]) => string)('A', 'B'));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(EMAIL_COPY);
    expect(all.length).toBeGreaterThan(15);
    for (const s of all) expect(escapeHtml(s), s).toBe(s);
  });
});
