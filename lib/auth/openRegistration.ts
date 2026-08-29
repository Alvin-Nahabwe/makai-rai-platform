/**
 * Whether strangers may create their own account and organization.
 *
 * `PLAN.md:217` records the ruling: **D9 — Registration invite-gated until T3**.
 * This is the implementation of that decision, which the code did not have until
 * 2026-08-29 — `app/api/auth/register/route.ts` accepted any well-formed POST,
 * and `docker/docker-compose.prod.yml:40` asserted the opposite in a comment.
 *
 * CLOSED IS THE DEFAULT, and the check is `=== 'true'` rather than anything
 * truthier. An unset variable, a typo, a `1`, a `yes`, a stray space — all leave
 * it shut. The asymmetry is deliberate: the cost of failing closed is that
 * someone has to set a variable and try again; the cost of failing open is a
 * live multi-tenant platform accepting unverified tenants from the internet.
 *
 * WHY A FLAG AND NOT A DELETION. D9 says "until T3", so this reopens later. That
 * must be a configuration change rather than a code change, or reopening becomes
 * a release — which is how a temporary closure turns into a permanent one, or
 * gets reopened in a hurry by editing a route.
 *
 * THIS IS NOT EMAIL VERIFICATION. Register row D-200 remains open: when
 * registration does reopen at T3, it needs an actual challenge — a verified
 * address, or a captcha. This flag only decides whether the door is open at all.
 * Opening it without D-200's control restores the exposure this closed.
 */
export function openRegistrationEnabled(): boolean {
  return process.env.ALLOW_OPEN_REGISTRATION === 'true';
}
