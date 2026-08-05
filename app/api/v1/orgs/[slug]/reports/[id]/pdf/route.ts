import type { ReactElement } from 'react';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { generateReportData } from '@/lib/engine/AssessmentEngine.js';
import type { EngineState, ReportData } from '@/types/domain';

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
    const assessment = await withOrg(ctx, (tx) =>
      tx.assessment.findUnique({
        where: { id },
        include: { project: { select: { name: true } } },
      }),
    );

    if (!assessment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const names = await lookupUserNames([assessment.userId]);
    const assessorName = names.get(assessment.userId)?.name || 'Unknown';

    const reportData = (assessment.reportData ??
      generateReportData(assessment.engineState as unknown as EngineState)) as unknown as ReportData;

    const assessmentDate = (assessment.completedAt || assessment.startedAt)
      .toISOString()
      .split('T')[0];

    const pdfBuffer = await renderToBuffer(
      ReportPdf({
        reportData,
        projectName: assessment.project.name,
        assessorName,
        assessmentDate,
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
