/**
 * HTML-escapes a value an email interpolates (SRS 6.1 rule 3). Its own module, not an export of
 * lib/email/templates.ts, because every function that module exports is a template to
 * __tests__/unit/notification-content.test.ts (RL 2.3). E-01 (templates.ts) and E-06
 * (templates/accountCreated.ts) both use it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
