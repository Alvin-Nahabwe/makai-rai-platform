import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { lastActiveOwnerOf } from '@/lib/data/identityReads';
import { AccountRegions } from '@/components/account/AccountRegions';

export const metadata: Metadata = { title: 'My account - MAK-AI RAI Platform' };

/**
 * S-21 My account (FR-ACC-04, FR-ACC-07, FR-ACC-08, FR-EXP-02, FR-EXP-03). Gate 3 lets `/account` through by exact path
 * (ACCEPTANCE_EXEMPT_PATHS, lib/auth/identity.ts), so an account still missing an acceptance reaches it; a flagged account
 * is sent to S-29 like everywhere else. The page reads only the caller's own row and the organisations it alone owns.
 */
export default async function AccountPage() {
  const identity = await requireIdentity();
  const [user, owned] = await Promise.all([
    identityDb.user.findUniqueOrThrow({ where: { id: identity.userId }, select: { reminderEmails: true } }),
    lastActiveOwnerOf(identity.userId),
  ]);
  return <AccountRegions identity={identity} reminderEmails={user.reminderEmails} lastActiveOwnerOf={owned} />;
}
