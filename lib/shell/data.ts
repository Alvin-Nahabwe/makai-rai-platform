import { identityPassesGates, type Identity } from '@/lib/auth/identity';
import { orgRoleLabel } from '@/lib/authz/roleLabel';
import { identityDb } from '@/lib/data/identity';
import { membershipsForUser } from '@/lib/data/preauth';
import { resolveOrgDispatch } from '@/lib/org-dispatch';
import type { ShellData, ShellOrg } from '@/lib/shell/types';
import { TERM_ADMIN, TERM_ASSESSOR, TERM_OWNER, TERM_REVIEWER, TERM_VIEWER } from '@/lib/vocabulary/terms';

/** The organisation roles as orgRoleLabel returns them (lower case), and the word the shell shows for each. */
const ROLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  owner: TERM_OWNER.term,
  admin: TERM_ADMIN.term,
  assessor: TERM_ASSESSOR.term,
  reviewer: TERM_REVIEWER.term,
  viewer: TERM_VIEWER.term,
});

/**
 * The role word shown under the person's name (CONSOLIDATED section 2: capitalised, "Viewer"). Any label that is not one of
 * the five roles is shown as it is, never hidden; it is looked up as an own property, so a label such as "toString" is
 * not mistaken for one. Here, on the server, and not in the client-imported copy module: the vocabulary's definitions
 * would otherwise ship to every signed-in page (ruling X-2).
 */
export function roleWord(label: string): string {
  return Object.hasOwn(ROLE_WORDS, label) ? ROLE_WORDS[label] : label;
}

/**
 * What the signed-in layout reads for the shell (plan 1A Task 11, ruling L2-50; UX-02). Imported by server code only.
 *
 * One read of the person's own active memberships, by the id `requireIdentity()` returned (T1); then `orgRoleLabel` once with
 * no organisation, for the platform label, and once per membership, each of which reads again (1 + N reads, as the old
 * layout made). Nothing is read by a slug or an id from the address.
 * `membershipsForUser` returns the whole organisation row with each membership, so only its slug and name are copied out:
 * that is all a client component of the shell receives (T2). The account's platform role field is not passed on (D-10).
 * The role labels are own properties of a plain object, so an organisation whose slug is `__proto__` puts no key on
 * Object.prototype, and a lookup by an address's slug finds only the person's own organisations (T3).
 *
 * homeSlug (workshop walk finding S4) is the organisation `/` would send the person to, for the rail's links on pages whose
 * address carries no slug: the only organisation of a person in one; for a person in two or more, the one their
 * last-active hint names, chosen by resolveOrgDispatch exactly as app/page.tsx does, so the hint (unconstrained text,
 * D-069) only ever selects among these memberships and is never itself a slug. The hint is read, by the person's own id,
 * only when there are two or more memberships. Null for the administrator, for a person in none, and with no usable hint.
 *
 * A person held at a sign-in gate (a password change due, or a legal text not yet accepted: identityPassesGates, the
 * written copy of requireIdentity's gates 2 and 3) gets the shell of a person in no organisation: no organisation, no role
 * word, no home slug, so the rail on S-05, S-21 and S-29 links to no organisation page they cannot reach yet (coordinator
 * ruling of 14 November 2026, after S4 gave those links real addresses). Their memberships are not read, as on Help
 * (app/help/layout.tsx). The acceptance read is the one requireIdentity already made in this request (React cache()).
 */
export async function loadShellData(identity: Identity): Promise<ShellData> {
  if (!(await identityPassesGates(identity))) {
    const platformLabel = await orgRoleLabel(identity, undefined);
    return { userId: identity.userId, userName: identity.name || '', platformLabel, roleLabels: {}, orgs: [], homeSlug: null };
  }
  const memberships = await membershipsForUser(identity.userId);
  const [platformLabel, ...orgLabels] = await Promise.all([
    orgRoleLabel(identity, undefined),
    ...memberships.map((m) => orgRoleLabel(identity, m.org.slug)),
  ]);
  // Object.fromEntries defines each key as an own property (it never calls the __proto__ setter), and the object stays a
  // plain one: React refuses a null-prototype object as a prop of a client component.
  // The platform administrator holds no membership by rule; a stray row's name and role do not reach the browser.
  if (platformLabel !== null) {
    return { userId: identity.userId, userName: identity.name || '', platformLabel, roleLabels: {}, orgs: [], homeSlug: null };
  }
  const roleLabels: Record<string, string> = Object.fromEntries(
    memberships.flatMap((m, i) => {
      const label = orgLabels[i];
      return label === null ? [] : [[m.org.slug, roleWord(label)] as const];
    }),
  );
  const orgs: ShellOrg[] = memberships
    .map((m) => ({ slug: m.org.slug, name: m.org.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return { userId: identity.userId, userName: identity.name || '', platformLabel, roleLabels, orgs, homeSlug: await homeSlugOf(identity, memberships) };
}

/** The slug `/` would redirect to (see loadShellData), or null. */
async function homeSlugOf(identity: Identity, memberships: Awaited<ReturnType<typeof membershipsForUser>>): Promise<string | null> {
  if (memberships.length === 0) return null;
  if (memberships.length === 1) return memberships[0].org.slug;
  const user = await identityDb.user.findUnique({ where: { id: identity.userId }, select: { lastActiveOrgId: true } });
  const dispatch = resolveOrgDispatch(user?.lastActiveOrgId ?? null, memberships);
  return dispatch.kind === 'redirect' ? dispatch.slug : null;
}
