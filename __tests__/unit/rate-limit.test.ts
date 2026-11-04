import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { checkRateLimit, resetRateLimitStore, RATE_LIMITS } from '../../lib/rate-limit';

/**
 * Task 6, O-18. `findConfig`'s matcher (lib/rate-limit.ts) picks a
 * RATE_LIMITS entry by "longest key such that `${method}:${path}`.startsWith(key)".
 * The brief's suggested new key, 'POST:/api/v1/orgs', is broken under that
 * rule: it is a literal PREFIX of every org-scoped POST route (projects,
 * members and any upload route alike), because the
 * org slug is a free variable sitting between '/api/v1/orgs' and every
 * route's distinguishing suffix -- `startsWith` cannot skip over it no
 * matter what literal string follows. Empirically confirmed (task-6-report.md):
 * injecting that exact key made EVERY org-scoped POST path resolve to
 * limit=10, including /projects and /members.
 *
 * The fix (this file pins both halves): `findConfig`'s key MAY contain a
 * '*' segment standing for exactly one non-empty path segment, used ONLY
 * for keys that contain '*' -- every pre-existing key has none, so the
 * ORIGINAL `key.startsWith(k)` code path is untouched for all four of them
 * and cannot regress. The block below pins that; the block after proves the
 * wildcard mechanism matches ONLY the route its key names, across multiple
 * orgs and object ids, and not projects, members, a sibling collection route
 * or a sibling sub-resource.
 *
 * The score removal (RM) deleted the only production wildcard key, the
 * assessment evidence upload. The mechanism outlives it (the project
 * evidence upload key uses the same '*' form), so the block below installs a
 * synthetic key of the same shape for its own duration and removes it again.
 */

beforeEach(() => {
  resetRateLimitStore();
});

