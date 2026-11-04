import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { identityDb } from './identity';
import { hashInvitationToken } from './invitationToken';
import { AppError, ValidationFailed } from '../http/errors';
import { validatePassword } from '../validate';
import { sendEmail } from '../email/send';
import { passwordResetEmail } from '../email/templates/passwordReset';
import { passwordChangedEmail } from '../email/templates/passwordChanged';
import { publicOrigin } from '../publicOrigin';
import { logSecurityEvent } from '../security-logger';

/**
 * Password reset by email (FR-ACC-06, SRS line 503; NFR-SEC-05 for reset tokens) and the password-changed notice E-02
 * (FR-ACC-09), on the identity lane.
 *
 * A reset token is 32 random bytes, sent once as 64 hex characters after `#token=` in E-03's link, stored only as its
 * SHA-256 (the invitation helper, lib/data/invitationToken.ts), valid RESET_TTL_MS, used by one conditional update, and
 * voided by a newer request, a completed reset, a password change (app/api/users/me/password) or a deactivation (K0a's
 * definer `admin_set_account_active`). No reset email goes to an unknown, deactivated, deleted or platform-administrator
 * account (the operator resets that one), nor past RESET_PER_ACCOUNT_PER_HOUR for an account or
 * RESET_PER_PLATFORM_PER_HOUR across the platform; route 33 gives the same answer either way, at once, and runs
 * `requestPasswordReset` after the response. Nothing here logs the token, its hash or an address.
 */
export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_PER_ACCOUNT_PER_HOUR = 3;
export const RESET_PER_PLATFORM_PER_HOUR = 200;

/** M-22 (SRS 7.5.7). */
export const RESET_LINK_UNUSABLE = 'This link has expired or has already been used. Ask for a new one.';

const HOUR_MS = 60 * 60 * 1000;
const RAW_TOKEN = /^[0-9a-f]{64}$/;

const isDeletedAddress = (email: string) => email.startsWith('deleted-') && email.endsWith('@invalid');

type SendFailure = 'sender_unset' | 'api_key_unset' | 'send_failed';

/** Why no mail can go at all, before anything is written for one: the sender or the key is unset. */
function mailUnavailable(): 'sender_unset' | 'api_key_unset' | null {
  if (!process.env.EMAIL_FROM_ADDRESS) return 'sender_unset';
  if (!process.env.RESEND_API_KEY) return 'api_key_unset';
  return null;
}

/** Sends one message; null when it went, else a fixed reason for the log line (the error can carry the address). */
async function send(to: string, content: { subject: string; html: string; text: string }): Promise<SendFailure | null> {
  const unavailable = mailUnavailable();
  if (unavailable) return unavailable;
  try {
    await sendEmail({ to, from: process.env.EMAIL_FROM_ADDRESS as string, ...content });
    return null;
  } catch {
    return 'send_failed';
  }
}

/** Voids every reset token of the account not yet used or voided. */
export async function voidResetTokens(userId: string, now: Date): Promise<void> {
  await identityDb.passwordResetToken.updateMany({ where: { userId, usedAt: null, voidedAt: null }, data: { voidedAt: now } });
}

/**
 * The work behind route 33, run after its answer. Finds the account by address (any letter case, spaces trimmed), and for
 * an account that may reset within both limits voids its earlier tokens, stores the new token's hash and sends E-03.
 * Logs PASSWORD_RESET_REQUESTED with the account's id when one exists, else with none.
 */
