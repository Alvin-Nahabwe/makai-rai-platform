import type { Identity } from '@/lib/auth/identity';
import { orgRoleLabel } from '@/lib/authz/roleLabel';
import { membershipsForUser } from '@/lib/data/preauth';
import { roleWord } from '@/lib/shell/copy';
import type { ShellData, ShellOrg } from '@/lib/shell/types';

/**
 * What the signed-in layout reads for the shell (plan 1A Task 11, ruling L2-50; UX-02). Imported by server code only.
 *
 * One read of the person's own active memberships, by the id `requireIdentity()` returned (T1); `orgRoleLabel` once with no
 * organisation, for the platform label, and once per membership. Nothing is read by a slug or an id from the address.
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
