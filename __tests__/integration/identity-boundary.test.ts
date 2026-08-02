import { describe, expect, it } from 'vitest';
import { identityDb } from '../../lib/data/identity';

/**
 * Proves the identityDb tenant-model boundary (see lib/data/identity.ts).
 *
 * `identityDb` connects as `makrai`, a Postgres superuser with BYPASSRLS, so
 * Task 5's RLS policies cannot constrain it — the boundary has to be enforced
 * where the compiler can see it, not left to a doc comment. The
 * `@ts-expect-error` assertions below are the enforcement check: `tsc
 * --noEmit` (which type-checks this file, per tsconfig's `**\/*.ts` include)
 * fails if any of these lines is NOT actually a type error — either because
 * the model was left off the Omit, or because the Omit was ever removed.
 * `vitest run` alone does not type-check and would pass vacuously either way,
 * so this guard is only real when `tsc --noEmit` is run (see task-4-report.md
 * fix-round-1 verification).
 */
describe('identityDb tenant-model boundary', () => {
  it('still exposes User at runtime and in the type', () => {
    expect(typeof identityDb.user.findMany).toBe('function');
  });

  it('still exposes ConsentRecord at runtime and in the type', () => {
    expect(typeof identityDb.consentRecord.findMany).toBe('function');
  });

  it('still exposes $queryRaw, $transaction, $disconnect', () => {
    expect(typeof identityDb.$queryRaw).toBe('function');
    expect(typeof identityDb.$transaction).toBe('function');
    expect(typeof identityDb.$disconnect).toBe('function');
  });

  it('rejects every orgId-bearing model at the type level', () => {
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.project;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.projectMetadata;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.assessment;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.remediationItem;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.organization;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.membership;
    // @ts-expect-error tenant model — unreachable through identityDb, see lib/data/identity.ts
    void identityDb.invitation;
  });
});
