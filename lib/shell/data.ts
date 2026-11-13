import type { Identity } from '@/lib/auth/identity';
import { orgRoleLabel } from '@/lib/authz/roleLabel';
import { membershipsForUser } from '@/lib/data/preauth';
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
 */
export async function loadShellData(identity: Identity): Promise<ShellData> {
  const memberships = await membershipsForUser(identity.userId);
  const [platformLabel, ...orgLabels] = await Promise.all([
    orgRoleLabel(identity, undefined),
    ...memberships.map((m) => orgRoleLabel(identity, m.org.slug)),
  ]);
  // Object.fromEntries defines each key as an own property (it never calls the __proto__ setter), and the object stays a
  // plain one: React refuses a null-prototype object as a prop of a client component.
  const roleLabels: Record<string, string> = Object.fromEntries(
    memberships.flatMap((m, i) => {
      const label = orgLabels[i];
      return label === null ? [] : [[m.org.slug, roleWord(label)] as const];
    }),
  );
  const orgs: ShellOrg[] = memberships
    .map((m) => ({ slug: m.org.slug, name: m.org.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return { userId: identity.userId, userName: identity.name || '', platformLabel, roleLabels, orgs };
}
