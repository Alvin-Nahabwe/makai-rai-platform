import type { Actor, Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { NotFoundError, type OrgContext } from '@/lib/data/tenant';
import { ValidationFailed } from '@/lib/http/errors';
import { readWorkingReport } from '@/lib/data/workingReport';
import type { WorkingReportPart } from '@/lib/documents/workingReport';
import { composeWorkingReport, renderWorkingReportPdf } from '@/lib/documents/render/workingReport';

/**
 * The working report as a download (path to outputs, Task 9; design §7). A thin wrapper: the order of the parts is
 * `workingReportPages`'s in lib/documents/workingReport.ts and the pages are `composeWorkingReport`'s (Task 8), each defined once
 * (conflict 14), so this module defines no order of its own. It is the one lib/data module that renders.
 *
 * The render runs after the snapshot's transaction has closed, so a slow render holds no connection and no snapshot (§5, the workshop).
 */

/** The report's parts by name. `all` is also what an absent `?part=` means. */
const PARTS: ReadonlySet<string> = new Set<WorkingReportPart>(['all', 'summary', 'data_card', 'model_card', ...STAGES.map((s) => `mitigation_plan:${s}` as const)]);
export const PART_MESSAGE = 'Choose the whole report, the summary, the data card, the model card, or the mitigation plan of one stage.';

/** `?part=` as a part, or a 422 on field `part` (the invalid-parameter answer the decision route gives `stage`). Absent is the whole report. */
export function parseWorkingReportPart(raw: string | null): WorkingReportPart {
  if (raw === null) return 'all';
  if (!PARTS.has(raw)) throw new ValidationFailed([{ field: 'part', message: PART_MESSAGE }]);
  return raw as WorkingReportPart;
}

/** The file-name word of each part: no colon, no team text. */
const fileWord = (part: WorkingReportPart): string => part.replaceAll(':', '-').replaceAll('_', '-');

/**
 * The PDF of `part` of a project's working report. A stage's plan asked for by name answers 404 when that stage has no answers: the
 * whole report leaves it out too (§7). The file name is `working-report-draft-<YYYY-MM-DD>-<part>.pdf`, the day the answers were read (EAT).
 */
export async function workingReportPdf(
  ctx: OrgContext, actor: Actor, projectId: string, part: WorkingReportPart,
): Promise<{ bytes: Buffer; fileName: string }> {
  const { record, content } = await readWorkingReport(ctx, actor, projectId);
  if (part.startsWith('mitigation_plan:') && !record.stagesWithAnswers.includes(part.slice('mitigation_plan:'.length) as Stage)) {
    throw new NotFoundError();
  }
  const { pages, title } = composeWorkingReport(record, content, part);
  const { pdf } = await renderWorkingReportPdf(pages, title);
  return { bytes: pdf, fileName: `working-report-draft-${record.today}-${fileWord(part)}.pdf` };
}
