import type { ReactElement } from 'react';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { ReportPdf, type EvidenceManifestRow } from '@/lib/pdf/ReportPdf';
import { resolveFramework } from '@/lib/data/framework';
import { listEvidenceForAssessment } from '@/lib/data/evidence';
import { isFrameworkDrifted } from '@/lib/report/provenance';
import type { ReportData } from '@/types/domain';

/**
 * O-16's DB-row -> manifest-row shaping step, extracted as its own function
 * (not left inline in `GET` below) so it is directly unit-testable against
 * realistic row shapes without needing to parse @react-pdf/renderer's
 * compiled output. `<Text>` content there is written as hex-encoded
 * glyph-ID show operators, never literal PDF strings (see
 * `lib/pdf/ReportPdf.tsx`'s own module doc comment) — a rendered filename
 * never appears as literal text in a PDF content stream at all, so an
 * integration test grepping decompressed PDF bytes for it cannot pass for
 * the right reason. This function is the actual seam that proves "the
 * route wires real database evidence into the manifest correctly";
 * `ReportPdf`'s own tests (`__tests__/unit/report-provenance.test.tsx`)
 * separately prove "a given `EvidenceManifestRow[]` renders correctly" —
 * two different claims, neither proves the other (AGENTS.md §3).
 *
 * `uploadedById` is nullable in the schema, but NOTHING EVER NULLS IT —
 * corrected here at the C6 whole-branch review (F2). This comment used to
 * say "scrubbed on user erasure", citing O-5.2. That is not what erasure
 * does and could not be: `makrai_app` holds `SELECT, INSERT, DELETE` on
 * `evidence` and deliberately no `UPDATE`
 * (prisma/migrations/20260808140048_evidence_tables/migration.sql:129-134),
 * so no code path can null a column on an evidence row. What erasure
 * actually scrubs is the `users` row (`scrubUserOnDeactivation`,
 * lib/data/identity.ts) — after which `lookupUserNames` returns
 * 'Deleted user' for that id, and THAT is what an erased uploader renders
 * as here. The spec's O-24 and §5.2 have been corrected to match; D-174
 * records the residual (a nullable column, and the `|| 'Unknown'` branch
 * below, kept for a behaviour nothing implements).
 *
 * The `|| 'Unknown'` fallback is therefore not reachable through erasure.
 * It is kept as a total function over the declared types: `uploadedById`
 * IS `string | null` in the Prisma type, and an id absent from `names`
 * (not believed reachable — `GET` builds `names` from these very ids)
 * still has to render as something rather than `undefined`.
 */
