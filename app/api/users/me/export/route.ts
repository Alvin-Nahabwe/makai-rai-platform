import { NextResponse } from 'next/server';
import { requireIdentityForApi, UnauthenticatedError } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';

/**
 * Personal data only — no assessments, no projects (O-17). Those are
 * tenant data belonging to the organization(s) the user is a member of,
 * not exclusively to the user; exporting them here on the non-tenant,
 * BYPASSRLS `identityDb` connection would hand back every org's data this
 * user ever touched with no org boundary at all. `identityDb`'s own
 * `assertNoTenantRelation` guard would in fact reject an `include` naming
 * `projects`/`assessments` outright (see lib/data/identity.ts) — this
 * route simply never asks for them.
 */
export async function GET() {
  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw e;
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

  return NextResponse.json(
    { ...user, consentRecords },
    {
      headers: {
        'Content-Disposition': `attachment; filename="makrai-export-${new Date().toISOString().split('T')[0]}.json"`,
      },
    },
  );
}
