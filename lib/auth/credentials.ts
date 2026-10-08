import { compare } from 'bcryptjs';
import { identityDb } from '../data/identity';
import { logSecurityEvent } from '../security-logger';

/**
 * The body of the Credentials provider's `authorize` (lib/auth.ts), moved here so it can be
 * called without NextAuth in the way: the integration test drives it against a real
 * database, and Task 16 reuses it.
 *
 * It is the code that was in `lib/auth.ts`, with one change: no log line names the account's
 * email (RL 2.3, 7.12; P1). Each line carries `userId` instead, which is enough to follow one
 * account through a brute force and is not personal data (P2), and `attempts` stays.
 * The lookups, the generic `null` for every refusal, the lockout and the counter reset are
 * unchanged.
 */
export async function authorizeCredentials(
  credentials: Partial<Record<'email' | 'password', unknown>> | undefined,
): Promise<{ id: string; email: string; name: string; sessionEpoch: number } | null> {
  if (!credentials?.email || !credentials?.password) return null;

  const user = await identityDb.user.findUnique({
    where: { email: credentials.email as string },
  });

  // Generic error for both "user not found" and "wrong password"
  if (!user) return null;

  // Deactivated accounts cannot sign in — return the same generic null.
  if (!user.isActive) {
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', {
      userId: user.id,
      details: { reason: 'account_deactivated' },
    });
    return null;
  }

  // Check if account is locked
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    logSecurityEvent('AUTH_ACCOUNT_LOCKED', 'warn', { userId: user.id });
    return null; // Still locked — return same generic null
  }

  const isValid = await compare(credentials.password as string, user.passwordHash);

  if (!isValid) {
    // Increment failed attempts
    const failedAttempts = user.failedLoginAttempts + 1;
    const updateData: { failedLoginAttempts: number; lockedUntil?: Date } = {
      failedLoginAttempts: failedAttempts,
    };

    // Lock after 5 failed attempts (15-minute lockout)
    if (failedAttempts >= 5) {
      updateData.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }

    await identityDb.user.update({
      where: { id: user.id },
      data: updateData,
    });

    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', {
      userId: user.id,
      details: { attempts: failedAttempts },
    });

    return null;
  }

  // Successful login — reset failed attempts
  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await identityDb.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  logSecurityEvent('AUTH_LOGIN_SUCCESS', 'info', { userId: user.id });

  // ADR-0002: the token carries identity and nothing else. `role` and
  // `mustChangePassword` are deliberately NOT returned here — they are
  // read fresh from the database on every request by resolveIdentity
  // (lib/auth/identity.ts), never embedded in the token.
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    sessionEpoch: user.sessionEpoch,
  };
}
