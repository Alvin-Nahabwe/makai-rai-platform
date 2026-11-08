import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { adminRecordAgreement } from '@/lib/data/definer';
import { agreementForAdmin, parseAgreementBody } from '@/lib/data/admin';
import { eatDate } from '@/lib/followup/overdue';
import { requestDigest } from '@/lib/data/idempotency';

/**
 * Contract route row 43, S-24 (FR-ORG-05, FR-ORG-06): record a newer agreement version, or the first one of an
 * organisation created before agreements were recorded, through `admin_record_agreement` and its
 * `agreement_recorded` row. Earlier records are kept, never edited. An unknown organisation answers 404. Retry-safe
 * by `requestId` (NFR-INT-02): a repeat answers the first record with 200; the same id with another body, 409
 * `request_id_reused`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin');
    const { orgId } = await params;
    const { requestId, agreement } = parseAgreementBody(await readJsonBody(req), eatDate(new Date()));
    const digest = requestDigest({ path: { orgId }, body: { ...agreement, requestId } });
    const { agreementId, replayed } = await adminRecordAgreement({ actorUserId: identity.userId, orgId, agreement, requestId, digest });
    if (!replayed) logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'agreement_recorded', orgId, agreementId, requestId } });
    return NextResponse.json(await agreementForAdmin(agreementId), { status: replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
