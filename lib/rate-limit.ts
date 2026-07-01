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
  'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 5, keyBy: 'ip' },
  'POST:/api/auth': { window: 15 * 60 * 1000, max: 15, keyBy: 'ip' },
  'DELETE:/api/users/me': { window: 60 * 60 * 1000, max: 1, keyBy: 'userId' },
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
 * Find the matching rate limit config for a request.
 * Matches by method:path prefix (e.g., POST:/api/auth matches POST:/api/auth/callback/credentials).
 */
function findConfig(method: string, path: string): RateLimitConfig {
  const key = `${method}:${path}`;

  // Exact match first
  if (RATE_LIMITS[key]) return RATE_LIMITS[key];

  // Prefix match (longest first)
  const prefixMatches = Object.entries(RATE_LIMITS)
    .filter(([k]) => k !== 'default' && key.startsWith(k))
    .sort((a, b) => b[0].length - a[0].length);

  if (prefixMatches.length > 0) return prefixMatches[0][1];

  return RATE_LIMITS['default'];
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
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
  const config = findConfig(method, path);
  const identifier = config.keyBy === 'userId' && userId ? userId : ip;
  const storeKey = `${identifier}:${method}:${path}`;
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
  };
}

/** Reset rate limit store — for testing only. */
export function resetRateLimitStore(): void {
  store.clear();
}