export function toEvidenceManifest(
  evidence: Awaited<ReturnType<typeof listEvidenceForAssessment>>,
  names: Map<string, { name: string }>,
): EvidenceManifestRow[] {
  return evidence.map((row) => ({
    filename: row.filename,
    sha256: row.sha256,
    uploaderName: (row.uploadedById && names.get(row.uploadedById)?.name) || 'Unknown',
    uploadedAt: row.uploadedAt.toISOString().split('T')[0],
  }));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:read');

    // Fetch INSIDE withOrg, then let the transaction close before the
    // CPU-bound `renderToBuffer` call below. Holding a pooled connection
    // (max: 10, Prisma's interactive-transaction timeout/maxWait unpinned —
    // D-065) for the duration of a PDF render is an intermittent-failure
    // trap under concurrent load; fetch-then-render keeps the transaction
    // short regardless of render cost.
    // No `user` relation `include` — `makrai_app` has no grant on `users`
    // (lib/data/identity.ts#lookupUserNames). `userId` is read as a scalar
    // column and the assessor's name attached afterwards.
    //
    // O-15/O-16 (Task 9): `resolution` (semver/contentHash/matches) and
    // `evidence` (the manifest source) are fetched in this SAME withOrg
    // call, alongside the existing assessment read — one transaction, same
    // discipline the evidence upload route already established
    // (app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts). Evidence
    // is read through `listEvidenceForAssessment`, never a raw query, so it
    // stays metadata-only by construction (O-16: "not the bytes") and RLS-
    // scoped to this org exactly like every other tenant read (ADR-0001) —
    // no ad hoc `orgId` filter is added or would even be meaningful here.
    const outcome = await withOrg(ctx, async (tx) => {
      const assessment = await tx.assessment.findUnique({
        where: { id },
        include: { project: { select: { name: true } } },
      });
      if (!assessment) return { kind: 'not_found' as const };

      // C6 F1's gate, placed HERE rather than after this transaction closes
      // — moved by the fix wave's `simplify`/efficiency pass. `status` is a
      // plain scalar on the row `findUnique` just returned, so refusing at
      // this point costs nothing extra, while refusing later meant running
      // `resolveFramework` and `listEvidenceForAssessment` first and
      // discarding both: two round trips, held on one of only 10 pooled
      // connections (lib/data/tenant.ts), for a response whose body is a
      // static string that uses neither. This handler's own comment above
      // is explicit about keeping this transaction short; the gate now
      // carries that discipline through instead of undoing it.
      //
      // See the switch below for WHY a non-completed assessment is refused
      // at all, and why 409.
      if (assessment.status !== 'completed') return { kind: 'not_completed' as const };

      const resolution = await resolveFramework(id, tx);
      // `resolution` reads the SAME assessment row, inside the SAME
      // transaction/snapshot, that the findUnique above just proved exists
      // — not believed reachable (same posture Task 6's upload route takes
      // for its own analogous "not believed reachable" branch), but failing
      // closed rather than trusting that belief: caught below and turned
      // into a loud 500 via toResponse's rethrow, never a silently wrong
      // provenance line.
      if (!resolution) {
        throw new Error(
          `resolveFramework returned null for assessment ${id} despite it resolving moments earlier in the same transaction`,
        );
      }

      const evidence = await listEvidenceForAssessment(id, tx);
      return { kind: 'ok' as const, assessment, resolution, evidence };
    });

    // C6 whole-branch review, F1 (HIGH). THE INVARIANT THIS ESTABLISHES:
    // the document never asserts a provenance it cannot support.
    //
    // Before this gate, an in-progress assessment with at least one
    // completed stage rendered a full PDF whose scores came from
    // `generateReportData(assessment.engineState)` — and that function
    // scores through `AssessmentEngine.js`'s STATIC imports of
    // `data/questionBank.json` and `data/scoringConfig.json`, i.e. whatever
    // content is DEPLOYED right now, never the content this assessment is
    // pinned to. The header then stamped `resolution.pinned.contentHash` on
    // that document. Worse, the disclosure was suppressed by construction
    // rather than by accident: `isFrameworkDrifted` (lib/report/provenance.ts)
    // returns false for any status other than 'completed', so the drift
    // banner could not fire for exactly the case that needed it.
    //
    // WHY A STATUS GATE RATHER THAN A SMARTER DRIFT RULE. Both were open;
    // this one is chosen because a banner can only DISCLOSE a false
    // provenance line, never make it true — the line would still read
    // "assessed against ... content <pinned hash>" over numbers computed
    // from other content. Refusing to emit the document is the only shape
    // that makes the assertion unconditionally supportable. It also makes
    // the two report surfaces agree: the HTML report page redirects a
    // non-completed assessment away entirely
    // (app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx),
    // so no product flow loses a capability — only the directly-typed URL
    // did, and what it returned was wrong. Deferred alternative (a
    // pinned-content draft export) is D-183.
    //
    // 409, not 404: the assessment exists and the caller may read it; the
    // request conflicts with its CURRENT state, which is the same reading
    // every other refusal in this route family gives the code (the drift
    // 409s on PATCH, complete, and evidence upload). The message is
    // distinct from all of them, for the reason those three already
    // establish — a shared message makes a deleted guard untestable.
    //
    // Early returns rather than this codebase's usual `switch` +
    // `_exhaustive: never`: those sites return in EVERY branch, whereas the
    // 'ok' path here continues for another forty lines. Two guards then a
    // destructure lets TypeScript narrow `outcome` to the 'ok' variant for
    // the rest of the handler, which a switch would not.
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (outcome.kind === 'not_completed') {
      return NextResponse.json(
        {
          error:
            'This assessment is not completed, so it has no report to export. ' +
            'Complete the assessment first.',
        },
        { status: 409 },
      );
    }
    const { assessment, resolution, evidence } = outcome;

    // One combined lookup for every name this document renders — the
    // assessor plus every DISTINCT evidence uploader — rather than a
    // separate identity-connection round trip per name.
    // `uploadedById` is nullable in the schema but is never nulled by any
    // code path — see `toEvidenceManifest`'s doc comment above for the
    // grant-model reason and for what user erasure actually scrubs (the
    // `users` row, so an erased uploader renders as 'Deleted user', not
    // 'Unknown'). This filter is a type-level total-function guard, not the
    // erasure handling the comment here used to claim it was (C6 F2).
    const uploaderIds = evidence
      .map((row) => row.uploadedById)
      .filter((uploadedById): uploadedById is string => uploadedById !== null);
    const names = await lookupUserNames([assessment.userId, ...uploaderIds]);
    const assessorName = names.get(assessment.userId)?.name || 'Unknown';

    // No `?? generateReportData(...)` fallback any more — see the status
    // gate above for why computing one here was the defect, not the
    // convenience it looked like. `completeAssessment`
    // (lib/data/assessments.ts) is the ONLY writer of `status: 'completed'`
    // in the codebase (both of its branches), and both write `reportData`
    // in the SAME `tx.assessment.update`, so a completed row without a
    // cached report is not reachable through any code path that exists.
    // Thrown rather than trusted anyway, and thrown rather than
    // silently regenerated: a null here means the invariant that makes the
    // provenance line true has been broken somewhere, and the honest
    // response to that is a loud 500 via `toResponse`'s rethrow, never a
    // document computed from content nobody checked.
    if (assessment.reportData === null) {
      throw new Error(
        `assessment ${id} is completed but has no cached reportData — refusing to compute one from deployed content under a pinned provenance line`,
      );
    }
    const reportData = assessment.reportData as unknown as ReportData;

    const assessmentDate = (assessment.completedAt || assessment.startedAt)
      .toISOString()
      .split('T')[0];

    // O-15: the pin date is THIS ASSESSMENT's own `startedAt`, not
    // `framework_versions.publishedAt` — see
    // `lib/report/provenance.ts#ProvenanceInfo` for why.
    const frameworkPinnedDate = assessment.startedAt.toISOString().split('T')[0];

    // Raw values, deliberately NOT sanitized here — `ReportPdf` itself
    // applies `sanitizeManifestText` at the point it renders `filename` and
    // `uploaderName` (see that component's own doc comments). Enforcing it
    // in only ONE place, at the actual rendering boundary the non-vacuity
    // test pins, rather than here AND there — the same "two mechanisms for
    // one fact can disagree" reasoning design decision #6 gives for why
    // `evidenceLevel` had to become derived rather than hand-set twice.
    const evidenceManifest = toEvidenceManifest(evidence, names);

    const pdfBuffer = await renderToBuffer(
      ReportPdf({
        reportData,
        projectName: assessment.project.name,
        assessorName,
        assessmentDate,
        frameworkSemver: resolution.pinned.semver,
        frameworkPinnedDate,
        frameworkContentHash: resolution.pinned.contentHash,
        frameworkDrifted: isFrameworkDrifted(assessment.status, resolution.matches),
        evidenceManifest,
      }) as ReactElement<DocumentProps>,
    );

    // Restrict the filename to safe characters — the project name is user
    // input and would otherwise allow header/newline injection in
    // Content-Disposition.
    const safeName = assessment.project.name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="RAI-Report-${safeName}-${assessmentDate}.pdf"`,
      },
    });
  } catch (e) {
    return toResponse(e);
  }
}
