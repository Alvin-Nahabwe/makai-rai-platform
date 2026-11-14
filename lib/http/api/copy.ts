/**
 * The fixed texts of the API's answers (audit E-API-1 to E-API-7, plan 1A Task 16c). Only `error` changes (and `message` on the
 * 500, where the body has one): the `code`, the status and every other key of each answer stay as they were, because screens
 * read the `code` and never these words. Download links and forms that have no better text show them as they are.
 *
 * Server code only: `lib/http/toResponse.ts` and `lib/http/errors.ts` read this module, and no client file imports it directly.
 * `lib/http/errors.ts` is itself reached from the evidence upload's client chain (`lib/evidence/link.ts`), so these strings can
 * ride in that bundle; the lead's first-load measurement covers it.
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
  /** 422 `validation` (E-API-7). */
  validationFailed: 'Some answers need fixing.',
});
