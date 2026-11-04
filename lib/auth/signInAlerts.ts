/**
 * The password-spraying alert (NFR-OBS-04). `lib/auth/credentials.ts` reports every refused sign-in for an existing
 * account here. A no-op until the alert rules land.
 */
export function recordSignInFailure(_e: { userId: string; locked: boolean }, _now: Date = new Date()): void {}
