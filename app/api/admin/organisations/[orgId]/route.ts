import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { ADMIN_ROUTE_COPY } from '@/lib/http/api/copy';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { adminCorrectOrgLegalName, adminCorrectOrgName } from '@/lib/data/definer';
import { organisationLegalNameForAdmin, organisationNameForAdmin, parseCorrectOrganisation } from '@/lib/data/admin';

/**
 * Contract route row 42, S-24 (FR-ORG-10): correct an organisation's name through `admin_correct_org_name`, or its
 * institution's legal name through `admin_correct_org_legal_name`, one at a time. The function keeps the earlier
 * value in its `organisation_name_corrected` or `organisation_legal_name_corrected` row. Documents already issued
 * are never regenerated, so they keep the name they printed. An unknown organisation answers 404. A value it already
 * has answers 200 and writes nothing. The name branch answers `{ previousName }`, the legal-name branch
 * `{ previousLegalName }` (null when none was recorded).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin', ADMIN_ROUTE_COPY.notPlatformAdmin);
    const { orgId } = await params;
    const body = parseCorrectOrganisation(await readJsonBody(req));
    if ('legalName' in body) {
      // The legal name it already has: nothing to correct, so no definer call and no S-30 row (C4 ORG-SF-4).
      const current = await organisationLegalNameForAdmin(orgId);
      if (current === body.legalName) return NextResponse.json({ previousLegalName: current }, { status: 200 });
      const { previousLegalName } = await adminCorrectOrgLegalName({ actorUserId: identity.userId, orgId, legalName: body.legalName });
      logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'organisation_legal_name_corrected', orgId } });
      return NextResponse.json({ previousLegalName }, { status: 200 });
    }
    // The name it already has: nothing to correct, so no definer call and no S-30 row (C4 ORG-SF-4).
    const current = await organisationNameForAdmin(orgId);
    if (current === body.name) return NextResponse.json({ previousName: current }, { status: 200 });
    const { previousName } = await adminCorrectOrgName({ actorUserId: identity.userId, orgId, name: body.name });
    logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'organisation_name_corrected', orgId } });
    return NextResponse.json({ previousName }, { status: 200 });
  } catch (e) {
    return toResponse(e);
  }
}
