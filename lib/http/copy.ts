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
});
