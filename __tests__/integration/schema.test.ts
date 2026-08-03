import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function mkUser(email: string) {
  return testDb.user.create({ data: { email, name: email, passwordHash: 'x' } });
}

describe('organization schema', () => {
  beforeEach(resetDb);

  it('enforces a unique org slug', async () => {
    await testDb.organization.create({ data: { name: 'A', slug: 'dup' } });
    await expect(
      testDb.organization.create({ data: { name: 'B', slug: 'dup' } }),
    ).rejects.toThrow();
  });

  it('allows one membership per (org, user) and rejects a second', async () => {
    const u = await mkUser('m@x.org');
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'o' } });
    await testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'owner' } });
    await expect(
      testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'viewer' } }),
    ).rejects.toThrow();
  });

  it('lets one user belong to two organizations', async () => {
    const u = await mkUser('multi@x.org');
    const a = await testDb.organization.create({ data: { name: 'A', slug: 'a' } });
    const b = await testDb.organization.create({ data: { name: 'B', slug: 'b' } });
    await testDb.membership.create({ data: { orgId: a.id, userId: u.id, role: 'owner' } });
    await testDb.membership.create({ data: { orgId: b.id, userId: u.id, role: 'viewer' } });
    expect(await testDb.membership.count({ where: { userId: u.id } })).toBe(2);
  });

  it('enforces a unique invitation token', async () => {
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'inv' } });
    const u = await mkUser('inviter@x.org');
    const base = { orgId: o.id, email: 'a@x.org', role: 'viewer' as const,
                   invitedById: u.id, expiresAt: new Date(Date.now() + 86400000) };
    // tokenHash must satisfy invitations_tokenHash_is_sha256_hex — 64 lowercase hex chars.
    const digest = 'a'.repeat(64);
    await testDb.invitation.create({ data: { ...base, tokenHash: digest } });
    await expect(
      testDb.invitation.create({ data: { ...base, tokenHash: digest } }),
    ).rejects.toThrow();
  });

  it('stores invitation tokens only as a sha256 hex digest, enforced by CHECK', async () => {
    const rows = await testDb.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invitations'::regclass AND contype = 'c'
        AND conname = 'invitations_tokenHash_is_sha256_hex'`;
    expect(rows).toHaveLength(1);
  });

  it('rejects a plaintext token in tokenHash', async () => {
    await expect(
      testDb.$executeRawUnsafe(
        `INSERT INTO "invitations" ("id","orgId","email","role","tokenHash","invitedById","expiresAt")
         VALUES ('i1','o1','a@b.c','viewer','not-a-digest','u1', now() + interval '7 days')`),
    ).rejects.toThrow(/invitations_tokenHash_is_sha256_hex|violates check constraint/);
  });

  it('gives every user a sessionEpoch defaulting to 0', async () => {
    const [col] = await testDb.$queryRaw<{ column_default: string; is_nullable: string }[]>`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'sessionEpoch'`;
    expect(col.is_nullable).toBe('NO');
    expect(col.column_default).toBe('0');
  });

  it('has removed the vestigial Legacy organization', async () => {
    const rows = await testDb.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'`;
    expect(rows).toHaveLength(0);
  });
});
