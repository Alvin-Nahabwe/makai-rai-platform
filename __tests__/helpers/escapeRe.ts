/**
 * A string as a regular expression matches it literally: every character with a meaning in a pattern is escaped.
 * Shared by the unit tests and the browser specs that build a pattern around a copy constant ("Use at least 12
 * characters." holds a dot that would match any character).
 */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
