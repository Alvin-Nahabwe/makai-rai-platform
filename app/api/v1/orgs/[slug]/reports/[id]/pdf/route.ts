import type { ReactElement } from 'react';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { ReportPdf, type EvidenceManifestRow } from '@/lib/pdf/ReportPdf';
import { generateReportData } from '@/lib/engine/AssessmentEngine.js';
import { resolveFramework } from '@/lib/data/framework';
import { listEvidenceForAssessment } from '@/lib/data/evidence';
import { isFrameworkDrifted } from '@/lib/report/provenance';
import type { EngineState, ReportData } from '@/types/domain';

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
 * `uploadedById` is nullable (Task 6, O-5.2: scrubbed on user erasure,
 * bytes and metadata survive) — a null id, or one absent from `names`
 * (should not happen in practice, but this function does not assume its
 * caller got that right), both render as 'Unknown', matching the
 * assessor-name fallback's own established convention two lines below in
 * `GET`.
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
    const { assessment, resolution, evidence } = await withOrg(ctx, async (tx) => {
      const assessment = await tx.assessment.findUnique({
        where: { id },
        include: { project: { select: { name: true } } },
      });
      if (!assessment) return { assessment: null, resolution: null, evidence: [] };

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
      return { assessment, resolution, evidence };
    });

    if (!assessment || !resolution) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // One combined lookup for every name this document renders — the
    // assessor plus every DISTINCT evidence uploader — rather than a
    // separate identity-connection round trip per name.
    // `uploadedById` is nullable (Task 6, O-5.2: scrubbed on user erasure,
    // bytes and metadata survive); null ids are never looked up and always
    // render as 'Unknown' below, matching the assessor fallback's own
    // established convention.
    const uploaderIds = evidence
      .map((row) => row.uploadedById)
      .filter((uploadedById): uploadedById is string => uploadedById !== null);
    const names = await lookupUserNames([assessment.userId, ...uploaderIds]);
    const assessorName = names.get(assessment.userId)?.name || 'Unknown';

    const reportData = (assessment.reportData ??
      generateReportData(assessment.engineState as unknown as EngineState)) as unknown as ReportData;

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
