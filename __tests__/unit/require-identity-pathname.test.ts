import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireIdentity()` reads `x-pathname` to find out whether the page being rendered is the one place a
 * must-change-password account may stay (/change-password). The header is the proxy's, set on every page request; this
 * pins what the function does with the header it is given, and that it fails closed without one: no header is not an
 * exemption.
 */

let mustChangePassword = true;
let pathnameHeader: string | null = null;
/** Gate 3 (FR-ACC-04): the kinds the account is missing; none unless a case says so. */
let missing: string[] = [];

vi.mock('@/lib/auth', () => ({
  auth: () => Promise.resolve({ user: { id: 'user_1' }, sessionEpoch: 1, sessionIssuedAt: Math.floor(Date.now() / 1000) }),
}));
vi.mock('@/lib/data/identity', () => ({
  identityDb: {
    user: {
      findUnique: () =>
        Promise.resolve({ id: 'user_1', email: 'a@example.test', name: 'A', role: 'assessor', isActive: true, sessionEpoch: 1, mustChangePassword }),
    },
  },
}));
vi.mock('@/lib/data/acceptances', () => ({ missingAcceptances: () => Promise.resolve(missing) }));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(pathnameHeader === null ? {} : { 'x-pathname': pathnameHeader })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import { requireIdentity } from '@/lib/auth/identity';

beforeEach(() => {
  mustChangePassword = true;
  pathnameHeader = null;
  missing = [];
});

describe('requireIdentity and the x-pathname header', () => {
  it('UX-01: a must-change-password account with no x-pathname header is redirected to /change-password (fails closed)', async () => {
    pathnameHeader = null;
    await expect(requireIdentity()).rejects.toThrow('REDIRECT /change-password');
  });

  it('UX-01: only the value /change-password lets the account stay; any other value, empty included, redirects', async () => {
    pathnameHeader = '/change-password';
    await expect(requireIdentity()).resolves.toMatchObject({ userId: 'user_1', mustChangePassword: true });
    for (const value of ['', '/', '/account', '/acceptances', '/change-password/', '/change-password.png', '/orgs/acme/dashboard']) {
      pathnameHeader = value;
      await expect(requireIdentity(), JSON.stringify(value)).rejects.toThrow('REDIRECT /change-password');
    }
  });

  it('UX-01: an account that is not flagged passes without the header, and the header changes nothing for it', async () => {
    mustChangePassword = false;
    pathnameHeader = null;
    await expect(requireIdentity()).resolves.toMatchObject({ userId: 'user_1', mustChangePassword: false });
    pathnameHeader = '/anything';
    await expect(requireIdentity()).resolves.toMatchObject({ mustChangePassword: false });
  });

  it('UX-01 FR-ACC-04: an account missing an acceptance with no x-pathname header is redirected to /acceptances (fails closed)', async () => {
    mustChangePassword = false;
    missing = ['privacy'];
    pathnameHeader = null;
    await expect(requireIdentity()).rejects.toThrow('REDIRECT /acceptances');
  });

  it('UX-01 FR-ACC-04: only /acceptances, /account and /change-password let such an account stay; a look-alike path redirects', async () => {
    mustChangePassword = false;
    missing = ['privacy'];
    for (const value of ['/acceptances', '/account', '/change-password']) {
      pathnameHeader = value;
      await expect(requireIdentity(), value).resolves.toMatchObject({ userId: 'user_1' });
    }
    for (const value of ['/acceptances.png', '/account.png', '/acceptances/', '/accountx', '', '/orgs/acme/dashboard', '/change-password/']) {
      pathnameHeader = value;
      await expect(requireIdentity(), JSON.stringify(value)).rejects.toThrow('REDIRECT /acceptances');
    }
  });
});
