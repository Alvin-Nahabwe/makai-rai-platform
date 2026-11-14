import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@/lib/auth/identity';

/**
 * `identityPassesGates` (plan 1A Task 12, ruling L2-67): whether an identity already resolved would pass requireIdentity()'s
 * second and third gates on a page that exempts nothing. The Help layout uses it to decide between the signed-in shell and
 * the public header, so a person who owes a password change or an acceptance never gets a rail they cannot use.
 */

const missingAcceptances = vi.fn<(userId: string) => Promise<string[]>>();
vi.mock('@/lib/data/acceptances', () => ({ missingAcceptances: (userId: string) => missingAcceptances(userId) }));
vi.mock('@/lib/auth', () => ({ auth: () => Promise.resolve(null) }));
vi.mock('@/lib/data/identity', () => ({ identityDb: {} }));

import { identityPassesGates } from '@/lib/auth/identity';

const base: Identity = { userId: 'user_1', email: 'a@example.test', name: 'A', platformRole: 'assessor', mustChangePassword: false };

beforeEach(() => {
  missingAcceptances.mockReset();
});

describe('identityPassesGates', () => {
  it('L2-67: a flagged account does not pass, and no acceptance is read for it (gate 2 settles it)', async () => {
    missingAcceptances.mockResolvedValue([]);
    await expect(identityPassesGates({ ...base, mustChangePassword: true })).resolves.toBe(false);
    expect(missingAcceptances).not.toHaveBeenCalled();
  });

  it('L2-67: an account with an acceptance missing does not pass', async () => {
    missingAcceptances.mockResolvedValue(['terms']);
    await expect(identityPassesGates(base)).resolves.toBe(false);
    expect(missingAcceptances).toHaveBeenCalledTimes(1);
    expect(missingAcceptances).toHaveBeenCalledWith('user_1');
  });

  it('L2-67: an account with nothing missing and no password change due passes', async () => {
    missingAcceptances.mockResolvedValue([]);
    await expect(identityPassesGates(base)).resolves.toBe(true);
  });

  it('L2-67: a database error is never "nothing missing": the rejection propagates', async () => {
    missingAcceptances.mockRejectedValue(new Error('database down'));
    await expect(identityPassesGates(base)).rejects.toThrow('database down');
  });
});
