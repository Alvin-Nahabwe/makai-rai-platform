import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
// @ts-ignore — AssessmentEngine is a plain JS module without type declarations
import { generateReportData } from '@/lib/engine/AssessmentEngine.js';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

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

  const reportData =
    assessment.reportData || generateReportData(assessment.engineState);

  const assessmentDate = (assessment.completedAt || assessment.startedAt)
    .toISOString()
    .split('T')[0];

  const pdfBuffer = await renderToBuffer(
    ReportPdf({
      reportData,
      projectName: assessment.project.name,
      assessorName: assessment.user.name || 'Unknown',
      assessmentDate,
    }) as any
  );

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="RAI-Report-${assessment.project.name.replace(/\s/g, '-')}-${assessmentDate}.pdf"`,
    },
  });
}