describe('rate-limit matcher: pre-existing keys are unaffected (regression)', () => {
  it('NFR-SEC-06: no key names a sign-in path any more, so the limiter itself would give one the default rule (proxy.ts skips them)', () => {
    expect(Object.keys(RATE_LIMITS).filter((k) => k.includes('/api/auth'))).toEqual([]);
    expect(checkRateLimit('POST', '/api/auth/callback/credentials', '1.2.3.4', null).limit).toBe(RATE_LIMITS.default.max);
  });

  it('exact match: DELETE /api/users/me still resolves to its own entry (max 1)', () => {
    const r = checkRateLimit('DELETE', '/api/users/me', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(1);
  });

  it('unrelated path still falls through to default (max 60)', () => {
    const r = checkRateLimit('GET', '/api/v1/orgs/acme-corp/projects', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(60);
  });
});

describe('rate-limit matcher: a wildcard upload key (O-18)', () => {
  const PROBE_KEY = 'POST:/api/v1/orgs/*/probes/*/upload';

  beforeAll(() => {
    RATE_LIMITS[PROBE_KEY] = { window: 60 * 1000, max: 10, keyBy: 'userId' };
  });

  afterAll(() => {
    delete RATE_LIMITS[PROBE_KEY];
  });

  it('matches POST .../upload for org A', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/probes/018f2a3e-uuid-1/upload',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(10);
  });

  it('matches POST .../upload for a DIFFERENT org and a different object id -- proves the wildcard segments generalise, not just the one fixture path', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/fixture-org-b/probes/another-uuid-2/upload',
      '5.6.7.8',
      'user-2',
    );
    expect(r.limit).toBe(10);
  });

  it('does NOT match POST .../projects (the brief\'s own named must-not-match case)', () => {
    const r = checkRateLimit('POST', '/api/v1/orgs/acme-corp/projects', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(60);
  });

  it('does NOT match POST .../members (the brief\'s own named must-not-match case)', () => {
    const r = checkRateLimit('POST', '/api/v1/orgs/acme-corp/members', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(60);
  });

  it('does NOT match POST .../probes (the collection route) -- narrower than the brief required, not just "not projects/members"', () => {
    const r = checkRateLimit('POST', '/api/v1/orgs/acme-corp/probes', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(60);
  });

  it('does NOT match POST .../probes/[id]/complete -- same sub-resource family, still excluded', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/probes/018f2a3e-uuid-1/complete',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(60);
  });

  it('does NOT match GET on the same upload path -- method-specific, not path-only', () => {
    const r = checkRateLimit(
      'GET',
      '/api/v1/orgs/acme-corp/probes/018f2a3e-uuid-1/upload',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(60);
  });

  it('enforces max: 10 -- the 11th request in the window fails, the first 10 succeed', () => {
    const path = '/api/v1/orgs/acme-corp/probes/window-probe/upload';
    let last;
    for (let i = 0; i < 10; i++) {
      last = checkRateLimit('POST', path, '1.2.3.4', 'user-window');
      expect(last.success).toBe(true);
    }
    const eleventh = checkRateLimit('POST', path, '1.2.3.4', 'user-window');
    expect(eleventh.success).toBe(false);
  });

  /**
   * silent-failure-hunter finding (task-6-report.md, D-151): the config
   * LOOKUP is correctly scoped by the wildcard key (proven above), but the
   * STORE key `checkRateLimit` builds is `${identifier}:${method}:${path}`
   * -- the RAW request path, assessment id included. A caller who varies
   * the assessment id gets a FRESH counter every time and is never bounded
   * in aggregate, even though every request matches the SAME rate-limit
   * rule. Empirically confirmed by the agent before this fix: 20 requests
   * across 2 assessment ids (10 each) all succeeded against a max of 10;
   * 50 requests across 50 distinct ids all succeeded.
   */
  it('aggregates the count across DIFFERENT object ids for the same user -- the 11th request anywhere in this route fails, not just the 11th on one object', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(
        'POST',
        `/api/v1/orgs/acme-corp/probes/distinct-id-${i}/upload`,
        '1.2.3.4',
        'user-aggregate',
      );
      expect(r.success).toBe(true);
    }
    // Still the SAME user, but yet another assessment id -- must be the
    // 11th against ONE shared budget, not the 1st against a fresh one.
    const eleventh = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/probes/distinct-id-10/upload',
      '1.2.3.4',
      'user-aggregate',
    );
    expect(eleventh.success).toBe(false);
  });

  it('aggregates the count across DIFFERENT orgs for the same user -- the org slug is also collapsed, not just the object id', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(
        'POST',
        `/api/v1/orgs/org-${i}/probes/shared-object/upload`,
        '1.2.3.4',
        'user-aggregate-2',
      );
      expect(r.success).toBe(true);
    }
    const eleventh = checkRateLimit(
      'POST',
      '/api/v1/orgs/org-10/probes/shared-object/upload',
      '1.2.3.4',
      'user-aggregate-2',
    );
    expect(eleventh.success).toBe(false);
  });

  it('keeps counting DIFFERENT users separately -- the aggregation fix must not merge across users', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('POST', `/api/v1/orgs/acme/probes/a-${i}/upload`, '1.2.3.4', 'user-x');
    }
    // A different user, hitting the SAME matched rule, must start fresh.
    const r = checkRateLimit('POST', '/api/v1/orgs/acme/probes/a-0/upload', '1.2.3.4', 'user-y');
    expect(r.success).toBe(true);
  });
});

describe('rate-limit store key: pre-existing (non-wildcard) entries keep bucketing by the RAW path (regression)', () => {
  // The aggregation fix below is intentionally scoped to wildcard-matched
  // keys only. Collapsing 'default' (which EVERY otherwise-unmatched route
  // shares) to one shared budget per user is a
  // broad behaviour change this task does not have the authority or the
  // reach-assessment to make unilaterally -- D-151 records this explicitly
  // as the reason those entries are OUT of this fix's scope, not an
  // oversight.
  it('"default" still gives each distinct path its own budget (unchanged)', () => {
    for (let i = 0; i < 60; i++) {
      const r = checkRateLimit('GET', '/api/v1/orgs/acme/projects', '9.9.9.9', 'user-default-regress');
      expect(r.success).toBe(true);
    }
    const sixtyFirstSamePath = checkRateLimit(
      'GET',
      '/api/v1/orgs/acme/projects',
      '9.9.9.9',
      'user-default-regress',
    );
    expect(sixtyFirstSamePath.success).toBe(false);

    // A DIFFERENT path, same user, same 'default' rule: still a fresh
    // budget -- this is the exact "default" behaviour D-151 leaves alone.
    const differentPath = checkRateLimit(
      'GET',
      '/api/v1/orgs/acme/members',
      '9.9.9.9',
      'user-default-regress',
    );
    expect(differentPath.success).toBe(true);
  });

});
