import { Document, renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { cloneElement, type ReactElement } from 'react';
import type { LoadedContent } from '@/types/content';
import { runningContent } from '@/lib/content/loader';
import { draftSnapshot, type DraftRecord } from '@/lib/data/documents';
import { loadFieldMap } from '../fieldMaps';
import { DOCUMENT_TITLES, WORKING_REPORT_TITLE } from '../copy';
import { resolveFields } from '../resolve';
import { buildWorkingReportSummary, workingReportPages, type WorkingReportPart } from '../workingReport';
import { registerPdfFont } from './font';
import { fieldDocumentPage } from './frame';
import { summaryPage } from './summaryPage';

/**
 * The working report as a PDF (path to outputs, Task 8; design G1). The order of its parts is `workingReportPages`'s, defined once in the
 * render-free module; this file only maps each part to a page. Every part is built from the one `DraftRecord`, so page 1 and the draft plans
 * list the same open items, and every page carries the draft line (anti-goal 1).
 */

export type { WorkingReportPart };
export type ComposedPage = { page: ReactElement; plainText: string };

/**
 * The pages of `part`, each with its plain text, and the title the PDF carries. `content` is the RUNNING content version, which the
 * resolvers read themselves. The parameter is kept so a caller that already loaded the content passes the one it means, and the guard is the check that it is
 * the running one: a recorded version here would show page 1's controls from one content and the plans' from another, so it is refused.
 */
export function composeWorkingReport(r: DraftRecord, content: LoadedContent, part: WorkingReportPart): { pages: ComposedPage[]; title: string } {
  const now = runningContent();
  if (content.semver !== now.semver || content.contentHash !== now.contentHash) {
    throw new Error(`composeWorkingReport: given content ${content.semver}, but the running content is ${now.semver}; a draft is built from the running content`);
  }
  const refs = workingReportPages(r, part);
  const pages = refs.map((ref): ComposedPage => {
    if (ref.kind === 'summary') return summaryPage(buildWorkingReportSummary(r, content), { organisationName: r.organisationName, projectName: r.project.name });
    const map = loadFieldMap(ref.documentType);
    const resolved = resolveFields(map, draftSnapshot(r, ref.documentType, ref.reviewStage), {});
    return fieldDocumentPage(
      { map, fields: resolved.fields, stamp: { kind: 'draft', takenAt: r.takenAt }, organisationName: r.organisationName, projectName: r.project.name },
      DOCUMENT_TITLES[ref.documentType],
    );
  });
  const only = refs.length === 1 ? refs[0] : null;
  return { pages, title: only !== null && only.kind === 'document' ? DOCUMENT_TITLES[only.documentType] : WORKING_REPORT_TITLE };
}

/** The one document of `pages` in order. `title` is the document type alone (NFR-SEC-11). Rendered here or on a worker (pdfWorkerPool.ts). */
export function workingReportDocument(pages: ComposedPage[], title: string): ReactElement<DocumentProps> {
  return <Document title={title} language="en">{pages.map((p, i) => cloneElement(p.page, { key: `page-${i}` }))}</Document>;
}

/** One PDF of `pages` in order, rendered on this thread, and their plain text joined with a blank line between. */
export async function renderWorkingReportPdf(pages: ComposedPage[], title: string): Promise<{ pdf: Buffer; plainText: string }> {
  registerPdfFont();
  const pdf = await renderToBuffer(workingReportDocument(pages, title));
  return { pdf, plainText: pages.map((p) => p.plainText).join('\n') };
}
