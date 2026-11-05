import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { adminCorrectOrgName } from '@/lib/data/definer';
import { organisationNameForAdmin, parseCorrectName } from '@/lib/data/admin';

/**
 * Contract route row 42, S-24 (FR-ORG-10): correct an organisation's name through `admin_correct_org_name`, which
 * keeps the earlier name in its `organisation_name_corrected` row. Documents already issued are never regenerated,
 * so they keep the name they printed. An unknown organisation answers 404. The name it already has answers 200 and
 * writes nothing.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin');
    const { orgId } = await params;
    const { name } = parseCorrectName(await readJsonBody(req));
    // The name it already has: nothing to correct, so no definer call and no S-30 row (C4 ORG-SF-4).
    const current = await organisationNameForAdmin(orgId);
    if (current === name) return NextResponse.json({ previousName: current }, { status: 200 });
    const { previousName } = await adminCorrectOrgName({ actorUserId: identity.userId, orgId, name });
    logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'organisation_name_corrected', orgId } });
    return NextResponse.json({ previousName }, { status: 200 });
  } catch (e) {
    return toResponse(e);
  }
}
