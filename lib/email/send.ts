import { Resend } from 'resend';

/**
 * The ONE transport export (Task 9 constraint 1). No template logic lives
 * here — callers build `{ subject, html, text }` with `lib/email/templates.ts`
 * and pass the result straight through.
 *
 * On failure this THROWS (constraint 2). It never returns a success-shaped
 * value, logs-and-continues, or swallows: the Resend SDK itself does NOT
 * throw on an API-level failure — `resend.emails.send()` resolves to
 * `{ data, error }` and folds the failure into that shape rather than
 * rejecting the promise (see `node_modules/resend/dist/index.d.mts`,
 * `type Response<T> = ({ data: T; error: null } | { error: ErrorResponse;
 * data: null }) & { headers: ... }`). Silently trusting `data` without
 * checking `error` is exactly the shape AGENTS.md's silent-failure trigger
 * targets: the inviter would see a 201 while the colleague never receives
 * anything. This function is the one place that turns Resend's
 * error-as-value into a thrown error, so every caller — today, only the
 * invite route — gets the same fail-loud guarantee without re-deriving it.
 *
 * Never logs the API key or any part of `message` itself; the thrown error
 * carries only Resend's own `name`/`message` fields, which describe the
 * failure category (e.g. `invalid_from_address`), not a secret.
 */
export async function sendEmail(message: {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('RESEND_API_KEY is not set. Refusing to send email.');
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send(message);

  // `!data.id` closes a half-success gap: the SDK's `id: string` is a
  // compile-time guarantee only, not a runtime one — a shell object
  // (`{ data: {}, error: null }`) would otherwise pass `!data` and return
  // `{ id: undefined }`, exactly the success-shaped-on-failure value this
  // function exists to prevent. Found by `silent-failure-hunter` before
  // this was wired into the invite route.
  if (error || !data || !data.id) {
    throw new Error(
      `Email send failed (${error?.name ?? 'no_data'}): ${
        error?.message ??
        (data && !data.id ? 'Resend returned no message id' : 'Resend returned no data and no error')
      }`,
    );
  }

  return { id: data.id };
}
