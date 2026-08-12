/**
 * In-memory sliding window rate limiter.
 * Dual-key: uses userId for authenticated routes, IP for pre-auth routes.
 * NAT-aware: designed for shared-IP classroom deployments.
 */

type KeyBy = 'ip' | 'userId';

interface RateLimitConfig {
  window: number;   // milliseconds
  max: number;      // max requests in window
  keyBy: KeyBy;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  /**
   * D-195/D-199/D-200. Raised from 5 to 50, 2026-08-10, on the human
   * partner's ruling. **THIS IS NOT AN ADVERSARIAL CONTROL, and raising it
   * does not make it one.** `proxy.ts`'s `ip` is read from client-settable
   * `x-forwarded-for`/`x-real-ip` with no trusted-proxy allowlist -- live
   * measured, 7/7 requests accepted with a rotated header, never refused
   * (see the Task 4 threat derivation,
   * `docs/security/2026-08-10-registration-rate-limit-threat-derivation.md`,
   * S2.2). Against an adversary who varies the header, this number is
   * unbounded regardless of its value. Its ONLY job is ergonomics: how
   * many honest people sharing one real NAT egress address (an
   * institutional network) can each create an organization inside one
   * window, by ATTEMPTS not accounts, before a typo/duplicate/double-submit
   * consumes their shared budget. 50 is chosen, not derived: 15 is the
   * floor that clears the e2e suite's own registration traffic with slack
   * (10 calls today, isolated onto its own bucket in
   * e2e/security.spec.ts); 50 covers a ~40-person cohort each registering
   * with room for retries. The CPU ceiling, not abuse, bounds how high this
   * could go: bcryptjs hash(cost=12) measured at 230ms mean -- 50 accepted
   * registrations from one IP costs ~11.5 CPU-seconds per 15-minute window,
   * negligible. The population this number is actually missing an owner
   * for -- an adversary willing to fabricate a header -- is D-199
   * (trusted-proxy allowlist, blocked on D-018) and D-200 (email
   * verification, the control this derivation argues should exist
   * instead). If you are about to raise this again because a newly-added
   * test went red, STOP: that is the exact governance failure this comment
   * exists to name (see the derivation's S8, "the cap acquires a new owner
   * and never returns") -- a suite-driven change to this number needs the
   * same fresh S7.1 threat pass as any other change to a security-adjacent
   * literal, not a one-line bump to turn a check green.
   */
  'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 50, keyBy: 'ip' },
  'POST:/api/auth': { window: 15 * 60 * 1000, max: 15, keyBy: 'ip' },
  'DELETE:/api/users/me': { window: 60 * 60 * 1000, max: 1, keyBy: 'userId' },
  /**
   * O-18. Default is 60/min per user -- correct to have a limit, wrong
   * value for a byte-accepting endpoint (design spec §3.3). The brief's own
   * suggested key, 'POST:/api/v1/orgs', is a literal PREFIX of every
   * org-scoped POST route (projects, members, assessments-create alike),
   * not just this one: the org slug is a free variable sitting between
   * '/api/v1/orgs' and every route's distinguishing suffix, so no fixed
   * string can isolate one route from its siblings under plain
   * `startsWith` -- empirically confirmed in task-6-report.md (injecting
   * that exact key made /projects and /members both resolve to limit=10).
   * '*' (see `keyMatches` below) stands for exactly one arbitrary
   * non-empty path segment, letting this key skip over the org slug AND
   * the assessment id without widening to match either sibling route.
   */
  'POST:/api/v1/orgs/*/assessments/*/evidence': { window: 60 * 1000, max: 10, keyBy: 'userId' },
  'default': { window: 60 * 1000, max: 60, keyBy: 'userId' },
};

const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 60 seconds
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 60_000);
}

/**
 * Does `target` (the real "METHOD:/path" string for this request) match
 * config key `k`? Keys with no '*' are matched EXACTLY as before --
 * `target.startsWith(k)` -- so this branch is byte-for-byte the pre-existing
 * behaviour and none of the four original entries (register, generic auth,
 * users/me delete, default) can regress; __tests__/unit/rate-limit.test.ts
 * pins that.
 *
 * A key MAY instead contain one or more '*' path segments (e.g.
 * 'POST:/api/v1/orgs/*\/assessments/*\/evidence'), each standing for
 * exactly one arbitrary, NON-EMPTY path segment. This exists because a
 * plain literal prefix cannot skip over a variable segment (an org slug, an
 * assessment id) to reach a fixed suffix beyond it -- see the RATE_LIMITS
 * entry's own comment for the empirical proof that no fixed string solves
 * this. Segment count must be >= the key's (mirrors the original
 * `startsWith`'s "the target may continue past the key" prefix semantics);
 * every non-'*' key segment must match literally, and every '*' segment
 * requires a non-empty (but otherwise arbitrary) target segment at that
 * position.
 */
function keyMatches(target: string, k: string): boolean {
  if (!k.includes('*')) return target.startsWith(k);

  const kSegs = k.split('/');
  const tSegs = target.split('/');
  if (tSegs.length < kSegs.length) return false;
  return kSegs.every((seg, i) => (seg === '*' ? tSegs[i].length > 0 : tSegs[i] === seg));
}

