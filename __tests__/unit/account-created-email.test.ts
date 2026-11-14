import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { MARKER_PATTERN, markerFor } from '../helpers/markers';
import { EMAIL_COPY } from '@/lib/email/copy';
import { escapeHtml } from '@/lib/email/escape';

const URL_ = 'https://makrai.example/forgot-password';
const textOf = (org: string) =>
  [`${EMAIL_COPY.accountCreated.intro(org, '2 Nov 2026')}\n${URL_}`, EMAIL_COPY.accountCreated.closing(org)].join('\n\n');
const htmlOf = (org: string) =>
  [
    `<p>${EMAIL_COPY.accountCreated.intro(escapeHtml(org), '2 Nov 2026')}</p>`,
    `<p><a href="${URL_}">${URL_}</a></p>`,
    `<p>${EMAIL_COPY.accountCreated.closing(escapeHtml(org))}</p>`,
  ].join('\n');

/**
 * E-06 (FR-ACC-10, SRS 7.5.9 line 2606): the notice to an invited address that an account was
 * created for it. SRS 6.1 rules 1 to 3: no record text, no email address in a link, the
 * organisation name escaped in the HTML part.
 */

const { accountCreatedEmail } = await import('@/lib/email/templates/accountCreated');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E-06, the account-created notice (FR-ACC-10)', () => {
  it('FR-ACC-10 (6.1): E-06 holds no marker, escapes the organisation name, and links only to the reset page', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    const m = accountCreatedEmail({ orgName: HOSTILE_STRINGS[0], createdAt: new Date('2026-11-02T08:00:00Z') });
    expect(m.subject).toBe(EMAIL_COPY.accountCreated.subject);
    expect(m.text).toBe(textOf(HOSTILE_STRINGS[0]));
    expect(m.html).toBe(htmlOf(HOSTILE_STRINGS[0]));
    expect(m.html).not.toContain('<script>');
    expect([...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual(['https://makrai.example/forgot-password']);
    expect(m.text).not.toMatch(MARKER_PATTERN);
  });

  it('FR-ACC-10 NFR-SEC-11: every hostile organisation name is escaped in the HTML and carried as text in the text part', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    for (const orgName of HOSTILE_STRINGS) {
      const m = accountCreatedEmail({ orgName, createdAt: new Date('2026-11-02T08:00:00Z') });
      // The only elements are the paragraphs and the one link: the name arrives as escaped text.
      expect([...m.html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((x) => x[1])).toEqual(['p', 'p', 'a', 'p']);
      expect(m.text).toBe(textOf(orgName));
      expect(m.html).toBe(htmlOf(orgName));
      expect([...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual(['https://makrai.example/forgot-password']);
      expect(m.text).toContain(orgName);
      expect(m.subject).not.toContain(orgName);
    }
  });

  it('FR-ACC-10 (6.1): the organisation name is the only variable text; a marked name never reaches the subject', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    const m = accountCreatedEmail({ orgName: markerFor('orgName', 1), createdAt: new Date('2026-11-02T08:00:00Z') });
    expect(m.subject).not.toMatch(MARKER_PATTERN);
    expect(m.html).toBe(htmlOf(markerFor('orgName', 1)));
  });

  it('16d: the text part is the ruled words, the link alone on its line, no other character after it (A 224)', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    const m = accountCreatedEmail({ orgName: 'Lab & <Co>', createdAt: new Date('2026-11-02T08:00:00Z') });
    expect(m.text).toBe(
      'An account for this email address was created on the MAK-AI RAI Platform on 2 Nov 2026. It is a member of Lab & <Co>. If you did not create it, reset the password now:\n' +
        'https://makrai.example/forgot-password\n\nThen tell the Owner of Lab & <Co>.',
    );
    expect(m.text.split('\n').filter((l) => l.includes('https://'))).toEqual(['https://makrai.example/forgot-password']);
    expect(m.html).toContain('Lab &amp; &lt;Co&gt;');
  });
});
