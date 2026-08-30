import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimitStore, RATE_LIMITS } from '../../lib/rate-limit';

/**
 * Creating organizations is bounded — and bounding it must not bound its
 * siblings.
 *
 * Register row D-107. `POST /api/v1/orgs` matched no key, so it fell to
 * `default` — 60 per minute, per user, with no total cap anywhere:
 * `createOrgForUser` performs no count check and a repo-wide search for a cap
 * identifier finds nothing. The 2026-08-29 triage escalated it once the site
 * went public, because organization slugs are first-come and irreversible
 * (D-201), so unbounded creation is the throughput for squatting a real
 * institution's name.
 *
 * THE TRAP THIS TEST EXISTS FOR. The obvious key, `POST:/api/v1/orgs`, is a
 * literal PREFIX of every org-scoped POST route, and `keyMatches` falls back to
 * `startsWith` when a key contains no `*`. Adding it naively therefore also
 * captures `/orgs/<slug>/projects`, `/orgs/<slug>/members` and every sibling —
 * which was tried once and is recorded in `lib/rate-limit.ts`'s own comment as
 * having made projects and members both resolve to the wrong limit. Segment
 * boundaries do not help either: those routes genuinely sit below this path.
 *
 * Hence exact matching, marked by a trailing `$`. The second assertion is the
 * one that matters — a limit that quietly throttles project creation would be a
 * worse defect than the one being fixed.
 */

beforeEach(() => resetRateLimitStore());

describe('organization creation is rate limited', () => {
  it('has a dedicated rule rather than falling through to default', () => {
    expect(Object.keys(RATE_LIMITS)).toContain('POST:/api/v1/orgs$');
    const rule = RATE_LIMITS['POST:/api/v1/orgs$'];
    expect(rule.keyBy).toBe('userId');
    expect(rule.max).toBeLessThan(RATE_LIMITS['default'].max);
  });

  it('refuses a burst of creations from one account', () => {
    const rule = RATE_LIMITS['POST:/api/v1/orgs$'];
    for (let i = 0; i < rule.max; i++) {
      const r = checkRateLimit('POST', '/api/v1/orgs', '203.0.113.5', 'user-a');
      expect(r.success, `request ${i + 1} of the allowance was refused`).toBe(true);
    }
    expect(
      checkRateLimit('POST', '/api/v1/orgs', '203.0.113.5', 'user-a').success,
      'an account created more organizations than the rule allows',
    ).toBe(false);
  });

  it('does NOT throttle the sibling routes below the same path', () => {
    // The documented regression: /projects and /members are not org creation.
    const rule = RATE_LIMITS['POST:/api/v1/orgs$'];
    for (let i = 0; i < rule.max + 5; i++) {
      const p = checkRateLimit('POST', '/api/v1/orgs/acme/projects', '203.0.113.6', 'user-b');
      expect(p.success, `project creation was throttled by the org-creation rule at request ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < rule.max + 5; i++) {
      const m = checkRateLimit('POST', '/api/v1/orgs/acme/members', '203.0.113.7', 'user-c');
      expect(m.success, `member invitation was throttled by the org-creation rule at request ${i + 1}`).toBe(true);
    }
  });

  it('keys by user, so one account cannot exhaust another account allowance', () => {
    const rule = RATE_LIMITS['POST:/api/v1/orgs$'];
    for (let i = 0; i < rule.max; i++) checkRateLimit('POST', '/api/v1/orgs', '203.0.113.8', 'user-d');
    expect(checkRateLimit('POST', '/api/v1/orgs', '203.0.113.8', 'user-d').success).toBe(false);
    expect(
      checkRateLimit('POST', '/api/v1/orgs', '203.0.113.8', 'user-e').success,
      'a second user sharing the same IP was refused — this is the NAT case the limiter exists to serve',
    ).toBe(true);
  });
});

/**
 * The cap must survive how the value actually arrives.
 *
 * `docker-compose.prod.yml` passes `ORG_LIMIT_PER_USER: ${ORG_LIMIT_PER_USER:-}`
 * so that an unset variable produces no Compose warning. That delivers an EMPTY
 * STRING, not an absent variable — and `Number('')` is `0`, while `?? 5` never
 * fires because `''` is not nullish. Read naively, the cap in production would
 * have been ZERO and every organization creation refused.
 *
 * Caught before deploying, but only by asking what the value looks like on
 * arrival rather than what it looks like in the code.
 */
describe('ORG_LIMIT_PER_USER survives the values it can actually receive', () => {
  const cases: [string, string | undefined, number][] = [
    ['unset', undefined, 5],
    ['empty string, as compose sends it', '', 5],
    ['whitespace', '   ', 5],
    ['not a number', 'lots', 5],
    ['zero, which would lock everyone out', '0', 5],
    ['negative', '-3', 5],
    ['a real override', '12', 12],
  ];
  for (const [label, value, expected] of cases) {
    it(`${label} -> ${expected}`, async () => {
      const prev = process.env.ORG_LIMIT_PER_USER;
      if (value === undefined) delete process.env.ORG_LIMIT_PER_USER;
      else process.env.ORG_LIMIT_PER_USER = value;
      try {
        const mod = await import(`../../lib/data/preauth?cap=${encodeURIComponent(label)}`);
        expect(mod.ORG_LIMIT_PER_USER).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env.ORG_LIMIT_PER_USER;
        else process.env.ORG_LIMIT_PER_USER = prev;
      }
    });
  }
});
