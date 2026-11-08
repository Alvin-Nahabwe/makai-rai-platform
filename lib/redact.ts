import { format } from 'node:util';
import { EMAIL_SHAPE_SOURCE } from './email-shape';

export { EMAIL_SHAPE_SOURCE };

/**
 * No email address in any server log line (RL 2.3, 7.12; P1).
 *
 * The audit trail (`logSecurityEvent`) no longer names an address, but an address can still
 * arrive from somewhere that is not ours to edit: a provider's error string ("You can only
 * send testing emails to your own email address (owner@example.org)"), Prisma's
 * `Key (email)=(...) already exists`, a stack trace, Next's own error printing. So the last
 * layer is a redactor on what is about to be written, and it works on the finished text.
 *
 * Node only. It imports `node:util`, and `instrumentation.ts` loads it inside its Node.js
 * branch, as it does the database module, so the edge bundle never sees it.
 */

const REDACTED = '[email-redacted]';

const EMAIL_SHAPE = new RegExp(EMAIL_SHAPE_SOURCE, 'g');

/**
 * The same expression with `%40`, an "@" percent-encoded, in place of the "@": how an address
 * looks in a path or a query string (`/login?email=user%40example.org`). Derived from the one
 * source, so the two cannot drift. The shell scan does not have this form (an "@" decoded into
 * nginx's `$uri` is what it sees there); only the redactor does.
 */
const ENCODED_SHAPE = new RegExp(EMAIL_SHAPE_SOURCE.replace('@', '%40'), 'gi');

/** A maximal run of the characters an address is made of: both halves, and the "@". */
const ADDRESS_RUN = /[A-Za-z0-9._%+@-]+/g;

/**
 * The longest run the expression is applied to. An address is at most 254 characters
 * (RFC 5321), so a run of address characters longer than this and carrying an "@" (or a
 * `%40`) is not one, and could be hiding one. 256 leaves room for a character either side.
 *
 * Why runs at all: the expression is quadratic on a long unbroken run. `"a".repeat(64_000)
 * + "@"` takes seconds in V8, and a request header can be 16 KB (about 0.3 s). This runs on
 * every log line, so whoever controls a logged string must not control its cost. An address
 * is made only of address characters, so none can span two runs; applying the expression run
 * by run finds exactly the matches it finds on the whole string (the fuzz test in
 * `redact.test.ts` holds that), and the cost is bounded by this length times the text: 1 MB
 * of runs just under the cap is about 0.25 s, and the test holds it under 2 s.
 */
const MAX_RUN = 256;

/**
 * Replaces every email-shaped substring of `s` with `[email-redacted]`, in its plain form
 * (`user@example.org`) and its percent-encoded form (`user%40example.org`).
 */
export function redactText(s: string): string {
  if (!s.includes('@') && !s.includes('%40')) return s;
  return s.replace(ADDRESS_RUN, (run) => {
    const plain = run.includes('@');
    const encoded = run.includes('%40');
    if (!plain && !encoded) return run;
    if (run.length > MAX_RUN) return REDACTED;
    let out = run;
    if (plain) out = out.replace(EMAIL_SHAPE, REDACTED);
    if (encoded) out = out.replace(ENCODED_SHAPE, REDACTED);
    return out;
  });
}

/** How deep a logged value is followed. Real entries are three or four levels. */
const MAX_DEPTH = 32;

function copy(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  // A logger must not throw from inside the failure it is reporting.
  if (ancestors.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';

  ancestors.add(value);
  try {
    // Follow `toJSON` the way JSON.stringify does, so a Date is still a string and a value
    // whose toJSON produces an address is redacted instead of trusted.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return copy(toJSON.call(value), ancestors, depth + 1);
    if (Array.isArray(value)) return value.map((v) => copy(v, ancestors, depth + 1));
    // Own enumerable string keys: what JSON.stringify would write. `fromEntries` defines
    // each as a plain property, so a key called "__proto__" stays data.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redactText(k), copy(v, ancestors, depth + 1)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/**
 * A deep copy of `value` with every string, and every key, passed through `redactText`.
 * Never changes its argument. Shaped for `JSON.stringify`: what that would have written for
 * the original, it writes for the copy, apart from the addresses.
 */
export function redactEmails(value: unknown): unknown {
  return copy(value, new WeakSet(), 0);
}

/**
 * An invitation link carries a bearer token in the path: `/invitations/<token>` and
 * `/api/v1/invitations/<token>[/...]`. Nothing in a log line may be a secret (NFR-OBS-01, NFR-PRIV-03),
 * so a logged path names the route and not the token. This is nginx's rule for its access log, the `$log_uri`
 * map in docker/nginx/default.conf. `__tests__/unit/redact-path-for-log.test.ts` parses that rule out of the conf
 * and checks both give the same output over a corpus of paths, so a change to either that alters one of them
 * fails there; a path outside the corpus is not covered. Anchored at the start, so the ids in `/api/v1/orgs/<slug>/invitations/<id>/resend` stay as they are.
 */
const INVITATION_TOKEN_PATH = /^(\/(?:api\/v1\/)?invitations\/)[^/]+(.*)$/;

/** `pathname` with an invitation token replaced by `[token]`; every other path unchanged. */
export function redactPathForLog(pathname: string): string {
  return pathname.replace(INVITATION_TOKEN_PATH, '$1[token]$2');
}

const WRAPPED = Symbol.for('makrai.consoleRedaction');

/**
 * Wraps `log`, `info`, `warn` and `error` so that what they print has been through
 * `redactText`. Each is replaced with `(...a) => orig(redactText(util.format(...a)))`: the
 * arguments are formatted exactly as Node would, once, and the finished string is redacted,
 * so an address inside an Error's message and stack, an object, or a `%s` argument is found
 * wherever it sits. The original receives one string, so nothing downstream formats an
 * address back in.
 *
 * Idempotent: a method already wrapped is left alone, because Next calls `register()` once
 * per server instance and a dev reload can call it again.
 *
 * Direct writes to `process.stdout` / `process.stderr` are not covered, by design: neither
 * Next's server nor our own code makes any (`__tests__/lint/no-email-in-log-calls.test.ts`
 * holds that for our code; the report for this change records it for Next's).
 */
export function installConsoleRedaction(
  target: Pick<Console, 'log' | 'info' | 'warn' | 'error'> = console,
): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = target[method];
    if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) continue;
    const wrapped = (...args: unknown[]): void => {
      original.call(target, redactText(format(...(args as Parameters<typeof format>))));
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    target[method] = wrapped;
  }
}
