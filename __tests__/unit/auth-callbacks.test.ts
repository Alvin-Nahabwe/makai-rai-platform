import { describe, it, expect } from 'vitest';
import { jwtCallback, sessionCallback } from '../../lib/auth/callbacks';
import type { JWT } from 'next-auth/jwt';
import type { Session, User } from 'next-auth';

/**
 * The WRITER side of the session contract.
 *
 * resolveIdentity (lib/auth/identity.ts) is well covered by
 * __tests__/integration/identity.test.ts: it rejects a stale sessionEpoch, a
 * deactivated user, a missing sessionIssuedAt, and a token older than the
 * absolute seven-day cap. Every one of those tests reads a token someone else
 * produced.
 *
 * None of them can detect the failure that matters here. If this callback ever
 * starts refreshing `sessionIssuedAt` on ordinary requests — because a NextAuth
 * upgrade begins supplying `user` outside sign-in, or because someone moves the
 * assignment out of the branch — then the cap silently becomes unbounded, and
 * resolveIdentity keeps passing because the value it receives is always fresh
 * and always valid. The guard would be intact and the property gone.
 *
 * That is why these assertions live on the writer.
 */

const asUser = (over: Partial<User> & { sessionEpoch?: number } = {}) =>
  ({ id: 'user-1', sessionEpoch: 3, ...over }) as User;

describe('jwtCallback stamps identity claims at sign-in only', () => {
  it('writes id, sessionEpoch and sessionIssuedAt when a user is supplied', async () => {
    const token = await jwtCallback({ token: {} as JWT, user: asUser() });

    expect(token.id).toBe('user-1');
    expect(token.sessionEpoch).toBe(3);
    expect(typeof token.sessionIssuedAt).toBe('number');
  });

  it('does NOT refresh sessionIssuedAt on a later call with no user', async () => {
    const signedInAt = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 6; // 6 days ago
    const existing = { id: 'user-1', sessionEpoch: 3, sessionIssuedAt: signedInAt } as JWT;

    const afterOrdinaryRequest = await jwtCallback({ token: existing });

    expect(afterOrdinaryRequest.sessionIssuedAt).toBe(signedInAt);
  });

  it('does not refresh it even across many ordinary requests, so the cap can be reached', async () => {
    const signedInAt = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 6;
    let token = { id: 'user-1', sessionEpoch: 3, sessionIssuedAt: signedInAt } as JWT;

    for (let i = 0; i < 25; i++) token = await jwtCallback({ token });

    expect(token.sessionIssuedAt).toBe(signedInAt);
  });

  it('treats a re-authentication as a new sign-in and re-stamps the claim', async () => {
    const stale = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 6;
    const token = await jwtCallback({
      token: { id: 'user-1', sessionEpoch: 3, sessionIssuedAt: stale } as JWT,
      user: asUser({ sessionEpoch: 4 } as Partial<User>),
    });

    expect(token.sessionIssuedAt).not.toBe(stale);
    expect(token.sessionEpoch).toBe(4);
  });

  it('carries a revoked epoch through unchanged, leaving revocation to resolveIdentity', async () => {
    const token = await jwtCallback({
      token: { id: 'user-1', sessionEpoch: 1, sessionIssuedAt: 123 } as JWT,
    });

    expect(token.sessionEpoch).toBe(1);
  });
});

describe('sessionCallback surfaces exactly the claims resolveIdentity re-checks', () => {
  it('copies id, sessionEpoch and sessionIssuedAt onto the session', async () => {
    const session = await sessionCallback({
      session: { user: { id: '' } } as Session,
      token: { id: 'user-9', sessionEpoch: 7, sessionIssuedAt: 555 } as JWT,
    });

    expect(session.user.id).toBe('user-9');
    expect(session.sessionEpoch).toBe(7);
    expect(session.sessionIssuedAt).toBe(555);
  });

  it('does not invent values when the token carries none, so the reader still fails closed', async () => {
    const session = await sessionCallback({
      session: { user: { id: '' } } as Session,
      token: {} as JWT,
    });

    expect(session.sessionEpoch).toBeUndefined();
    expect(session.sessionIssuedAt).toBeUndefined();
  });
});
