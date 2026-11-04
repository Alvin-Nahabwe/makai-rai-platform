import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { createFileEvidence, createLinkEvidence } from '@/lib/data/evidence';
import { requestDigest } from '@/lib/data/idempotency';
import { MAX_BYTES } from '@/lib/evidence/inspect';
import { parseLinkEvidenceBody } from '@/lib/evidence/link';
import { AppError, ValidationFailed } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 3: add evidence to a project (FR-EVD-01 to 03). Same-origin check, then the gate (no session
 * 401, not a member 404, a role without `evidence:create` 403), then by Content-Type: `multipart/form-data` is a
 * file (text field `requestId`, file field `file`), `application/json` is a link. The digest covers the path id, so
 * one request id reused against another project answers 409 `request_id_reused`. 201 with the item; 200 when the
 * request id was seen before. The platform never fetches a link (FR-EVD-03): this route stores the address only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'evidence:create');
    const actor = { userId: identity.userId, role: ctx.role };
    const contentType = (req.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.startsWith('multipart/form-data')) {
      // Size gate BEFORE buffering. Content-Length is attacker-declared, so inspect() re-checks after buffering.
      // A non-numeric or negative value fails closed: `NaN > MAX_BYTES` is false and would let it through.
      const declaredLength = req.headers.get('content-length');
      if (declaredLength !== null) {
        const numericLength = Number(declaredLength);
        if (!Number.isFinite(numericLength) || numericLength < 0 || numericLength > MAX_BYTES) {
          throw new AppError(413, 'file_too_large');
        }
      }
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        throw new ValidationFailed([{ field: 'file', message: 'Choose a file to upload.' }]);
      }
      const file = form.get('file');
      if (!(file instanceof File)) throw new ValidationFailed([{ field: 'file', message: 'Choose a file to upload.' }]);
      const requestId = form.get('requestId');
      if (typeof requestId !== 'string') throw new ValidationFailed([{ field: 'requestId', message: 'A request id is required.' }]);
      const bytes = Buffer.from(await file.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const digest = requestDigest({ path: { id }, body: { kind: 'file', fileName: file.name, sha256 } });
      const out = await createFileEvidence(ctx, actor, { projectId: id, fileName: file.name, bytes, requestId }, digest);
      return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
    }

    if (contentType.startsWith('application/json')) {
      const body = parseLinkEvidenceBody(await readJsonBody(req));
      const digest = requestDigest({ path: { id }, body });
      const out = await createLinkEvidence(ctx, actor, { projectId: id, url: body.url, label: body.label, requestId: body.requestId }, digest);
      return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
    }

    throw new ValidationFailed([{ field: 'kind', message: 'Send a file as multipart/form-data or a link as JSON.' }]);
  } catch (e) {
    return toResponse(e);
  }
}
