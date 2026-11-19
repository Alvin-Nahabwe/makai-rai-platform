import type { Actor } from '@/types/record';
import type { LoadedContent } from '@/types/content';
import { assertCan, withOrg, type OrgContext } from '@/lib/data/tenant';
import { readDraftRecord, type DraftRecord } from '@/lib/data/documents';
import { resolveRunningContentVersion } from '@/lib/data/framework';
import { isSerializationFailure } from '@/lib/data/pgErrors';
import { loadContent } from '@/lib/content/loader';
import { buildWorkingReportSummary, type WorkingReportSummary } from '@/lib/documents/workingReport';

/**
 * The working report's reads (path to outputs, Task 9; design G1, §5). Reads only: nothing here writes a row, so a draft never lands in
 * issued_documents (anti-goal 5), and there is no `assertProjectWritable`, so a reader of an archived project gets its report.
 */

/** The one snapshot's time limit. A draft reads every stage's rows; the default 5 s is the seal path's, which reads one. */
export const WORKING_REPORT_TIMEOUT_MS = 15_000;

/**
 * The draft record of a project, its page-1 summary, and the RUNNING content both were built against, all from one REPEATABLE READ
 * snapshot (NFR-INT-10; Task 6 review M6). `readDraftRecord` sets no isolation of its own, so it is set here. A serialisation failure
 * is retried once in a new transaction; a second one is thrown. A project not in the organisation is `NotFoundError`.
 */
export async function readWorkingReport(
  ctx: OrgContext, actor: Actor, projectId: string,
): Promise<{ record: DraftRecord; summary: WorkingReportSummary; content: LoadedContent }> {
  assertCan(ctx, 'record:read');
  const once = () => withOrg(ctx, async (tx) => {
    const record = await readDraftRecord(tx, projectId, actor);
    // The running content of this snapshot, never a version an answer was recorded against (the composer refuses any other).
    const content = loadContent((await resolveRunningContentVersion(tx)).semver);
    return { record, summary: buildWorkingReportSummary(record, content), content };
  }, { isolationLevel: 'RepeatableRead', timeoutMs: WORKING_REPORT_TIMEOUT_MS });
  try {
    return await once();
  } catch (e) {
    if (!isSerializationFailure(e)) throw e;
    return once();
  }
}
