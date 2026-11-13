export const PRODUCT_NAME = 'MAK-AI RAI Platform';

/**
 * The browser-tab title of a page (spec 7.5; WCAG 2.4.2): `<thing> · <project or organisation> · MAK-AI RAI Platform`.
 * `context` is the project's name on a project page and the organisation's on an organisation page; a page with neither
 * passes none, and an empty one is left out rather than leaving a doubled separator.
 */
export function pageTitle(thing: string, context?: string | null): string {
  const parts = context === null || context === undefined || context.trim() === '' ? [thing] : [thing, context];
  return [...parts, PRODUCT_NAME].join(' · ');
}
