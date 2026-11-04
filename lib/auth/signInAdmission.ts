import { publicOrigin } from '../publicOrigin';
import { logSecurityEvent } from '../security-logger';
import { readKnownDevice } from './knownDevice';

/**
 * The comparison budget and the process-wide ceiling of the credentials POST (FR-ACC-05, calls R-2 and R-49; NFR-SEC-06).
 * One Node process serves the platform (K-5), and a bcrypt comparison at cost 12 is CPU work on that process, so:
 * - at most COMPARISON_SLOTS sign-ins run at once; one of them is kept for a browser with a valid known-device cookie, so
 *   a flood of unknown clients cannot keep an account's holder out;
 * - a request that waits more than SLOT_WAIT_MS for a slot answers 503 `sign_in_busy`;
 * - requests without a known-device cookie count against SIGN_IN_CEILING_PER_MINUTE per fixed minute, process-wide (never
 *   per address: ruling 10); past it they answer 429 `rate_limited` with Retry-After, logged once per minute.
 * The cookie is checked by signature only here (no database read); `lib/auth/credentials.ts` checks its row.
 *
 * Every refusal body carries an absolute `url` with the error code, because `next-auth/react`'s `signIn` parses `data.url`
 * with `new URL` (node_modules/next-auth/react.js, `signIn` with `redirect: false`) and S-01 reads the code from there.
 * State is in this module, as the rate-limit store is (lib/rate-limit.ts): one process.
 */
export const SIGN_IN_CEILING_PER_MINUTE = 300;
export const COMPARISON_SLOTS = 4;
export const RESERVED_FOR_KNOWN = 1;
export const SLOT_WAIT_MS = 2000;

type Waiter = { known: boolean; grant: () => void };

let inUse = 0;
let waiters: Waiter[] = [];
let windowStart = 0;
let windowCount = 0;

/** Tests only: forgets every slot, waiter and count. */
export function resetSignInAdmission(): void {
  inUse = 0;
  waiters = [];
  windowStart = 0;
  windowCount = 0;
}

const mayTake = (known: boolean) => (known ? inUse < COMPARISON_SLOTS : COMPARISON_SLOTS - inUse > RESERVED_FOR_KNOWN);

/** Hands freed slots to waiters in arrival order, skipping a general waiter while only the reserved slot is free. */
function wake(): void {
  for (const w of [...waiters]) {
    if (!mayTake(w.known)) continue;
    waiters = waiters.filter((x) => x !== w);
    inUse += 1;
    w.grant();
  }
}

/**
 * Resolves true once a slot is taken, false after SLOT_WAIT_MS without one. `wake` runs on every release, so no waiter can
 * take a slot that is free now: a request that may take one takes it at once without passing anyone who could have.
 */
function takeSlot(known: boolean): Promise<boolean> {
  if (mayTake(known)) {
    inUse += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((x) => x !== waiter);
      resolve(false);
    }, SLOT_WAIT_MS);
    const waiter: Waiter = { known, grant: () => { clearTimeout(timer); resolve(true); } };
    waiters.push(waiter);
  });
}

function refusal(status: 429 | 503, code: 'rate_limited' | 'sign_in_busy', error: string, extra: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  const url = new URL(`/login?error=${code}`, publicOrigin()).toString();
  return new Response(JSON.stringify({ error, code, ...extra, url }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export async function admitSignIn(req: Request, run: () => Promise<Response>, opts: { now?: () => number } = {}): Promise<Response> {
  const now = (opts.now ?? Date.now)();
  const known = readKnownDevice(req.headers.get('cookie'), new Date(now)) !== null;

  if (!known) {
    const minute = now - (now % 60_000);
    if (minute !== windowStart) {
      windowStart = minute;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > SIGN_IN_CEILING_PER_MINUTE) {
      if (windowCount === SIGN_IN_CEILING_PER_MINUTE + 1) {
        logSecurityEvent('RATE_LIMIT_EXCEEDED', 'warn', {
          details: { pathname: new URL(req.url).pathname, method: req.method, limit: SIGN_IN_CEILING_PER_MINUTE },
        });
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((minute + 60_000 - now) / 1000));
      return refusal(429, 'rate_limited', 'Too many requests. Please try again later.', { retryAfterSeconds }, { 'Retry-After': String(retryAfterSeconds) });
    }
  }

  if (!(await takeSlot(known))) {
    return refusal(503, 'sign_in_busy', 'Sign-in is busy. Try again in a minute.', {});
  }
  try {
    return await run();
  } finally {
    inUse -= 1;
    wake();
  }
}
