/**
 * The words of S-20 and S-21's data actions that more than one module shows (C4 EXP-1 SI-1): the server answers
 * and the form read them from here, so they cannot drift. No server imports, so client components can use it.
 */

/** The typed phrase of Delete my account (UX-29, W-12 note 5). */
export const DELETE_PHRASE = 'DELETE MY ACCOUNT';
/** S-21's field texts (SRS line 2389). */
export const WRONG_PASSWORD = 'The password is not right.';
export const WRONG_PHRASE = 'Type DELETE MY ACCOUNT exactly.';
/** M-38 (SRS line 2580). */
export const lastActiveOwnerMessage = (organisation: string): string =>
  `You are the only owner of ${organisation} with an active account. Make someone else an owner first, then delete your account.`;
/** Route 39's 409 platform_admin_account (owner copy, queued for the owner). */
export const PLATFORM_ADMIN_ACCOUNT = "The platform administrator's account cannot be deleted here. Ask the operator to hand the role over first.";

/** S-21 after a refusal (a 4xx other than the field and 409 answers): nothing was deleted. */
export const NOT_DELETED = 'Not deleted. Nothing was changed. Try again.';
/** S-21 after a 5xx or no answer: the deletion may have happened in part (owner copy, queued; C4 EXP-1 SF-1). */
export const DELETION_UNCONFIRMED = 'We could not confirm the deletion. Reload this page: if your account is still here, try again.';
/** S-21 after the hourly limit (owner copy, queued; SF-1 and contract rate_limited "wait <n> minutes"). */
export function tooManyAttempts(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return 'Too many attempts. Try again in an hour.';
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** M-26 on S-20 for a role without team:export (contract Q9, owner question B21; owner copy, queued). */
export const EXPORT_NOT_ALLOWED = "Only owners and admins can export the team's records.";
