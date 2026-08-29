import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetRateLimitStore, RATE_LIMITS } from '../../lib/rate-limit';

/**
 * The proxy trusts exactly ONE header for client identity.
 *
 * Stage 5 of the Cloudflare setup makes nginx restore the real client address
 * from `CF-Connecting-IP` and write it into `X-Forwarded-For`, OVERWRITING
 * whatever the client sent rather than appending to it. That is only safe
 * because the Hetzner Cloud Firewall now admits Cloudflare alone -- confirmed
 * 2026-08-29, check 1b returned 521 from a Cloudflare address while a direct
 * request from elsewhere timed out.
 *
 * The application half of that change is this: read `x-forwarded-for` and
 * nothing else. A PREFERENCE CHAIN is the defect, not the individual headers.
 * The previous code read
 *   `x-forwarded-for` ?? `x-real-ip` ?? '127.0.0.1'
 * so any request arriving without an `x-forwarded-for` -- which the attacker
 * controls simply by not sending one -- handed identity selection to
 * `x-real-ip`, which the attacker also controls. A fallback chain does not
 * degrade to the safest option; it degrades to whichever option the attacker
 * can still reach.
 *
 * WHAT THIS ASSERTS. Two runs of an IP-keyed rule with NO `x-forwarded-for`
 * and DIFFERENT `x-real-ip` values. If `x-real-ip` is consulted they are two
 * buckets and the attacker gets a fresh allowance per forged value. If it is
 * ignored they are one bucket and the limit holds.
 */

/** max 15 per 15 min, keyBy ip -- lib/rate-limit.ts:53 */
const IP_KEYED_PATH = '/api/auth/callback/credentials';

beforeEach(() => resetRateLimitStore());

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest(`https://makrai.org${IP_KEYED_PATH}`, { method: 'POST', headers });
}

describe('the proxy takes client identity from one header only', () => {
  it('ignores x-real-ip, so forging it cannot buy a fresh rate-limit bucket', async () => {
    const { proxy } = await import('../../proxy');
    const max = RATE_LIMITS['POST:/api/auth'].max;

    // Exhaust the bucket with no x-forwarded-for at all.
    for (let i = 0; i < max; i++) {
      await proxy(req({ 'x-real-ip': '203.0.113.30' }));
    }

    // Same shape, different x-real-ip. Consulting it would open a new bucket.
    const forged = await proxy(req({ 'x-real-ip': '203.0.113.31' }));
    expect(
      forged.status,
      'changing x-real-ip produced a fresh rate-limit allowance, so the proxy ' +
        'is still consulting it as a fallback -- an attacker omits ' +
        'x-forwarded-for and then picks their own identity',
    ).toBe(429);
  });

  it('still separates genuinely different clients by x-forwarded-for', async () => {
    // Guards the over-correction: collapsing everyone into one bucket would
    // also pass the assertion above, while breaking the limiter for real users.
    const { proxy } = await import('../../proxy');
    const max = RATE_LIMITS['POST:/api/auth'].max;

    for (let i = 0; i < max; i++) {
      await proxy(req({ 'x-forwarded-for': '203.0.113.40' }));
    }
    const other = await proxy(req({ 'x-forwarded-for': '203.0.113.41' }));
    expect(other.status, 'a different real client must get its own bucket').not.toBe(429);
  });
});
