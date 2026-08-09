import { NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { orgContextsForUser } from '@/lib/auth/context';
import { identityDb } from '@/lib/data/identity';
import { withOrg } from '@/lib/data/tenant';
import { listEvidenceUploadedByUser } from '@/lib/data/evidence';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Personal data only — no assessments, no projects (O-17). Those are
 * tenant data belonging to the organization(s) the user is a member of,
 * not exclusively to the user; exporting them here on the non-tenant,
 * BYPASSRLS `identityDb` connection would hand back every org's data this
 * user ever touched with no org boundary at all. `identityDb`'s own
 * `assertNoTenantRelation` guard would in fact reject an `include` naming
 * `projects`/`assessments` outright (see lib/data/identity.ts) — this
 * route simply never asks for them.
 *
 * Evidence is the one deliberate EXCEPTION to that boundary (Task 11,
 * O-12), and it is not a contradiction of the paragraph above: an
 * assessment's ANSWERS are the organization's governance record (many
 * people jointly produce them, over time, and D-141 already treats an
 * uploaded document's own CONTENTS the same way) — but an `evidence` row's
 * `uploadedById` is a fact about what THIS specific user personally did,
 * the same category `consentRecords` already is. Reached through
 * `withOrg`, never `identityDb` (which has no `evidence` model at all —
 * `RELATION_CLASS` in lib/data/identity.ts marks the `uploadedEvidence`
 * relation 'tenant', and its own `assertNoTenantRelation` guard would
 * reject any attempt to reach it from this connection), scoped in TWO
 * independent ways that both have to hold: `orgContextsForUser` (only
 * orgs the caller currently holds an ACTIVE membership in — the exact
 * scope `requireOrgContext` itself would grant) and
 * `listEvidenceUploadedByUser`'s own `where: { uploadedById }` (only rows
 * THIS user personally uploaded, never a colleague's, even within an org
 * they share). Losing either check widens this route past what the normal
 * `evidence:read` route would ever return to this caller — task-11-brief.md's
 * own constraint: "the export must not become a way to read evidence the
 * caller could not read through the normal route."
 *
 * BYTES ARE NOT INCLUDED. Metadata only — see task-11-report.md for the
 * full reasoning (unbounded aggregate size with no pagination or streaming
 * on this route; base64's ~4/3 inflation on top of that; the per-item
 * download route, `GET .../evidence/[evidenceId]`, already serves the same
 * bytes, verified against the stored SHA-256 on every request, O-9). The
 * metadata below still makes the export a true, complete statement of WHAT
 * the caller uploaded (filename, size, hash, timestamp, which
 * assessment/org) — it does not restate the bytes themselves, the same way
 * this route has never restated a ConsentRecord's underlying policy text,
 * only the record that consent happened.
 */
export async function GET() {
  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    // `toResponse` maps `UnauthenticatedError` -> 401 and (new)
    // `PasswordChangeRequiredError` -> 403 identically to how every other
    // route now does — see lib/http/toResponse.ts. Anything else rethrows.
    return toResponse(e);
  }

  const user = await identityDb.user.findUnique({
    where: { id: identity.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      termsAccepted: true,
      termsAcceptedAt: true,
      researchConsent: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const consentRecords = await identityDb.consentRecord.findMany({
    where: { userId: identity.userId },
    select: { id: true, consentType: true, version: true, granted: true, grantedAt: true },
  });

  // One withOrg call per org the caller is currently an active member of —
  // RLS requires an org-scoped GUC per query, so this cannot be a single
  // cross-org statement (same shape `DELETE /api/users/me`'s own
  // per-org membership teardown already uses, for the identical reason).
  const contexts = await orgContextsForUser(identity.userId);
  const evidenceByOrg = await Promise.all(
    contexts.map((ctx) => withOrg(ctx, (tx) => listEvidenceUploadedByUser(identity.userId, tx))),
  );
  const evidence = evidenceByOrg.flat();

  return NextResponse.json(
    { ...user, consentRecords, evidence },
    {
      headers: {
        'Content-Disposition': `attachment; filename="makrai-export-${new Date().toISOString().split('T')[0]}.json"`,
      },
    },
  );
}
