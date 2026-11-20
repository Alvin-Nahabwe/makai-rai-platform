import type { Actor, Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { NotFoundError, type OrgContext } from '@/lib/data/tenant';
import { AppError, ValidationFailed } from '@/lib/http/errors';
import { readWorkingReport } from '@/lib/data/workingReport';
import { isSerializationFailure } from '@/lib/data/pgErrors';
import type { WorkingReportPart } from '@/lib/documents/workingReport';
import { availableParallelism } from 'node:os';
import { createLimiter, LimiterRefusedError, type Limiter } from '@/lib/concurrency/limiter';
import { composeWorkingReport, workingReportDocument } from '@/lib/documents/render/workingReport';
import { toPdfTree } from '@/lib/documents/render/pdfTree';
import { createPdfWorkerPool, pdfRenderLanes, type PdfWorkerPool } from '@/lib/documents/render/pdfWorkerPool';

/**
 * The working report as a download (path to outputs, Task 9; design §7). A thin wrapper: the order of the parts is
 * `workingReportPages`'s in lib/documents/workingReport.ts and the pages are `composeWorkingReport`'s (Task 8), each defined once
 * (conflict 14), so this module defines no order of its own. It is the one lib/data module that renders.
 *
 * The render runs after the snapshot's transaction has closed, so a slow render holds no connection and no snapshot (§5, the workshop).
 *
 * Up to 21 participants may download at once (§5; Task 16 measured it). So the read, the composing and the render of one download run
 * behind a limiter of `pdfRenderLanes` permits, and the render runs on a worker thread (pdfWorkerPool.ts), never on the event loop
 * every other page needs. A download waiting for a permit has not started its read, so it holds no database connection. The limiter
 * and the workers live on `globalThis`, once per process: Next bundles this module into more than one chunk, and module state would
 * be one limiter per chunk (Task 16 fix report, finding 6).
 *
 * The wait is bounded (round 2; the controller's ruling on review M1, the reviewer's values): at most 40 downloads wait, about twice
 * the 21-person burst, and the 41st is refused at once; one still waiting after 25 s is refused. Both answer 503 with `Retry-After`
 * (WorkingReportBusyError), so a download is shed rather than left to nginx's 60 s and a bare 504. A download whose request is
 * aborted (its client has gone) leaves the queue and is never read or rendered (the limiter's RequestAbortedError; the route answers it).
 */
export const WORKING_REPORT_QUEUE = Object.freeze({ maxWaiting: 40, maxWaitMs: 25_000, retryAfterSeconds: 10 });
// The refusal sentences live in lib/documents/copy.ts, so the report page can say them without importing this module (it renders).
export { WORKING_REPORT_BUSY_MESSAGE, PART_MESSAGE } from '@/lib/documents/copy';
import { WORKING_REPORT_BUSY_MESSAGE, PART_MESSAGE } from '@/lib/documents/copy';

/** 503 `report_busy`: no render lane came free in time, or too many downloads were already waiting. The route adds `Retry-After`. */
export class WorkingReportBusyError extends AppError {
  readonly retryAfterSeconds = WORKING_REPORT_QUEUE.retryAfterSeconds;
  constructor() {
    super(503, 'report_busy', WORKING_REPORT_BUSY_MESSAGE, { retryAfterSeconds: WORKING_REPORT_QUEUE.retryAfterSeconds });
  }
}

type Lanes = { limiter: Limiter; pool: PdfWorkerPool };
const LANES = Symbol.for('makrai.workingReportPdf.lanes');
function lanes(): Lanes {
  const store = globalThis as unknown as { [LANES]?: Lanes };
  if (store[LANES] === undefined) {
    const size = pdfRenderLanes(availableParallelism());
    const { maxWaiting, maxWaitMs } = WORKING_REPORT_QUEUE;
    store[LANES] = { limiter: createLimiter(size, { maxWaiting, maxWaitMs }), pool: createPdfWorkerPool({ size }) };
  }
  return store[LANES];
}

/** Prisma's P2028: an interactive transaction that could not start in time, or that expired. */
const isTransactionTimeout = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2028';

/** The report's parts by name. `all` is also what an absent `?part=` means. */
const PARTS: ReadonlySet<string> = new Set<WorkingReportPart>(['all', 'summary', 'data_card', 'model_card', ...STAGES.map((s) => `mitigation_plan:${s}` as const)]);

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
 * `signal` is the request's: aborted while the download waits, it is dropped from the queue (RequestAbortedError).
 */
export async function workingReportPdf(
  ctx: OrgContext, actor: Actor, projectId: string, part: WorkingReportPart, signal?: AbortSignal,
): Promise<{ bytes: Buffer; fileName: string }> {
  const { limiter, pool } = lanes();
  try {
    return await limiter.run(() => readAndRender(), { signal });
  } catch (e) {
    // A full queue, a second serialisation failure of the read (readWorkingReport retries the first), or a transaction that could
    // not start or ran out of time (P2028) is contention under a burst, not a bug: "try again", never the generic 500 (fix wave
    // item 15; silent-failure audit M4).
    if (e instanceof LimiterRefusedError || isSerializationFailure(e) || isTransactionTimeout(e)) throw new WorkingReportBusyError();
    throw e;
  }

  async function readAndRender(): Promise<{ bytes: Buffer; fileName: string }> {
    const { record, content } = await readWorkingReport(ctx, actor, projectId);
    if (part.startsWith('mitigation_plan:') && !record.stagesWithAnswers.includes(part.slice('mitigation_plan:'.length) as Stage)) {
      throw new NotFoundError();
    }
    const { pages, title } = composeWorkingReport(record, content, part);
    const pdf = await pool.render(toPdfTree(workingReportDocument(pages, title)));
    return { bytes: pdf, fileName: `working-report-draft-${record.today}-${fileWord(part)}.pdf` };
  }
}
