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
