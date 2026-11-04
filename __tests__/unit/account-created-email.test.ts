import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { MARKER_PATTERN, markerFor } from '../helpers/markers';

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
    expect(m.subject).toBe('An account was created for this address');
    expect(m.text).toBe(`An account was created for this address in ${HOSTILE_STRINGS[0]} on 2 Nov 2026. If this was not you, reset your password: https://makrai.example/forgot-password, and tell the organisation's owner.`);
    expect(m.html).not.toContain('<script>');
    expect([...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual(['https://makrai.example/forgot-password']);
    expect(m.text).not.toMatch(MARKER_PATTERN);
  });

  it('FR-ACC-10 NFR-SEC-11: every hostile organisation name is escaped in the HTML and carried as text in the text part', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    for (const orgName of HOSTILE_STRINGS) {
      const m = accountCreatedEmail({ orgName, createdAt: new Date('2026-11-02T08:00:00Z') });
      // The only elements are the paragraph and its one link: the name arrives as escaped text.
      expect([...m.html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((x) => x[1])).toEqual(['p', 'a']);
      expect([...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual(['https://makrai.example/forgot-password']);
      expect(m.text).toContain(orgName);
      expect(m.subject).not.toContain(orgName);
    }
  });

  it('FR-ACC-10 (6.1): the organisation name is the only variable text; a marked name never reaches the subject', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    const m = accountCreatedEmail({ orgName: markerFor('orgName', 1), createdAt: new Date('2026-11-02T08:00:00Z') });
    expect(m.subject).not.toMatch(MARKER_PATTERN);
    expect(m.html).toBe(`<p>An account was created for this address in ${markerFor('orgName', 1)} on 2 Nov 2026. If this was not you, reset your password: <a href="https://makrai.example/forgot-password">https://makrai.example/forgot-password</a>, and tell the organisation&#39;s owner.</p>`);
  });
});
