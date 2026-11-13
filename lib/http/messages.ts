import { AppError } from './errors';
import { AUTH_MESSAGE_COPY } from '../auth/copy';

/**
 * M-23 (SRS 7.5.7): one text for every unusable invitation (expired, used, revoked, replaced or
 * unknown), so neither S-04 nor routes 31 and 32 reveal which case a token is in.
 */
export const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';

/**
 * M-20 (SRS 7.5.7): S-01's one text for a wrong password, a locked account and an unknown email (FR-ACC-05).
 */
export const M20 = AUTH_MESSAGE_COPY.wrongCredentials;

/** M-21 (SRS 7.5.7): S-02's and route 33's one answer, whatever the address (FR-ACC-06). */
export const M21 = AUTH_MESSAGE_COPY.resetLinkSent;

/** M-22 (SRS 7.5.7): a reset link that is used, expired, voided or unknown, and S-03 opened with no link (FR-ACC-06). */
export const M22 = AUTH_MESSAGE_COPY.resetLinkUnusable;

/** Routes 31 and 32's answer for an unusable invitation: 410 `invitation_unusable` with M-23. */
export function invitationUnusable(): AppError {
  return new AppError(410, 'invitation_unusable', M23);
}
