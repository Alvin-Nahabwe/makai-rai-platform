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
   * No key for sign-in (SRS FR-ACC-05, NFR-SEC-06, ruling 10): the two address-keyed keys `POST:/api/auth/register` and
   * `POST:/api/auth` are gone, and `proxy.ts` skips this limiter for every path `isSignInPath` names, so sign-in never
   * meets the `default` rule either (unauthenticated, it keys on the address). Many people sign in from one institutional
   * address. Sign-in is limited per account (lib/auth/credentials.ts) and by the process-wide admission
   * (lib/auth/signInAdmission.ts). The register route answers 404 for every method (FR-ACC-01).
   */
  'DELETE:/api/users/me': { window: 60 * 60 * 1000, max: 1, keyBy: 'userId' },
  /**
   * D-107. Organization creation was unbounded: it matched no key, fell to
   * `default` at 60/min, and nothing capped the total. Organization slugs are
   * derived from the name and first-come, so an account creating them freely is
   * the throughput for squatting a real institution's slug (D-201) --
   * irreversible, and the reason this is a limit rather than a nicety.
   *
   * The trailing '$' is load-bearing: without it this key is a prefix of every
   * org-scoped POST route and would throttle projects and members too.
   *
   * Five an hour is generous for the real case -- a person joining a second or
   * third institution -- and useless for bulk squatting. It is a burst control,
   * not the bound; `ORG_LIMIT_PER_USER` in `lib/data/preauth.ts` is the bound.
   */
  'POST:/api/v1/orgs$': { window: 60 * 60 * 1000, max: 5, keyBy: 'userId' },
  /**
   * v0.6.0 (contract "Rate-limit keys"; SRS 6.2 and NFR-SEC-20). A `*` key matches any longer path, so the
   * documents key also counts `.../documents/preview`: ten issues and previews an hour together. The old
   * assessment evidence key above goes with RM's route removal.
   *
   * No key for invitations or `members/leave`: a `*` key on `POST:/api/v1/orgs/*\/members` would also count
   * `members/leave` and would not count `invitations/*\/resend`, while FR-MEM-01 limits invitations "20 an
   * hour per inviter and 100 a day per organisation, resends included". MEM counts invitation rows in its
   * service, and `members/leave` falls to `default`.
   */
  'POST:/api/v1/orgs/*/projects/*/evidence': { window: 60 * 1000, max: 10, keyBy: 'userId' },
  'POST:/api/v1/orgs/*/projects/*/reviews/*/documents': { window: 60 * 60 * 1000, max: 10, keyBy: 'userId' },
  'POST:/api/v1/orgs/*/projects/*/reviews/*/seals': { window: 60 * 60 * 1000, max: 20, keyBy: 'userId' },
  'GET:/api/v1/orgs/*/projects/*/reviews/*/seals/*/check': { window: 60 * 60 * 1000, max: 20, keyBy: 'userId' },
  /**
   * The team export of the organisation and of one project share this key: one route. For a request with
   * `Sec-Fetch-Mode: navigate`, `proxy.ts` answers a refusal with a 303 to S-20 instead of its JSON 429.
   */
  'GET:/api/v1/orgs/*/export': { window: 60 * 60 * 1000, max: 3, keyBy: 'userId' },
  'GET:/api/users/me/export': { window: 60 * 60 * 1000, max: 3, keyBy: 'userId' },
  'default': { window: 60 * 1000, max: 60, keyBy: 'userId' },
};

/**
 * True for every path under `/api/auth/`: NextAuth's routes (the credentials POST, csrf, session, signout, providers) and
 * the removed register route. `proxy.ts` does not rate-limit these by address (FR-ACC-05, NFR-SEC-06).
 */
export function isSignInPath(path: string): boolean {
  return path.startsWith('/api/auth/');
}

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
 * behaviour and none of the original entries (users/me delete, default)
 * can regress; __tests__/unit/rate-limit.test.ts
 * pins that.
 *
 * A key MAY instead contain one or more '*' path segments (e.g.
 * 'POST:/api/v1/orgs/*\/projects/*\/evidence'), each standing for
 * exactly one arbitrary, NON-EMPTY path segment. This exists because a
 * plain literal prefix cannot skip over a variable segment (an org slug, a
 * project id) to reach a fixed suffix beyond it: injecting the bare
 * 'POST:/api/v1/orgs' made /projects and /members both resolve to the same
 * limit (task-6-report.md). Segment count must be >= the key's (mirrors
 * the original `startsWith`'s "the target may continue past the key" prefix
 * semantics);
 * every non-'*' key segment must match literally, and every '*' segment
 * requires a non-empty (but otherwise arbitrary) target segment at that
 * position.
 */
function keyMatches(target: string, k: string): boolean {
  // A trailing '$' means EXACT, and it exists for one shape the other two
  // cannot express: a route that is a strict prefix of its own siblings.
  // 'POST:/api/v1/orgs' is org CREATION, but every org-scoped POST route
  // -- projects, members -- starts with that same string, so the
  // `startsWith` below captures all of them. '*' does not help either: it
  // stands for a segment that must be PRESENT, and creation has no segment
  // after 'orgs'. Injecting the bare key once made /projects and /members both
  // resolve to the wrong limit (task-6-report.md); this is the form that does
  // not.
  if (k.endsWith('$')) return target === k.slice(0, -1);
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
 * Matches by method:path prefix (e.g., DELETE:/api/users/me matches DELETE:/api/users/me/...),
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
   * pre-existing key ('DELETE:/api/users/me', 'default') contains no '*',
   * so this branch is
   * unreached for them and their bucketing is BYTE-FOR-BYTE unchanged --
   * verified by __tests__/unit/rate-limit.test.ts's regression block.
   * Collapsing 'default' the SAME way would
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
