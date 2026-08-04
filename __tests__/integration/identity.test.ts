import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { bootstrapOrgWithOwner } from '../../lib/data/preauth';
import { identityDb } from '../../lib/data/identity';
import { bumpSessionEpoch, resolveIdentity } from '../../lib/auth/identity';

beforeEach(resetDb);

async function makeUser(email: string) {
  const { userId } = await bootstrapOrgWithOwner({
    email,
    name: 'Test User',
    passwordHash: 'x',
    orgName: `Org for ${email}`,
    researchConsent: false,
    ipAddress: '127.0.0.1',
  });
  return userId;
}

// A fresh, valid `sessionIssuedAt` — used on every token below that is
// meant to reach the epoch/inactive/DB checks rather than short-circuit on
// the absolute-age check first. NOT part of the brief's literal test
// snippet (which wrote bare `{ id: userId, sessionEpoch: 0 }`): that
// snippet was written against a version of resolveIdentity where a MISSING
// `sessionIssuedAt`/`iat` silently skipped the absolute-age check —
// `pr-review-toolkit:silent-failure-hunter` flagged that as a fail-open
// (a token predating the field, or simply malformed, would bypass the
// 7-day cap forever) and it was fixed to reject on a missing claim. Without
// this addition, the epoch/inactive/role tests below would still pass, but
// vacuously — for "missing sessionIssuedAt", not for the behaviour their
// names describe.
const freshIssuedAt = () => Math.floor(Date.now() / 1000);

describe('resolveIdentity', () => {
  it('rejects a token whose sessionEpoch is stale', async () => {
    const userId = await makeUser('epoch@uni.ac.ug');
    const token = { id: userId, sessionEpoch: 0, sessionIssuedAt: freshIssuedAt() };
    await bumpSessionEpoch(userId); // logout-everywhere
    await expect(resolveIdentity(token)).rejects.toThrow(/session/i);
  });

  it('rejects a token for a deactivated user', async () => {
    const userId = await makeUser('deactivated@uni.ac.ug');
    await identityDb.user.update({ where: { id: userId }, data: { isActive: false } });
    await expect(
      resolveIdentity({ id: userId, sessionEpoch: 0, sessionIssuedAt: freshIssuedAt() }),
    ).rejects.toThrow(/inactive|session/i);
  });

  it('reads platformRole from the database, not the token', async () => {
    const userId = await makeUser('role@uni.ac.ug');
    await identityDb.user.update({ where: { id: userId }, data: { role: 'admin' } });
    const id = await resolveIdentity({
      id: userId,
      sessionEpoch: 0,
      sessionIssuedAt: freshIssuedAt(),
    });
    expect(id.platformRole).toBe('admin'); // token said nothing about role
  });

  it('rejects a token with no subject', async () => {
    await expect(resolveIdentity({})).rejects.toThrow();
    await expect(resolveIdentity({ id: '' })).rejects.toThrow();
    await expect(resolveIdentity({ id: 123 })).rejects.toThrow();
  });

  it('rejects a token whose subject does not exist in the database', async () => {
    await expect(
      resolveIdentity({
        id: '00000000-0000-0000-0000-000000000000',
        sessionEpoch: 0,
        sessionIssuedAt: freshIssuedAt(),
      }),
    ).rejects.toThrow();
  });

  it('rejects a token missing sessionIssuedAt (fails closed, does not skip the age check)', async () => {
    const userId = await makeUser('no-issued-at@uni.ac.ug');
    await expect(resolveIdentity({ id: userId, sessionEpoch: 0 })).rejects.toThrow(/session/i);
  });

  // Round-1 review finding: a bare `typeof x === 'number'` guard passes
  // `NaN` (`typeof NaN === 'number'` is `true`), and a subsequent
  // `now - NaN > MAX` comparison is always `false`, so a NaN claim would
  // have silently skipped the absolute-age cap — the same fail-open shape
  // already closed for the MISSING-claim case above, left open for the
  // malformed one. Each malformed value gets its own case, named, so a
  // future reader sees exactly what was considered rather than one vague
  // "malformed" assertion.
  it.each([
    ['NaN', NaN],
    ['+Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a fractional value', 1.5],
    ['zero', 0],
    ['a negative value', -1],
    ['a string', '1700000000' as unknown as number],
  ])('rejects a token whose sessionIssuedAt is %s (fails closed, does not skip the age check)', async (_label, badValue) => {
    const userId = await makeUser(`bad-issued-at-${Math.random()}@uni.ac.ug`);
    await expect(
      resolveIdentity({ id: userId, sessionEpoch: 0, sessionIssuedAt: badValue }),
    ).rejects.toThrow(/session/i);
  });

  it('rejects a token issued more than the absolute 7-day session lifetime ago', async () => {
    const userId = await makeUser('absolute-age@uni.ac.ug');
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    await expect(
      resolveIdentity({ id: userId, sessionEpoch: 0, sessionIssuedAt: eightDaysAgo }),
    ).rejects.toThrow(/session/i);
  });

  it('accepts a token issued just under the absolute 7-day session lifetime', async () => {
    const userId = await makeUser('within-age@uni.ac.ug');
    const almostSevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60 - 60);
    const id = await resolveIdentity({
      id: userId,
      sessionEpoch: 0,
      sessionIssuedAt: almostSevenDaysAgo,
    });
    expect(id.userId).toBe(userId);
  });
});
