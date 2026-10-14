import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Self-service registration is closed unless explicitly opened.
 *
 * `PLAN.md:217` records this as a LOCKED decision: **D9 — Registration
 * invite-gated until T3**. The shipped code did not implement it. On
 * 2026-08-29, hours after makrai.org went public, `GET /register` returned 200
 * to anyone on the internet and `app/api/auth/register/route.ts` contained no
 * invitation check — one unauthenticated POST created a live user, a live
 * organization and an owner membership, with no email verification, no captcha
 * and no challenge of any kind (a repo-wide grep for captcha/turnstile/
 * emailVerified/verificationToken returned zero hits).
 *
 * WORSE THAN A MISSING CONTROL: the deployment asserted the control existed.
 * `docker/docker-compose.prod.yml:40` reads "Registration is invite-gated (D9)"
 * — describing the members-invite flow, which is a different route
 * (`app/api/v1/invitations/[token]/register/route.ts`) that documents in its own
 * header that it is NOT this one. Anyone reading the config to check the posture
 * would have been told the gate was there.
 *
 * WHY THIS MATTERS BEYOND ONE FREE ACCOUNT. The account is the entry ticket to
 * two other open rows. D-107: nothing caps organization creation — a repo-wide
 * grep for maxOrg/orgLimit/MAX_ORGS returns nothing, and `POST /api/v1/orgs`
 * matches no rate-limit key so it falls to `default`, 60/min. D-201: organization
 * slugs are derived from the name and first-come, so squatting a real
 * institution's slug is irreversible. Free instant accounts are the throughput
 * for both.
 *
 * A FLAG RATHER THAN A DELETION, because D9 says "until T3". Opening
 * registration then must be a configuration change, not a code change — so this
 * test asserts BOTH directions.
 */

const ROUTE_BODY = {
  name: 'Test Person',
  email: 'someone@example.com',
  password: 'a-sufficiently-long-password',
  orgName: 'Some Institution',
};

function req(): NextRequest {
  return new NextRequest('https://makrai.org/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
    body: JSON.stringify(ROUTE_BODY),
  });
}

let original: string | undefined;
beforeEach(() => { original = process.env.ALLOW_OPEN_REGISTRATION; });
afterEach(() => {
  if (original === undefined) delete process.env.ALLOW_OPEN_REGISTRATION;
  else process.env.ALLOW_OPEN_REGISTRATION = original;
});

describe('open registration is closed by default (PLAN.md D9)', () => {
  it('refuses the request when the flag is unset — the production default', async () => {
    delete process.env.ALLOW_OPEN_REGISTRATION;
    const { POST } = await import('../../app/api/auth/register/route');
    const res = await POST(req());
    expect(
      res.status,
      'an unauthenticated stranger could still create a user, an organization and ' +
        'an owner membership on the live site',
    ).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('registration_closed');
  });

  it('refuses on any value that is not exactly "true", so a typo fails closed', async () => {
    // 'false', '1', 'yes', '' must all leave it shut. A gate that opens on
    // anything truthy is a gate that opens on a mistake.
    for (const v of ['false', '1', 'yes', '', 'TRUE ']) {
      process.env.ALLOW_OPEN_REGISTRATION = v;
      const { POST } = await import('../../app/api/auth/register/route');
      const res = await POST(req());
      expect(res.status, `ALLOW_OPEN_REGISTRATION=${JSON.stringify(v)} opened the gate`).toBe(403);
    }
  });

  it('lets the request through when explicitly opened, so T3 is a config change', async () => {
    // Not asserting success -- there is no database here. Asserting only that
    // the GATE is not what stopped it, so this file cannot pass by having
    // broken registration permanently.
    process.env.ALLOW_OPEN_REGISTRATION = 'true';
    const { POST } = await import('../../app/api/auth/register/route');
    let status = 0;
    try { status = (await POST(req())).status; } catch { status = 500; }
    expect(status, 'the gate still blocked the request when explicitly opened').not.toBe(403);
  });
});
