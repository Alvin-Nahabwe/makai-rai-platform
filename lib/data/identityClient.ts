import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { hmrSingleton, requireDatabaseUrl } from './connection';

/**
 * The one extra identity-lane client of v0.6.0 (00-contract.md, module map): an unguarded
 * PrismaClient on `IDENTITY_DATABASE_URL` (`makrai_identity`, ADR-0009), for the three modules
 * that work on the identity lane outside `identityDb`'s constructed surface and outside the
 * pinned before-context reads of `lib/data/preauth.ts`:
 *
 *   - `lib/data/definer.ts`: calls the eight SECURITY DEFINER functions (the only way the
 *     administrator actions and invitation acceptance write), and reads the organisation ids
 *     those functions are told;
 *   - `lib/data/identityReads.ts`: the reminder run's organisation list and its run lock;
 *   - `lib/data/admin.ts` (ORG): the administrator screens' reads.
 *
 * What it can reach is bounded by the role's grants and the identity_lane policies, not by this
 * module. No other file may import it: ESLint bans the import (`eslint.config.mjs`,
 * `identityClientBanPattern`), and `__tests__/integration/v060-definer-functions.test.ts`
 * enumerates its importers from disk. Its `hmrSingleton` key is pinned in
 * `__tests__/integration/trigger-enumeration.test.ts`, with the URL it is built on.
 *
 * `max: 3`: the process already holds the app pool (10), `identityBaseClient` (5) and the preauth
 * client; the reminder run's lock holds one of these connections for its whole run.
 */
function createIdentityLaneClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: requireDatabaseUrl('IDENTITY_DATABASE_URL'), max: 3, options: '' }),
    ),
  });
}

export const identityLaneClient = hmrSingleton('identityLaneClient', createIdentityLaneClient);
