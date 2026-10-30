import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireIdentity()` reads `x-pathname` to find out whether the page being rendered is the one place a
 * must-change-password account may stay (/change-password). The header is the proxy's, set on every page request; this
 * pins what the function does with the header it is given, and that it fails closed without one: no header is not an
 * exemption.
 */

let mustChangePassword = true;
let pathnameHeader: string | null = null;

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
});
