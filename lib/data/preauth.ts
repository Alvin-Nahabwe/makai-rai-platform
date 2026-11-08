import {
  PrismaClient,
  type Membership,
  type Organization,
  type Invitation,
  type OrgRole,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { withUnavailableStamp } from '../http/supportReference';
import { hmrSingleton, requireDatabaseUrl } from './connection';
import { hashInvitationToken } from './invitationToken';
import { acceptanceRows } from './acceptances';
import { acceptInvitationViaDefiner } from './definer';
import type { AcceptedKind } from '../../types/legal';

/**
 * The before-context reads and writes — and ONLY these.
 *
 * Some reads must happen before any org context exists: resolving which orgs a
 * user belongs to at login, mapping a URL slug to an organization, and looking
 * up an invitation by token. These are inherently cross-org ("which orgs am I
 * in" cannot be org-scoped), so no org_isolation policy can serve them. They run
 * on the identity lane, `makrai_identity` through `IDENTITY_DATABASE_URL`
 * (ADR-0009), whose `identity_lane` policy shows it every row of organizations,
 * memberships and invitations, and whose grants refuse it every other tenant
 * table. Until ADR-0009 this was the schema owner's connection, a superuser.
 *
 * One write belongs here for the same structural reason, outside any
 * organisation's context: `registerFromInvitation` creates an account, its
 * acceptance rows and (through the definer function) its first membership.
 * No function here writes `organizations`, `memberships` or `invitations`
 * directly: organisations are created only by the administrator's definer
 * functions (FR-ORG-01, FR-ORG-04, `lib/data/definer.ts`).
 *
 * That unscoped read is deliberate (ADR-0001, ADR-0009) and must stay small. Do not
 * add a function here without deciding it is genuinely a before-context read or
 * write — __tests__/integration/preauth-surface.test.ts pins this module's
 * exports and will fail if the surface grows. The pin does not constrain what
 * the existing bodies return, so widening one (an added `include:`) is on the
 * reviewer.
 */

function createPreauthClient() {
  return withUnavailableStamp(
    new PrismaClient({
      adapter: new PrismaPg(
        new Pool({ connectionString: requireDatabaseUrl('IDENTITY_DATABASE_URL'), max: 5, options: '' }),
      ),
    }),
  );
}

const preauthClient = hmrSingleton('preauthClient', createPreauthClient);

/**
 * Every lookup key in this module is validated before it reaches Prisma, and
 * that is a security control rather than defensive habit.
 *
 * Prisma DROPS a `where` key whose value is `undefined` instead of rejecting it
 * (its `strictUndefinedChecks` preview feature is off; the schema declares no
 * previewFeatures). On this module that turns a missing argument into "match any
 * row on the platform", and because these functions run on the identity lane,
 * whose policy on organizations, memberships and invitations is `USING (true)`
 * (ADR-0009), nothing downstream re-filters. (Until ADR-0009 it was the
 * superuser owner connection; the exposure was the same.) Found by the C6
 * whole-branch security review and reproduced live 2026-08-03:
 * `invitationByToken(undefined)` returned a live pending invitation, token and
 * `owner` role included, to a caller who supplied nothing.
 *
 * The types say `string`, but the callers are route handlers reading
 * `await req.json()`, which is `any` — so the compiler will not catch it. Note
 * `null` already throws inside Prisma; `undefined` is the dangerous value.
 */
function lookupKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function membershipsForUser(
  userId: string,
): Promise<(Membership & { org: Organization })[]> {
  const key = lookupKey(userId);
  if (key === null) return Promise.resolve([]);
  return preauthClient.membership.findMany({
    where: { userId: key, status: 'active', org: { deletedAt: null } },
    include: { org: true },
  });
}

export function orgBySlug(slug: string): Promise<Organization | null> {
  const key = lookupKey(slug);
  if (key === null) return Promise.resolve(null);
  return preauthClient.organization.findFirst({ where: { slug: key, deletedAt: null } });
}

/**
 * Fails closed: an expired or already-actioned invitation is indistinguishable
 * from a nonexistent one. The trade-off is deliberate — the caller cannot render
 * "your invitation expired" from this alone. Plan 1b adds a separate, explicitly
 * named lookup if that message is wanted, rather than every caller having to
 * remember the two checks.
 *
 * `invitations.tokenHash` stores only a sha256 hex digest (D-097; enforced by
 * the `invitations_tokenHash_is_sha256_hex` CHECK) — the raw token is never
 * persisted, so a lookup must hash the caller's plaintext before comparing.
 * `registerFromInvitation` and route 32 hand the definer function the same
 * digest (`hashInvitationToken`).
 *
 * Widened (Task 8) to include the organization's `name` — the pin test's own
 * comment sanctions this ("the pin does not constrain what the existing
 * bodies return, so widening one... is on the reviewer"): the public
 * accept-invitation page needs to show which org the link is for before the
 * visitor decides to log in or register, and this before-context lookup is
 * the only place that can answer that without itself becoming a second
 * bypass-RLS read. Adds no new failure mode — `org` cannot be null (`orgId`
 * is a required FK) and no new field is exposed beyond the display name.
 */
export function invitationByToken(
  token: string,
): Promise<(Invitation & { org: { name: string; slug: string }; invitedBy: { name: string } }) | null> {
  const key = lookupKey(token);
  if (key === null) return Promise.resolve(null);
  const tokenHash = hashInvitationToken(key);
  return preauthClient.invitation.findFirst({
    // An archived organisation's invitations are as unusable as an expired one (M-23): membershipsForUser
    // and orgBySlug hide such an organisation, so a membership created in it could never be used.
    where: { tokenHash, status: 'pending', expiresAt: { gt: new Date() }, org: { deletedAt: null } },
    // The inviter's account name is shown on S-04 only, never in E-01 (FR-MEM-01, SRS line 591).
    // The slug is read here, before any write, so routes 31 and 32 answer with it without a read after their commit.
    include: { org: { select: { name: true, slug: true } }, invitedBy: { select: { name: true } } },
  });
}

/**
 * The one way an account is created outside the seed script (FR-ACC-01, NFR-SEC-05): from a
 * pending invitation, with its acceptance rows, and with its membership, all in ONE identity-lane
 * transaction (FR-ACC-03, SRS line 485; contract gap G026). The membership is made only by the
 * definer function `accept_invitation` through K0a's wrapper, which is given this same `tx`, so a
 * refusal there (the token used, expired or revoked by a racing request, a mismatched email, a
 * platform administrator) throws inside the callback and rolls back the user and its rows too.
 *
 * CALLER OBLIGATION, as before: `input.email` is the invitation row's own email, read
 * server-side, never a value from the request; `input.kinds` are kinds the person ticked. The
 * version and hash of each acceptance row come from the registry (`acceptanceRows`), and no row
 * carries a client address. A second account for an email fails on the `users.email` unique
 * index (P2002) and rolls back the same way.
 */
export function registerFromInvitation(input: {
  tokenHash: string; email: string; name: string; passwordHash: string; kinds: readonly AcceptedKind[];
}): Promise<{ userId: string; orgId: string; role: OrgRole }> {
  return preauthClient.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email, name: input.name, passwordHash: input.passwordHash,
        termsAccepted: true, termsAcceptedAt: new Date(),
      },
      select: { id: true },
    });
    await tx.consentRecord.createMany({ data: acceptanceRows(user.id, input.kinds) });
    const { orgId, role } = await acceptInvitationViaDefiner({ tokenHash: input.tokenHash, userId: user.id }, tx);
    return { userId: user.id, orgId, role };
  });
}

