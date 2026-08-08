import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { resolveFramework } from '@/lib/data/framework';
import { inspect, MAX_BYTES } from '@/lib/evidence/inspect';
import { createEvidence, listEvidenceForAssessment, questionExistsInBank } from '@/lib/data/evidence';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Lists evidence metadata for the assessment named in the URL --
 * `evidence:read`, granted to all five roles. Same "no separate parent
 * existence check" shape as the sibling remediation GET route
 * (../remediation/route.ts): an assessmentId that does not resolve in this
 * org (wrong org, or simply unknown) yields an empty list from
 * `listEvidenceForAssessment`, not a distinguishable 404 -- RLS already
 * confines the read to this org, and a child-listing endpoint returning
 * `[]` for an absent/empty parent is this codebase's established
 * convention (the remediation GET route does the same), not a new decision
 * made here.
 *
 * Not named in the task brief's Step 4 prose, which narrates POST only --
 * but Step 4b's `ROUTE_ACTIONS` snippet declares BOTH methods on this file,
 * and `listEvidenceForAssessment` (built for this task) has exactly this
 * shape. Implemented because declaring `GET` without a real handler fails
 * the permission-matrix suite's `callRoute` by throwing
 * "`... has no exported GET handler`" for every cell that exercises it --
 * see task-6-report.md.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'evidence:read');
    const evidence = await withOrg(ctx, (tx) => listEvidenceForAssessment(id, tx));
    return NextResponse.json(evidence);
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * The first endpoint in this product that accepts bytes from a user. Five
 * ordered accept/reject decisions, each failing closed (task-6-report.md
 * carries the fresh threat model derived for this task):
 *
 *   1. `requireOrgContextWithIdentity` -- identity and role (`evidence:create`).
 *   2. `Content-Length` checked BEFORE the body is read into memory -- a
 *      size LIMIT on the DECLARED length, not a complete DoS control: a
 *      request with no (or an understated) Content-Length still reaches
 *      `req.formData()`, which buffers regardless. See D-152.
 *   3. `inspect(buffer)` -- the client's declared type is DISCARDED, never
 *      corrected (O-7). Runs OUTSIDE `withOrg`: pure CPU, no reason to hold
 *      one of only 10 pooled connections for it.
 *   4. Inside ONE `withOrg` transaction, in this order: framework drift
 *      (O-14), assessment status (O-24), attach-target confinement WITHIN
 *      the org (O-6), questionId existence (O-22).
 *   5. 201 with the metadata row. Never the bytes.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'evidence:create');

    // 2. Size gate BEFORE buffering. Content-Length is attacker-declared:
    // this rejects the common case (an honest or a lazily-overstated
    // declaration) without ever allocating the buffer. It is not a
    // substitute for inspect()'s post-buffer size check below -- a second,
    // independent line, not a duplicate of this one (D-152 records why
    // neither alone is a complete DoS control).
    //
    // `Number.isFinite`/`< 0` guard a silent-failure-hunter finding
    // (task-6-report.md): `Number('abc') > MAX_BYTES` is `NaN > MAX_BYTES`,
    // which is `false` -- a non-numeric or negative header would otherwise
    // silently PASS this gate (treated as if it were a small, valid size)
    // instead of failing closed. A spec-compliant client never sends this
    // (RFC 7230 requires a valid non-negative integer), but this route
    // fails closed on every accept/reject decision regardless of whether a
    // well-behaved client would ever trigger it.
    const declaredLength = req.headers.get('content-length');
    if (declaredLength !== null) {
      const numericLength = Number(declaredLength);
      if (!Number.isFinite(numericLength) || numericLength < 0 || numericLength > MAX_BYTES) {
        // 413 Payload Too Large, not 400 -- fix round 1, Minor 4. HTTP
        // reserves 413 specifically for "the request entity exceeds the
        // server's willingness/ability to process it", which is exactly
        // this case (and the malformed/negative sub-case: a client that
        // cannot even state a valid length is treated the same as one that
        // stated too large a one, not as a generically-malformed request).
        return NextResponse.json({ error: 'File too large' }, { status: 413 });
      }
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (e) {
      // Bound and logged, not discarded (silent-failure-hunter finding,
      // task-6-report.md): a malformed multipart body, a mid-upload client
      // disconnect, and an internal parse failure all deserve a trace, even
      // though every one of them still correctly returns the same 400 to
      // the caller.
      console.error('evidence upload: failed to parse multipart/form-data body', e);
      return NextResponse.json({ error: 'A multipart/form-data body is required' }, { status: 400 });
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    const questionIdField = formData.get('questionId');
    const remediationItemIdField = formData.get('remediationItemId');
    const questionId = typeof questionIdField === 'string' ? questionIdField : null;
    const remediationItemId = typeof remediationItemIdField === 'string' ? remediationItemIdField : null;
    // O-2's database CHECK proves exactly one attach target is ever STORED;
    // failing closed here too turns an obviously malformed request into a
    // clean 400 instead of an unhandled constraint-violation exception
    // surfacing as an opaque 500 (fail closed either way -- no row is
    // created -- but this is the same "clean 4xx before the database"
    // discipline every other route in this file's family already follows,
    // e.g. the assessments POST route's `mode !== 'full'` check).
    if ((questionId === null) === (remediationItemId === null)) {
      return NextResponse.json(
        { error: 'Exactly one of questionId or remediationItemId is required' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // 3. file.type (the client's declared Content-Type) is never read here
    // or anywhere below -- inspect() decides from the bytes alone (O-7).
    const inspected = inspect(buffer);
    if (!inspected.ok) {
      // 'too large' is the SAME underlying condition as the pre-buffer gate
      // above (a Content-Length that was absent or understated let an
      // oversized body reach here) -- fix round 1, Minor 4: it gets the
      // same 413, for the same reason. Every other inspect() rejection
      // ('empty', 'unrecognised file type') is a content-validity problem,
      // not a size problem, and stays 400.
      const status = inspected.reason === 'too large' ? 413 : 400;
      return NextResponse.json({ error: inspected.reason }, { status });
    }

    const outcome = await withOrg(ctx, async (tx) => {
      const resolution = await resolveFramework(id, tx);
      if (!resolution) return { kind: 'not_found' as const, reason: 'assessment_not_found' as const };
      // O-14: deployed content has drifted from what this assessment
      // pinned -- an in-progress assessment accepts no further input,
      // evidence included.
      //
      // Fix round 1, Important 1: this used to share BOTH the `kind` and
      // the client-facing message with O-24's "completed" branch below --
      // both mapped to the identical 409 'Assessment does not accept new
      // evidence'. That made the branch untestable: deleting this check
      // entirely left the whole 1269-test suite green, because no test's
      // assertion could distinguish "rejected for drift" from "rejected
      // because completed" (or, with this check gone, "not rejected at
      // all"). It also mattered beyond test bookkeeping: `questionExistsInBank`
      // (lib/data/evidence.ts) is documented as safe to read as "the PINNED
      // version's bank" only BECAUSE this check ran first and proved
      // `matches === true` -- an untested guard here is one reordering away
      // from silently turning O-22 into "exists in whatever happens to be
      // deployed". `kind: 'drifted'` and its own message (below) make the
      // two conditions distinguishable in both the response body and the
      // security log; see the O-14 non-vacuity proof in task-6-report.md.
      if (!resolution.matches) return { kind: 'drifted' as const };

      // A second, separate read from resolveFramework's own --
      // lib/data/framework.ts exposes no way to read `status` alongside the
      // pin/drift result without either reaching into its private hash
      // constant or this task reaching into a module Task 2 owns (out of
      // this task's file list). `resolution` being non-null already proves
      // this assessment exists (getPinnedVersion performed the identical
      // findUnique inside resolveFramework), so `!assessment` below is not
      // believed reachable -- handled anyway, fail closed, rather than
      // trusting that belief. Given its own distinct reason (rather than
      // reusing 'assessment_not_found') precisely BECAUSE it is not
      // believed reachable: if it ever fires, that is more noteworthy than
      // an attacker guessing a bad id, and conflating the two in the log
      // would hide it.
      const assessment = await tx.assessment.findUnique({ where: { id }, select: { status: true } });
      if (!assessment) return { kind: 'not_found' as const, reason: 'assessment_vanished_unexpectedly' as const };
      // O-24: a completed assessment's evidence set is frozen -- no insert.
      if (assessment.status === 'completed') return { kind: 'conflict' as const };

      // O-6: RLS already confines remediationItemId to THIS org; this
      // confines it further, within the org, to the assessment named in
      // the URL -- a domain check, not a tenant one. Same shape as the
      // sibling remediation PATCH route's identical confinement check
      // (../remediation/route.ts).
      //
      // Fix round 1, Minor 3: this and the two `not_found` branches above
      // used to share one undifferentiated `reason: 'not_found'` in the
      // security log, so repeated probing was VISIBLE (INPUT_VALIDATION_FAILURE
      // fires either way) but not separable from an unlucky typo. The
      // CLIENT-FACING response is deliberately UNCHANGED -- still a bare
      // 404 'Not found', matching every not-found shape elsewhere in this
      // route family (ADR-0001's "never leak more than a generic 404")
      // -- only `details.reason` in the log gains the distinction.
      if (remediationItemId !== null) {
        const target = await tx.remediationItem.findUnique({
          where: { id: remediationItemId },
          select: { assessmentId: true },
        });
        if (!target || target.assessmentId !== id) {
          return { kind: 'not_found' as const, reason: 'remediation_item_mismatch' as const };
        }
      }

      // O-22: O-2's CHECK proves exactly one attach target is stored; it
      // does not prove a questionId target EXISTS.
      if (questionId !== null && !questionExistsInBank(questionId)) {
        return { kind: 'bad_question' as const };
      }

      const row = await createEvidence(
        {
          assessmentId: id,
          frameworkVersionId: resolution.pinned.id,
          questionId,
          remediationItemId,
          filename: file.name,
          mimeType: inspected.mimeType,
          content: buffer,
          uploadedById: identity.userId,
          orgId: ctx.orgId,
        },
        tx,
      );
      return { kind: 'ok' as const, row };
    });

    // Security-event logging (silent-failure-hunter finding, task-6-report.md):
    // every other mutating route in this tree (assessment create/complete,
    // member invite/grant/leave, password change, registration, admin role
    // change) calls `logSecurityEvent`; this route -- the first to accept
    // bytes from a user, and the one this task's own brief calls the most
    // security-sensitive in the plan -- called it nowhere. `INPUT_VALIDATION_FAILURE`
    // on a rejection makes repeated probing (e.g. an O-6 attach-target
    // mismatch, or a guessed questionId) visible in the same stream every
    // other rejection already is; `EVIDENCE_UPLOADED` on success matches
    // the `ASSESSMENT_CREATED` precedent (assessments/route.ts) exactly.
    switch (outcome.kind) {
      case 'not_found':
        // `outcome.reason` carries the internal distinction (assessment
        // unknown vs. an O-6 attach-target mismatch vs. the not-believed-
        // reachable defensive branch) -- logged so repeated probing of one
        // specific shape is distinguishable from another. The RESPONSE
        // below is deliberately the SAME bare 404 regardless of which.
        logSecurityEvent('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'evidence:create', assessmentId: id, reason: outcome.reason },
        });
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'drifted':
        logSecurityEvent('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'evidence:create', assessmentId: id, reason: 'drifted' },
        });
        // O-14. Same 409 as 'conflict' below (both are, correctly, HTTP
        // Conflict), but a DISTINCT message -- see the long comment where
        // this outcome is produced for why the message, not just the
        // `kind`, has to differ.
        return NextResponse.json(
          { error: 'Framework content has drifted since this assessment was pinned' },
          { status: 409 },
        );
      case 'conflict':
        logSecurityEvent('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'evidence:create', assessmentId: id, reason: 'conflict' },
        });
        return NextResponse.json({ error: 'Assessment does not accept new evidence' }, { status: 409 });
      case 'bad_question':
        logSecurityEvent('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'evidence:create', assessmentId: id, reason: 'bad_question' },
        });
        return NextResponse.json(
          { error: 'questionId does not exist in the pinned framework version' },
          { status: 400 },
        );
      case 'ok':
        logSecurityEvent('EVIDENCE_UPLOADED', 'info', {
          userId: identity.userId,
          details: {
            assessmentId: id,
            evidenceId: outcome.row.id,
            mimeType: outcome.row.mimeType,
            byteSize: outcome.row.byteSize,
          },
        });
        // 5. Never the bytes -- `row` is the `evidence` metadata row only;
        // `evidence_blobs` is a separate table createEvidence's return
        // value never touches.
        return NextResponse.json(outcome.row, { status: 201 });
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`evidence upload: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    return toResponse(e);
  }
}
