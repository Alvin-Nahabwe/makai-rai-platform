/**
 * The fixed texts of the API's answers (audit E-API-1 to E-API-6, plan 1A Task 16c) and of routes' own answers. Only `error`
 * changes (and `message` on the 500, where the body has one): the `code`, the status and every other key of each answer stay
 * as they were, because screens read the `code` and never these words. Download links and forms that have no better text
 * show them as they are.
 *
 * Server code only: `lib/http/toResponse.ts` and the routes read this module, and no client file reaches it, directly or
 * through another module. `lib/http/errors.ts`, which client files do reach, reads `VALIDATION_COPY.failed` from
 * `lib/http/copy.ts` instead.
 */
export const API_COPY = Object.freeze({
  /** 401 `unauthenticated` (E-API-1). */
  unauthenticated: 'You have been signed out. Sign in again.',
  /** 403 `must_change_password` (E-API-2). */
  mustChangePassword: 'Change your password before you continue.',
  /** 404 `not_found` (E-API-3). */
  notFound: 'This page or file is not available. It may have been removed, or you may not have access.',
  /** 403 `forbidden` (E-API-4). */
  forbidden: 'Your role does not allow this. Ask an Owner or Admin.',
  /** 503 `database_unavailable` (E-API-5). */
  databaseUnavailable: 'The platform is not answering. Try again in a few minutes.',
  /** 500 `internal_error` (E-API-6): the row has no full stop after the reference, and it is kept so. */
  internalError: (reference: string): string => `Something went wrong on our side. Try again. If it happens again, give us this reference: ${reference}`,
});

/** The password route's own answers (route 35, `app/api/users/me/password/route.ts`; audit A 71 to 74). */
export const PASSWORD_ROUTE_COPY = Object.freeze({
  currentRequired: 'Enter your current password.',
  accountNotFound: 'We could not find your account. Sign in again.',
  currentIncorrect: 'Your current password is not correct. Check it and try again.',
  mustDiffer: 'Choose a new password that is different from your current one.',
});

/** The invitation routes' own answers. */
export const INVITATION_ROUTE_COPY = Object.freeze({
  /** Route 32's 409 `wrong_account` (audit E-API-32, which replaces A 269 for this text: the coordinator's ruling Q8). */
  wrongAccount: 'This invitation was sent to a different email address. Sign out, then open the link again.',
});
