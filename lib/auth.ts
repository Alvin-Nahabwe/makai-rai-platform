import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from './db';
import { logSecurityEvent } from './security-logger';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        // Generic error for both "user not found" and "wrong password"
        if (!user) return null;

        // Deactivated accounts cannot sign in — return the same generic null.
        if (!user.isActive) {
          logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', {
            userId: user.id,
            details: { email: credentials.email as string, reason: 'account_deactivated' },
          });
          return null;
        }

        // Check if account is locked
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          logSecurityEvent('AUTH_ACCOUNT_LOCKED', 'warn', {
            details: { email: credentials.email as string },
          });
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

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', {
            details: { email: credentials.email as string, attempts: failedAttempts },
          });

          return null;
        }

        // Successful login — reset failed attempts
        if (user.failedLoginAttempts > 0 || user.lockedUntil) {
          await prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null },
          });
        }

        logSecurityEvent('AUTH_LOGIN_SUCCESS', 'info', {
          userId: user.id,
          details: { email: user.email },
        });

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
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.sessionEpoch = user.sessionEpoch;
        // Set ONLY at sign-in and never touched again by this callback, so it
        // survives every later re-encode intact. The JWT envelope's own
        // `iat` does NOT survive: @auth/core's `encode()` calls jose's
        // `.setIssuedAt()` with no argument on every re-encode, which
        // happens on every `auth()` call under the jwt strategy (see
        // node_modules/@auth/core/lib/actions/session.js) — verified live,
        // encoding the same token twice 1.2s apart produced two different
        // `iat` values. Using the envelope `iat` for the absolute session
        // cap in lib/auth/identity.ts would make that cap a silent no-op
        // for any actively-used session, which is precisely the case the
        // cap exists to bound (ADR-0002: a walked-away-from shared lab
        // machine, periodically revisited).
        token.sessionIssuedAt = Math.floor(Date.now() / 1000);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
      }
      session.sessionEpoch = token.sessionEpoch;
      session.sessionIssuedAt = token.sessionIssuedAt;
      return session;
    },
  },
  pages: { signIn: '/login' },
  // maxAge: NextAuth re-signs the cookie with a fresh expiry on every
  // request under the jwt strategy, so this behaves as a 12h idle timeout,
  // not a hard cutoff — the hard 7-day cutoff is `sessionIssuedAt` above,
  // checked in lib/auth/identity.ts's resolveIdentity (ADR-0002 §4).
  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },
});
