/**
 * Input validation and sanitization functions.
 * No external dependencies — pure TypeScript.
 */

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate email format (RFC 5322 simplified). */
export function validateEmail(email: unknown): ValidationError | null {
  if (typeof email !== 'string' || email.length === 0) {
    return { field: 'email', message: 'Email is required' };
  }
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254) {
    return { field: 'email', message: 'Email must be 254 characters or fewer' };
  }
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(trimmed)) {
    return { field: 'email', message: 'Please enter a valid email address' };
  }
  return null;
}

/** Validate password strength. */
export function validatePassword(password: unknown): ValidationError | null {
  if (typeof password !== 'string' || password.length === 0) {
    return { field: 'password', message: 'Password is required' };
  }
  if (password.length < 8) {
    return { field: 'password', message: 'Password must be at least 8 characters' };
  }
  if (password.length > 128) {
    return { field: 'password', message: 'Password must be 128 characters or fewer' };
  }
  return null;
}

/** Validate and sanitize a string field. */
export function validateString(
  value: unknown,
  field: string,
  maxLength: number,
  required = true,
): { value: string; error: ValidationError | null } {
  if (value === null || value === undefined || value === '') {
    if (required) {
      return { value: '', error: { field, message: `${field} is required` } };
    }
    return { value: '', error: null };
  }
  if (typeof value !== 'string') {
    return { value: '', error: { field, message: `${field} must be a string` } };
  }
  const sanitized = sanitizeInput(value);
  if (sanitized.length > maxLength) {
    return {
      value: sanitized,
      error: { field, message: `${field} must be ${maxLength} characters or fewer` },
    };
  }
  return { value: sanitized, error: null };
}

/** Sanitize input: trim whitespace, strip control characters. */
export function sanitizeInput(value: string): string {
  return value
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/** Collect validation errors into a single response. */
export function collectErrors(errors: (ValidationError | null)[]): ValidationError[] {
  return errors.filter((e): e is ValidationError => e !== null);
}

/**
 * The scalar fields `ProjectMetadata` (prisma/schema.prisma) actually
 * declares, minus `id`/`orgId`/`projectId`/`updatedAt` (Prisma-managed).
 * Kept as one list, imported by both the create route and the update
 * route, so the two cannot drift the way IMPORTANT-2 (final Plan 1b
 * review) found them already drifted once: POST validated `name`/
 * `description`, PATCH validated neither, and PATCH's raw `metadataFields`
 * reached `metadata.upsert` unfiltered — any key that is not a real
 * `ProjectMetadata` column throws Prisma's "Unknown argument" as an
 * unhandled 500 instead of a 400.
 *
 * `aiSystemType` IS included, deliberately, even though POST's route
 * destructures it out of `metadataFields` separately before calling
 * `validateMetadataFields` (so it never actually reaches this allowlist
 * check from POST either way): PATCH does NOT destructure it out — a PATCH
 * body containing `aiSystemType` flows straight into `metadataFields` — so
 * leaving it off this list would 400 a perfectly legitimate PATCH of a
 * real column. Caught in self-review, not by the test suite: no current UI
 * caller sends `aiSystemType` via PATCH, so a test asserting only "valid
 * fields still work" would not have exercised this specific field.
 */
export const PROJECT_METADATA_FIELDS = [
  'aiSystemType',
  'aiSystemTypeOther',
  'institution',
  'department',
  'country',
  'developmentStage',
  'deploymentSector',
  'deploymentSectorOther',
  'targetPopulation',
  'processesPersonalData',
  'datasetSize',
  'datasetType',
  'datasetTypeOther',
  'datasetDescription',
  'teamSize',
  'fundingSource',
  'regulatoryContext',
  'projectStart',
  'projectEnd',
] as const;

const ALLOWED_METADATA_FIELDS = new Set<string>(PROJECT_METADATA_FIELDS);

/**
 * Validates that every key in `fields` is a real `ProjectMetadata` column
 * before it ever reaches Prisma, and drops keys whose value is `undefined`
 * or `''` (the same "no-op, not a null-out" convention `validateString`'s
 * callers already rely on elsewhere in these two routes). An unrecognized
 * key is a 400 — a stray body field is a caller bug, not a value Prisma
 * should be left to reject with an internal error shape.
 */
export function validateMetadataFields(
  fields: Record<string, unknown>,
): { value: Record<string, unknown>; error: ValidationError | null } {
  const unknownKey = Object.keys(fields).find((k) => !ALLOWED_METADATA_FIELDS.has(k));
  if (unknownKey !== undefined) {
    return {
      value: {},
      error: { field: unknownKey, message: `Unknown project metadata field: ${unknownKey}` },
    };
  }
  return {
    value: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')),
    error: null,
  };
}

/**
 * `validateString` only rejects a literally-empty input; a whitespace-only
 * string ('   ') passes it and is then trimmed to '' by its own
 * `sanitizeInput` step, so `result.error` is null but `result.value` is
 * empty. Left unguarded, a caller writes that empty string straight through.
 * Wraps the fix into one call so it is derived once rather than re-authored
 * per call site — first found and fixed inline in
 * app/api/auth/register/route.ts, duplicated once more in
 * app/api/v1/orgs/route.ts before being factored out here.
 */
export function requireNonBlank(
  result: { value: string; error: ValidationError | null },
  field: string,
): ValidationError | null {
  if (result.error) return result.error;
  if (result.value.length === 0) return { field, message: `${field} is required` };
  return null;
}
