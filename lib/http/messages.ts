import { AppError } from './errors';

/**
 * M-23 (SRS 7.5.7): one text for every unusable invitation (expired, used, revoked, replaced or
 * unknown), so neither S-04 nor routes 31 and 32 reveal which case a token is in.
 */
export const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';

/** Routes 31 and 32's answer for an unusable invitation: 410 `invitation_unusable` with M-23. */
export function invitationUnusable(): AppError {
  return new AppError(410, 'invitation_unusable', M23);
}
