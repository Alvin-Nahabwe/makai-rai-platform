/**
 * The words every form field of the kit shares. They are a module of their own because a copy module ships whole to
 * every page whose client code imports it: a page with a form downloads these two words, not the rest of the kit's
 * (NFR-PERF-02). `UI_COPY.field` in `lib/ui/copy.ts` is this same object.
 */
export const FIELD_COPY = {
  /** After a required field's label: "Reason (required)". */
  required: '(required)',
  /** Read before every field error, visually hidden: the error icon beside it is hidden from assistive technology. */
  errorPrefix: 'Error:',
} as const;
