import 'next-auth';
import 'next-auth/jwt';

/**
 * ADR-0002: the token asserts identity and nothing else. `role` and
 * `mustChangePassword` are deliberately ABSENT here — they used to live on
 * the token and were read once at sign-in, so a demotion or deactivation had
 * no effect for up to 30 days. They are now read fresh from the database on
 * every request by `resolveIdentity` (lib/auth/identity.ts), the one choke
 * point for identity in this app.
 *
 * Removing them from this augmentation is deliberate and load-bearing: it
 * turns every remaining reader of `session.user.role` into a compile error
 * instead of a silent `undefined` (see lib/auth.ts and lib/auth/identity.ts
 * for why that distinction matters). Do not add them back, and do not widen
 * `Session.user` beyond `id` — application code has no sanctioned way to
 * reach a raw session at all; it calls `requireIdentity()`.
 *
 * `sessionEpoch`/`sessionIssuedAt` sit on `Session` (NOT `Session.user`) and
 * on `JWT`, for the same reason `lib/auth/identity.ts`'s `RawToken` comment
 * explains: they are session-lifecycle bookkeeping, not identity, and only
 * `lib/auth/identity.ts` (an ignored file in the ESLint `auth` import ban)
 * is meant to read them.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
    sessionEpoch?: number;
    sessionIssuedAt?: number;
  }

  interface User {
    sessionEpoch?: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    sessionEpoch?: number;
    sessionIssuedAt?: number;
  }
}
