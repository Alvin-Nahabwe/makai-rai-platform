import type { ReactElement } from 'react';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeAssessment } from '@/lib/authz';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { generateReportData } from '@/lib/engine/AssessmentEngine.js';
import type { EngineState, ReportData } from '@/types/domain';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const assessment = await prisma.assessment.findUnique({
    where: { id },
    include: {
      project: { select: { name: true } },
      user: { select: { name: true } },
    },
  });

  if (!assessment) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const reportData = (assessment.reportData ??
    generateReportData(assessment.engineState as unknown as EngineState)) as unknown as ReportData;

  const assessmentDate = (assessment.completedAt || assessment.startedAt)
    .toISOString()
    .split('T')[0];

  const pdfBuffer = await renderToBuffer(
    ReportPdf({
      reportData,
      projectName: assessment.project.name,
      assessorName: assessment.user.name || 'Unknown',
      assessmentDate,
    }) as ReactElement<DocumentProps>
  );

  // Restrict the filename to safe characters — the project name is user input
  // and would otherwise allow header/newline injection in Content-Disposition.
  const safeName = assessment.project.name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="RAI-Report-${safeName}-${assessmentDate}.pdf"`,
    },
  });
}