/**
 * Find the matching rate limit config for a request, alongside the exact
 * RATE_LIMITS key that matched -- `checkRateLimit` needs the matched key
 * itself (not just its config) to fix D-151 (see there, and the store-key
 * comment below) without touching how any OTHER key buckets its counter.
 * Matches by method:path prefix (e.g., POST:/api/auth matches POST:/api/auth/callback/credentials),
 * or by method:path pattern for a key containing '*' segments (see `keyMatches`).
 */
function findConfig(method: string, path: string): { config: RateLimitConfig; matchedKey: string } {
  const key = `${method}:${path}`;

  // Exact match first
  if (RATE_LIMITS[key]) return { config: RATE_LIMITS[key], matchedKey: key };

  // Prefix/pattern match (longest key first)
  const prefixMatches = Object.entries(RATE_LIMITS)
    .filter(([k]) => k !== 'default' && keyMatches(key, k))
    .sort((a, b) => b[0].length - a[0].length);

  if (prefixMatches.length > 0) {
    return { config: prefixMatches[0][1], matchedKey: prefixMatches[0][0] };
  }

  return { config: RATE_LIMITS['default'], matchedKey: 'default' };
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
  /**
   * True on the FIRST refused request in a window, false on every later
   * one (and on every successful request). Added for `proxy.ts`'s
   * `RATE_LIMIT_EXCEEDED` logging: emitting a line per refused request
   * makes log volume track attack volume 1:1, with attacker-controlled
   * values in each line, because `count` keeps incrementing past `max`
   * long after the limiter starts refusing. The transition carries the
   * whole signal an operator needs -- the limit was breached, by which
   * identifier, on which path, and when the window resets -- so this lets
   * a caller log once per window instead.
   *
   * Deliberately computed HERE rather than by the caller: `count` is
   * module-private state, and the only way a caller could derive this
   * itself is by keeping a second, parallel tally that could drift from
   * this one. Purely additive -- no existing field changes value, and no
   * existing caller has to read it.
   */
  firstRefusal: boolean;
}

/**
 * Check rate limit for a request.
 * @param method HTTP method (GET, POST, etc.)
 * @param path Request path
 * @param ip Client IP address
 * @param userId Authenticated user ID (null for pre-auth requests)
 */
export function checkRateLimit(
  method: string,
  path: string,
  ip: string,
  userId: string | null,
): RateLimitResult {
  const { config, matchedKey } = findConfig(method, path);
  const identifier = config.keyBy === 'userId' && userId ? userId : ip;
  /**
   * D-151 (found by `pr-review-toolkit:silent-failure-hunter` during Task
   * 6, verified live before this fix: 20 requests split across 2
   * assessment ids, 10 each, both succeeded against a max of 10; 50
   * requests across 50 distinct ids all succeeded). The bug: bucketing by
   * the RAW request `path` gives every distinct assessment id (or org
   * slug) its own fresh counter, so a rule meant to bound "10 uploads per
   * user per minute" bounded nothing in aggregate -- an attacker pays
   * nothing to mint a new budget (any UUID-shaped string works; the route
   * does not even need a REAL assessment id to reach this check, since
   * rate limiting runs in proxy.ts before the handler validates anything).
   *
   * Fixed ONLY for wildcard-matched keys (`matchedKey.includes('*')`) --
   * bucketing by the MATCHED KEY instead of the literal path collapses
   * exactly the variable segments '*' stands for (org slug, assessment id),
   * which is what makes the aggregate budget mean something. Every
   * pre-existing key ('POST:/api/auth/register', 'POST:/api/auth',
   * 'DELETE:/api/users/me', 'default') contains no '*', so this branch is
   * unreached for them and their bucketing is BYTE-FOR-BYTE unchanged --
   * verified by __tests__/unit/rate-limit.test.ts's regression block.
   * Collapsing 'default' or the 'POST:/api/auth' prefix the SAME way would
   * merge budgets across every route/provider that currently falls under
   * them, a broad behaviour change this task has no reach-assessment for;
   * D-151 stays open, scoped to that remaining, pre-existing pattern.
   */
  const storeKey = matchedKey.includes('*')
    ? `${identifier}:${matchedKey}`
    : `${identifier}:${method}:${path}`;
  const now = Date.now();

  let entry = store.get(storeKey);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + config.window };
    store.set(storeKey, entry);
  }

  entry.count++;

  const remaining = Math.max(0, config.max - entry.count);
  const success = entry.count <= config.max;

  return {
    success,
    remaining,
    resetAt: new Date(entry.resetAt),
    limit: config.max,
    // Exactly `max + 1` is the first request this window that could not be
    // served. The window reset above (`entry.resetAt <= now`) rebuilds the
    // entry with `count: 0`, so this becomes true again once per window
    // rather than only once ever.
    firstRefusal: entry.count === config.max + 1,
  };
}

/** Reset rate limit store — for testing only. */
export function resetRateLimitStore(): void {
  store.clear();
}
