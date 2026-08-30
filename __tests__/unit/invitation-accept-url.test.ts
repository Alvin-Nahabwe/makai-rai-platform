import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Invitation links must point at the site, not at the container.
 *
 * `app/api/v1/orgs/[slug]/members/route.ts:100` built the accept URL from
 * `req.nextUrl.origin`. Behind nginx that is the origin the APP sees, not the
 * one the recipient can reach: the standalone server binds to
 * `process.env.HOSTNAME`, which Docker sets to the container id (register row
 * D-236), so the emails carried
 *
 *     https://1038b2a33d91:3000/invitations/<token>
 *
 * Found on 2026-08-30 by the owner sending a real invitation — the first time
 * the application's own send path had ever run. The email arrived; the link went
 * nowhere. Every invitation sent before this fix was undeliverable in the same
 * way, and nothing would have reported it: the route logs `invite_email_failed`
 * only when the SEND fails, and this send succeeded.
 *
 * The origin therefore comes from configuration, never from the request. Same
 * reasoning as `lib/auth/secureCookie.ts`: a value the recipient depends on must
 * not be derived from a header or a socket that only the server can see.
 */

let original: string | undefined;
beforeEach(() => { original = process.env.NEXTAUTH_URL; });
afterEach(() => {
  if (original === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = original;
});

describe('publicOrigin', () => {
  it('uses the configured public origin', async () => {
    process.env.NEXTAUTH_URL = 'https://makrai.org';
    const { publicOrigin } = await import('../../lib/publicOrigin');
    expect(publicOrigin()).toBe('https://makrai.org');
  });

  it('drops any path, so a configured base path cannot corrupt the link', async () => {
    process.env.NEXTAUTH_URL = 'https://makrai.org/some/path';
    const { publicOrigin } = await import('../../lib/publicOrigin');
    expect(publicOrigin()).toBe('https://makrai.org');
  });

  it('throws rather than guessing when nothing is configured', async () => {
    // The alternative is falling back to the request, which is exactly the bug.
    // A loud failure at send time is better than an email nobody can act on.
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
    const { publicOrigin } = await import('../../lib/publicOrigin');
    expect(() => publicOrigin()).toThrow(/NEXTAUTH_URL/);
  });
});

describe('invitationAcceptUrl', () => {
  it('builds a link on the public origin, not on whatever the server sees', async () => {
    process.env.NEXTAUTH_URL = 'https://makrai.org';
    const { invitationAcceptUrl } = await import('../../lib/publicOrigin');
    expect(invitationAcceptUrl('abc123')).toBe('https://makrai.org/invitations/abc123');
  });

  it('never produces a container-shaped host', async () => {
    // Guards the exact observed failure: a 12-hex-character docker hostname
    // with an internal port.
    process.env.NEXTAUTH_URL = 'https://makrai.org';
    const { invitationAcceptUrl } = await import('../../lib/publicOrigin');
    const url = invitationAcceptUrl('t');
    expect(url).not.toMatch(/:3000/);
    expect(url).not.toMatch(/\/\/[0-9a-f]{12}\b/);
  });
});