export async function requestPasswordReset(email: string, now: Date): Promise<void> {
  const typed = email.trim();
  const user = typed.length === 0 ? null : await identityDb.user.findFirst({
    where: { email: { equals: typed, mode: 'insensitive' } },
    select: { id: true, email: true, isActive: true, role: true },
  });
  if (!user) {
    logSecurityEvent('PASSWORD_RESET_REQUESTED', 'info', { details: { sent: false } });
    return;
  }
  const refuse = (reason: string) => logSecurityEvent('PASSWORD_RESET_REQUESTED', 'info', { userId: user.id, details: { sent: false, reason } });
  if (!user.isActive || isDeletedAddress(user.email)) return refuse('inactive');
  if (user.role === 'admin') return refuse('platform_administrator');

  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const [mine, all] = await Promise.all([
    identityDb.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: hourAgo } } }),
    identityDb.passwordResetToken.count({ where: { createdAt: { gt: hourAgo } } }),
  ]);
  if (mine >= RESET_PER_ACCOUNT_PER_HOUR) return refuse('account_limit');
  if (all >= RESET_PER_PLATFORM_PER_HOUR) return refuse('platform_limit');
  // Before anything is voided or counted: with mail down, a request must not kill the person's earlier link.
  const unavailable = mailUnavailable();
  if (unavailable) {
    logSecurityEvent('PASSWORD_RESET_REQUESTED', 'error', { userId: user.id, details: { sent: false, reason: unavailable } });
    return;
  }

  const raw = randomBytes(32).toString('hex');
  await voidResetTokens(user.id, now);
  await identityDb.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashInvitationToken(raw), expiresAt: new Date(now.getTime() + RESET_TTL_MS) },
  });
  const resetUrl = `${new URL('/reset-password', publicOrigin()).toString()}#token=${raw}`;
  const failure = await send(user.email, passwordResetEmail({ resetUrl }));
  if (failure) logSecurityEvent('PASSWORD_RESET_REQUESTED', 'error', { userId: user.id, details: { sent: false, reason: failure } });
  else logSecurityEvent('PASSWORD_RESET_REQUESTED', 'info', { userId: user.id, details: { sent: true } });
}

/**
 * Route 34's work: sets a new password from an unused, unvoided, unexpired token. The password is checked first, so a 422
 * consumes nothing, and hashed (cost 12) before any write. The writes run in the order that leaves no half state a person
 * relies on: the account's other links are voided and its known devices' counts cleared; then the token is used by one
 * conditional update (the guarantee that a link works once); last, one update of the account sets the hash, raises
 * `sessionEpoch` (every earlier session ends on its next request) and clears the lock and the forced-change flag. A
 * failure before the last write leaves the password as it was.
 * Throws `ValidationFailed` (422) or AppError(410, 'reset_link_unusable', M-22).
 */
export async function completePasswordReset(token: string, newPassword: string, now: Date): Promise<{ userId: string }> {
  const pwError = validatePassword(newPassword);
  if (pwError) throw new ValidationFailed([{ field: 'newPassword', message: pwError.message }]);
  if (!RAW_TOKEN.test(token)) throw unusable();
  const tokenHash = hashInvitationToken(token);
  const usable = { tokenHash, usedAt: null, voidedAt: null, expiresAt: { gt: now } };
  const live = await identityDb.passwordResetToken.findFirst({ where: usable, select: { userId: true } });
  if (!live) throw unusable();
  const passwordHash = await hash(newPassword, 12);

  await identityDb.passwordResetToken.updateMany({
    where: { userId: live.userId, usedAt: null, voidedAt: null, tokenHash: { not: tokenHash } },
    data: { voidedAt: now },
  });
  await identityDb.knownDevice.updateMany({ where: { userId: live.userId }, data: { failedCount: 0, lockedUntil: null } });
  const used = await identityDb.passwordResetToken.updateMany({ where: usable, data: { usedAt: now } });
  if (used.count !== 1) throw unusable();
  // `isActive: true` in the condition: an account deactivated after the link was sent is not reopened by it.
  const changed = await identityDb.user.updateMany({
    where: { id: live.userId, isActive: true },
    data: { passwordHash, sessionEpoch: { increment: 1 }, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: false },
  });
  if (changed.count !== 1) throw unusable();
  return { userId: live.userId };
}

function unusable(): AppError {
  return new AppError(410, 'reset_link_unusable', RESET_LINK_UNUSABLE);
}

/**
 * Sends E-02 to the account after a completed change or reset (FR-ACC-09). Null when it went, else a fixed reason for the
 * caller's log line; a missing account is 'no_account'. Never throws for a send failure: the password is already changed.
 */
export async function sendPasswordChangedNotice(userId: string, changedAt: Date): Promise<SendFailure | 'no_account' | null> {
  const user = await identityDb.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return 'no_account';
  return send(user.email, passwordChangedEmail({ changedAt }));
}
