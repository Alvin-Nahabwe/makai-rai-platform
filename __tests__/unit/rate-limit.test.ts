import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimitStore } from '../../lib/rate-limit';

/**
 * Task 6, O-18. `findConfig`'s matcher (lib/rate-limit.ts) picks a
 * RATE_LIMITS entry by "longest key such that `${method}:${path}`.startsWith(key)".
 * The brief's suggested new key, 'POST:/api/v1/orgs', is broken under that
 * rule: it is a literal PREFIX of every org-scoped POST route (projects,
 * members, assessments, this route's evidence upload alike), because the
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
 * new wildcard key ('POST:/api/v1/orgs/*\/assessments/*\/evidence') matches
 * ONLY this route, across multiple orgs/assessments, and not projects,
 * members, assessment-create, or assessment-complete.
 */

beforeEach(() => {
  resetRateLimitStore();
});

describe('rate-limit matcher: pre-existing keys are unaffected (regression)', () => {
  it('exact match: POST /api/auth/register still resolves to its own entry (max 5)', () => {
    const r = checkRateLimit('POST', '/api/auth/register', '1.2.3.4', null);
    expect(r.limit).toBe(5);
  });

  it('prefix match: POST /api/auth/callback/credentials still resolves via the "POST:/api/auth" prefix (max 15), per the function\'s own documented example', () => {
    const r = checkRateLimit('POST', '/api/auth/callback/credentials', '1.2.3.4', null);
    expect(r.limit).toBe(15);
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

describe('rate-limit matcher: the new evidence-upload key (O-18)', () => {
  it('matches POST .../evidence for org A', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/assessments/018f2a3e-uuid-1/evidence',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(10);
  });

  it('matches POST .../evidence for a DIFFERENT org and a different assessment id -- proves the wildcard segments generalise, not just the one fixture path', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/fixture-org-b/assessments/another-uuid-2/evidence',
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

  it('does NOT match POST .../assessments (create) -- narrower than the brief required, not just "not projects/members"', () => {
    const r = checkRateLimit('POST', '/api/v1/orgs/acme-corp/assessments', '1.2.3.4', 'user-1');
    expect(r.limit).toBe(60);
  });

  it('does NOT match POST .../assessments/[id]/complete -- same assessment sub-resource family, still excluded', () => {
    const r = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/assessments/018f2a3e-uuid-1/complete',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(60);
  });

  it('does NOT match GET on the same evidence path -- method-specific, not path-only', () => {
    const r = checkRateLimit(
      'GET',
      '/api/v1/orgs/acme-corp/assessments/018f2a3e-uuid-1/evidence',
      '1.2.3.4',
      'user-1',
    );
    expect(r.limit).toBe(60);
  });

  it('enforces max: 10 -- the 11th request in the window fails, the first 10 succeed', () => {
    const path = '/api/v1/orgs/acme-corp/assessments/window-probe/evidence';
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
  it('aggregates the count across DIFFERENT assessment ids for the same user -- the 11th request anywhere in this route fails, not just the 11th on one assessment', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(
        'POST',
        `/api/v1/orgs/acme-corp/assessments/distinct-id-${i}/evidence`,
        '1.2.3.4',
        'user-aggregate',
      );
      expect(r.success).toBe(true);
    }
    // Still the SAME user, but yet another assessment id -- must be the
    // 11th against ONE shared budget, not the 1st against a fresh one.
    const eleventh = checkRateLimit(
      'POST',
      '/api/v1/orgs/acme-corp/assessments/distinct-id-10/evidence',
      '1.2.3.4',
      'user-aggregate',
    );
    expect(eleventh.success).toBe(false);
  });

  it('aggregates the count across DIFFERENT orgs for the same user -- the org slug is also collapsed, not just the assessment id', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(
        'POST',
        `/api/v1/orgs/org-${i}/assessments/shared-assessment/evidence`,
        '1.2.3.4',
        'user-aggregate-2',
      );
      expect(r.success).toBe(true);
    }
    const eleventh = checkRateLimit(
      'POST',
      '/api/v1/orgs/org-10/assessments/shared-assessment/evidence',
      '1.2.3.4',
      'user-aggregate-2',
    );
    expect(eleventh.success).toBe(false);
  });

  it('keeps counting DIFFERENT users separately -- the aggregation fix must not merge across users', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('POST', `/api/v1/orgs/acme/assessments/a-${i}/evidence`, '1.2.3.4', 'user-x');
    }
    // A different user, hitting the SAME matched rule, must start fresh.
    const r = checkRateLimit('POST', '/api/v1/orgs/acme/assessments/a-0/evidence', '1.2.3.4', 'user-y');
    expect(r.success).toBe(true);
  });
});

describe('rate-limit store key: pre-existing (non-wildcard) entries keep bucketing by the RAW path (regression)', () => {
  // The aggregation fix below is intentionally scoped to wildcard-matched
  // keys only. Collapsing 'default' (which EVERY otherwise-unmatched route
  // shares) or the 'POST:/api/auth' prefix (whose sub-paths may carry
  // different-provider OAuth callbacks) to one shared budget per user is a
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
      '/api/v1/orgs/acme/assessments',
      '9.9.9.9',
      'user-default-regress',
    );
    expect(differentPath.success).toBe(true);
  });

  it('"POST:/api/auth" prefix entry still gives each distinct sub-path its own budget (unchanged)', () => {
    for (let i = 0; i < 15; i++) {
      const r = checkRateLimit('POST', '/api/auth/callback/credentials', '9.9.9.9', null);
      expect(r.success).toBe(true);
    }
    const sixteenth = checkRateLimit('POST', '/api/auth/callback/credentials', '9.9.9.9', null);
    expect(sixteenth.success).toBe(false);

    // A different provider callback, same prefix rule: still a fresh budget.
    const differentProvider = checkRateLimit('POST', '/api/auth/callback/google', '9.9.9.9', null);
    expect(differentProvider.success).toBe(true);
  });
});
