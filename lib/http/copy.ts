import { formatDay } from '@/lib/format/dates';
import type { CalendarDate } from '@/types/record';
/**
 * Server and validation words; kept out of lib/errors/copy.ts, which every page's error boundary loads.
 */

/** The texts of `lib/validate.ts`, shown under a form's field or at its top (audit D LIB15 to LIB25). */
export const VALIDATION_COPY = Object.freeze({
  emailRequired: 'Enter an email address.',
  emailShape: 'Enter the email address in the form name@example.org.',
  passwordRequired: 'Enter a password.',
  passwordTooShort: (min: number): string => `Use at least ${min} characters.`,
  /** The longest a text may be: an email, a password, a name or a description. */
  tooLong: (max: number): string => `Use ${max} characters or fewer.`,
  /** `label` is a plain lower-case name for the field ("project name"), never the field's code key. */
  required: (label: string): string => `Enter the ${label}.`,
  /**
   * 422 `validation`, the `error` of every `ValidationFailed` (audit E-API-7). Here, not in `lib/http/api/copy.ts`, because
   * `lib/http/errors.ts` reads it and client files reach that module.
   */
  failed: 'Some answers need fixing.',
});

/**
 * The `error` text of the answers `lib/http/errors.ts`, `lib/http/sameOrigin.ts`, `lib/http/jsonBody.ts`, `lib/http/requestIdBody.ts` and
 * `proxy.ts` give (audit E-API-8 to E-API-19). The `code` of each answer is the contract and is unchanged. Here, not in
 * `lib/http/api/copy.ts`, because `lib/http/errors.ts` reads it and client files reach that module.
 */
export const HTTP_COPY = Object.freeze({
  /** 429 `rate_limited` and `export_busy` (E-API-9, E-API-10): the wait is the body's `retryAfterSeconds`, rounded up to whole minutes. */
  rateLimited: (retryAfterSeconds: number): string => {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return `Too many attempts. Wait ${minutes === 1 ? '1 minute' : `${minutes} minutes`}, then try again.`;
  },
  /** 410 `erased` (E-API-11): `erasedOn` is the body's own, written as "2 Nov 2026". */
  erased: (erasedOn: CalendarDate): string => `This record was erased on ${formatDay(erasedOn)}.`,
  /** 403 `acceptances_required` (E-API-13). */
  acceptancesRequired: 'Accept the updated terms before you continue.',
  /** 403 `cross_origin` (E-API-14), and a `requestId` that is not a UUID (E-API-19): a page that is not the one this site served. */
  outOfDate: 'This page is out of date. Reload it and try again.',
  /** 422 on `body`: not JSON in UTF-8, or not a JSON object (E-API-15, E-API-17). A form always sends both, so a person meets it only through a broken page. */
  unreadable: 'The request could not be read. Reload the page and try again.',
});

/**
 * The names shown for a person or an invitation that is no longer there (audit E-API-47, E-S25, LD-28, LD-32 to LD-34;
 * CONSOLIDATED section 8 row 13). `deletedAccount` is also the name written to a scrubbed account.
 */
export const GONE_NAME_COPY = Object.freeze({
  deletedAccount: 'Deleted account',
  removedInvitation: 'Removed invitation',
});
