import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Non-tenant data only: User and ConsentRecord.
 *
 * These have no orgId and no org context — login reads User before any
 * organization is known. 17 of 50 call sites are in this category, which is
 * why a single universal wrapper cannot serve the app (ADR-0001).
 *
 * Do NOT reach tenant models through this client. Use withOrg().
 */
export const identityDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});
