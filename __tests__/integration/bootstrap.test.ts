import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { bootstrapOrgWithOwner, createOrgForUser, deriveSlug } from '../../lib/data/preauth';

beforeEach(resetDb);

describe('bootstrapOrgWithOwner', () => {
  it('creates user, organization, owner membership and consents atomically', async () => {
    const r = await bootstrapOrgWithOwner({
      email: 'a@uni.ac.ug', name: 'A', passwordHash: 'x',
      orgName: 'Makerere AI Lab', researchConsent: true, ipAddress: '127.0.0.1',
    });
    const m = await testDb.membership.findFirst({ where: { userId: r.userId, orgId: r.orgId } });
    expect(m?.role).toBe('owner');
    expect(m?.status).toBe('active');
    expect(await testDb.consentRecord.count({ where: { userId: r.userId } })).toBe(3);
    expect(r.slug).toBe('makerere-ai-lab');
  });

  it('writes nothing at all when any part fails', async () => {
    await bootstrapOrgWithOwner({
      email: 'dup@uni.ac.ug', name: 'A', passwordHash: 'x',
      orgName: 'One', researchConsent: false, ipAddress: '127.0.0.1' });
    await expect(bootstrapOrgWithOwner({
      email: 'dup@uni.ac.ug', name: 'B', passwordHash: 'y',
      orgName: 'Two', researchConsent: false, ipAddress: '127.0.0.1' })).rejects.toThrow();
    // The second organization must NOT exist — the transaction rolled back.
    expect(await testDb.organization.count({ where: { name: 'Two' } })).toBe(0);
  });

  it('never reports a slug collision to the caller', async () => {
    const a = await bootstrapOrgWithOwner({ email: 'x@u.ac', name: 'X', passwordHash: 'x',
      orgName: 'Shared Name', researchConsent: false, ipAddress: '1.1.1.1' });
    const b = await bootstrapOrgWithOwner({ email: 'y@u.ac', name: 'Y', passwordHash: 'y',
      orgName: 'Shared Name', researchConsent: false, ipAddress: '1.1.1.1' });
    expect(a.slug).toBe('shared-name');
    expect(b.slug).toMatch(/^shared-name-[0-9a-f]{4}$/);   // random, not sequential
  });
});

describe('deriveSlug', () => {
  it.each([
    ['Makerere AI Lab', 'makerere-ai-lab'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere'],
    ['Ünïcødé & Symbols!!', 'n-c-d-symbols'],
    ['a'.repeat(80), 'a'.repeat(48)],
  ])('derives %j to %j', (input, expected) => expect(deriveSlug(input)).toBe(expected));
});

describe('createOrgForUser', () => {
  it('makes an existing user the owner of a second organization', async () => {
    const first = await bootstrapOrgWithOwner({ email: 'z@u.ac', name: 'Z', passwordHash: 'z',
      orgName: 'First Org', researchConsent: false, ipAddress: '1.1.1.1' });
    const second = await createOrgForUser({ userId: first.userId, orgName: 'Second Org' });
    const memberships = await testDb.membership.findMany({ where: { userId: first.userId } });
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.role === 'owner')).toBe(true);
    expect(second.slug).toBe('second-org');
  });
});
