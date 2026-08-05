import type { OrgRole } from '@prisma/client';

/**
 * The full `OrgRole` domain as a runtime value. `OrgRole` itself is a
 * type-only export from `@prisma/client` (Prisma generates it as a TS union
 * of string literals, not a runtime enum), so anything that needs to
 * iterate "every role" — an invite-role `<select>`, a role-matrix test, a
 * server-side allowlist check — needs its own runtime array, and a
 * `simplify` pass on Task 8 found that array hand-copied in three places
 * (`lib/data/members.ts`'s `INVITABLE_ROLES`,
 * `app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx`'s
 * `ROLES`, and `__tests__/authz/policy.test.ts`'s `ROLES`), "kept in sync by
 * hand" by comment rather than by the type system.
 *
 * Deliberately dependency-free (only a type-only `@prisma/client` import,
 * erased at compile time) so it is safe to import from a CLIENT component —
 * `lib/data/members.ts` cannot fill this role for `MembersManager.tsx`
 * because it also imports `./tenant`, which opens a `Pool`/`PrismaClient` at
 * module scope and must never reach a browser bundle.
 */
export const ALL_ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
