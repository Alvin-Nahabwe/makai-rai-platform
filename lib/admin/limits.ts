/**
 * Field limits of the administrator's forms and routes, in a module with no imports, so a client component may use
 * them without pulling a server module into its bundle (C4 SI-2: one place for the 200-character request reference).
 */
export const MAX_ORG_NAME = 100;
export const MAX_REQUEST_REFERENCE = 200;
/** The longest institution legal name: shared by the create form, the correction form and the route parsers in `lib/data/admin.ts`. */
export const MAX_LEGAL_NAME = 200;