/**
 * Derived server-side, never chosen. A "that slug is taken" error is an
 * org-existence oracle (D-101), so this has no way to report a collision to
 * its caller. The administrator's organisation creation (routes 41 to 46,
 * FR-ORG-01) derives its slug here and passes it to the definer function.
 *
 * Diacritic folding via `.normalize('NFKD').replace(/\p{M}/gu, '')` (fix
 * round 1, 2026-08-03): the primary adopter is African university teams,
 * including Francophone institutions across the DRC, Senegal, Côte d'Ivoire
 * and Cameroon, for whom "Université" is plausibly the single most common
 * word in an institution name. An earlier version of this function had NO
 * normalisation step at all, on the reasoning that the task-3 brief's own
 * Unicode test vector (`'Ünïcødé & Symbols!!'` -> `'n-c-d-symbols'`) could
 * only be produced without it — that reasoning was correct given that test
 * vector, but the test vector itself was wrong (hand-simulated Unicode
 * normalisation by its author, not computed), and dropping normalisation
 * entirely to match it meant "Université de Kinshasa" silently lost its é.
 * `\p{M}` (the Unicode "Mark" property, matched with the `u` flag) replaces
 * the brief's literal combining-character range (`[̀-ͯ]`, i.e. U+0300–U+036F
 * typed directly into source) — the same idea, but immune to whatever
 * mis-transcribed the literal range in transit.
 *
 * KNOWN RESIDUAL, unchanged by this fix and not solvable by normalisation:
 * NFKD does not decompose letters with no canonical decomposition — "ø"
 * (empirically confirmed, see the fix-round-1 report) is the clearest
 * example, and the same is true of most non-Latin scripts (Amharic, Arabic,
 * Cyrillic, CJK, …). Such a name derives an empty or short slug, which the
 * administrator's route must handle. Tracked as D-112.
 */
export function deriveSlug(orgName: string): string {
  return orgName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining marks so e.g. "é" -> "e", not "-"
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)          // truncate BEFORE trimming: truncating after would
    .replace(/^-+|-+$/g, ''); // let a mid-word cut reintroduce a trailing '-'
}
