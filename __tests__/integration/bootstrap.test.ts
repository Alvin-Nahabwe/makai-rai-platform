import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { createOrgForUser, deriveSlug } from '../../lib/data/preauth';
import { buildOrg } from '../helpers/recordFixture';

beforeEach(resetDb);

describe('deriveSlug', () => {
  // The accented cases are real institution names from the target market
  // (AGENTS.md: primary adopter is African university teams, including
  // Francophone institutions), not an abstract Unicode-property exercise —
  // this documents the product requirement, not just the code's behaviour.
  // Expected values computed empirically (`node -e`, see fix-round-1 report
  // in the SDD workspace), not hand-simulated: NFKD normalisation is easy to
  // get wrong by inspection, which is exactly the error being fixed here.
  it.each([
    ['Makerere AI Lab', 'makerere-ai-lab'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere'],
    ['Université de Kinshasa', 'universite-de-kinshasa'],
    ['École Polytechnique', 'ecole-polytechnique'],
    ['São Paulo Institute', 'sao-paulo-institute'],
    ['Åbo Akademi', 'abo-akademi'],
    ['a'.repeat(80), 'a'.repeat(48)],
  ])('derives %j to %j', (input, expected) => expect(deriveSlug(input)).toBe(expected));
});

describe('createOrgForUser', () => {
  it('makes an existing user the owner of a second organization', async () => {
    const first = { userId: (await buildOrg()).members.owner.userId };   // the owner of one organisation (K0a's buildOrg)
    const second = await createOrgForUser({ userId: first.userId, orgName: 'Second Org' });
    const memberships = await testDb.membership.findMany({ where: { userId: first.userId } });
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.role === 'owner')).toBe(true);
    expect(second.slug).toBe('second-org');
  });

  it('never reports a slug collision to the caller', async () => {
    const x = (await buildOrg()).members.owner.userId;
    const y = (await buildOrg()).members.owner.userId;
    const a = await createOrgForUser({ userId: x, orgName: 'Shared Name' });
    const b = await createOrgForUser({ userId: y, orgName: 'Shared Name' });
    expect(a.slug).toBe('shared-name');
    expect(b.slug).toMatch(/^shared-name-[0-9a-f]{4}$/);   // random, not sequential
  });
});
