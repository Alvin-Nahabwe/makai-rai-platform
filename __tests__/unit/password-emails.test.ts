import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordChangedEmail } from '../../lib/email/templates/passwordChanged';
import { passwordResetEmail } from '../../lib/email/templates/passwordReset';
import { MARKER_PATTERN } from '../helpers/markers';

/**
 * E-02 (FR-ACC-09, SRS line 2601) and E-03 (FR-ACC-06, SRS line 2602). SRS 6.1: no record text and no email address in
 * either; E-02's one link is S-02, whose address carries nothing (obligation B16); E-03's one link is S-03 with the token
 * after `#`, so it never reaches a server log (B9).
 */
beforeEach(() => { vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example'); });
afterEach(() => { vi.unstubAllEnvs(); });

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);

describe('E-02 and E-03', () => {
  it('FR-ACC-09 (6.1): E-02 holds no marker and links only to the reset page', () => {
    const m = passwordChangedEmail({ changedAt: new Date('2026-11-02T07:05:00Z') });
    expect(m.subject).toBe('Your MAK-AI RAI Platform password was changed');
    expect(m.text).toBe('The password for your account was changed on 2 Nov 2026 at 07:05 UTC. If this was not you, reset your password now: https://makrai.example/forgot-password, and tell your organisation\'s owner.');
    expect(hrefs(m.html)).toEqual(['https://makrai.example/forgot-password']);
    expect(m.html).toContain('2 Nov 2026 at 07:05 UTC');
    expect(`${m.subject}${m.text}${m.html}`).not.toMatch(MARKER_PATTERN);
    expect(`${m.text}${m.html}`).not.toMatch(/@/);
  });

  it('FR-ACC-09: E-02 writes the time in UTC whatever the process zone', () => {
    vi.stubEnv('TZ', 'Africa/Kampala');
    expect(passwordChangedEmail({ changedAt: new Date('2026-11-02T23:30:00Z') }).text).toContain('on 2 Nov 2026 at 23:30 UTC.');
  });

  it('FR-ACC-06 NFR-OBS-01: E-03 carries the link with the token after # and the 30-minute rule', () => {
    const resetUrl = `https://makrai.example/reset-password#token=${'a'.repeat(64)}`;
    const m = passwordResetEmail({ resetUrl });
    expect(m.subject).toBe('Reset your MAK-AI RAI Platform password');
    expect(m.text).toBe(`Use this link to set a new password: ${resetUrl}. It works once and expires in 30 minutes. If you did not ask for this, you can ignore this email; nothing will change.`);
    expect(hrefs(m.html)).toEqual([resetUrl]);
    expect(`${m.text}${m.html}`).not.toMatch(/@/);
  });

  it('FR-ACC-06: E-03 escapes the link in its HTML part', () => {
    const m = passwordResetEmail({ resetUrl: 'https://makrai.example/reset-password#token="><script>' });
    expect(m.html).not.toContain('<script>');
  });
});
