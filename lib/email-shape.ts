/**
 * The one email-shape expression, as text. No imports, so anything may use it, including
 * `lib/validate.ts` (which has no Node dependency) and `lib/redact.ts` (which has one).
 *
 * `ops/host/email-shape.regex` holds this same text. `makrai-email-scan.sh` (and Task 22's
 * export) read that file with `grep -E`, and `redactText` runs this constant through
 * JavaScript. They are held equal by `__tests__/unit/redact.test.ts`, and the two engines
 * are shown to agree on a corpus by `__tests__/lint/email-scan.test.ts`. Edit them together
 * or not at all (D-09).
 *
 * `lib/validate.ts` also requires a whole address to match it, so that every address the
 * platform accepts is one the redactor and the scan can see.
 */
export const EMAIL_SHAPE_SOURCE = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
