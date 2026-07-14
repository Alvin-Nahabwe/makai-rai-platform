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

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role ?? 'assessor';
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword ?? false;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.mustChangePassword = token.mustChangePassword ?? false;
      }
      return session;
    },
  },
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
});
