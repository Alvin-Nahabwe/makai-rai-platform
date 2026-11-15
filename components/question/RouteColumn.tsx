import Link from 'next/link';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { StageMeaning } from '@/components/question/StageMeaning';
import { nextApplyingId, stageFilterSet } from '@/lib/question/route';
import { STAGE_TITLE, type StageFilter } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { QUESTION_COPY } from '@/lib/question/copy';
import { routeTermTips } from '@/components/question/termTips';
import './route-column.css';

/**
 * A mistake in the calling page (components/ui/Table.tsx's rule): outside production it throws, so a test or the
 * development server shows it; in production the column renders and the mistake goes to the server's log, with fixed
 * words and the question id cut to 40 characters.
 */
function mistake(message: string): void {
  if (process.env.NODE_ENV !== 'production') throw new Error(`RouteColumn: ${message}`);
  console.error(`RouteColumn: ${message}`);
}

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; owner's answer R1, 15 November 2026):
 * the stage's questions as one line beside the question. A `<nav>` named by its heading, the stage's name, with the
 * stage's plain meaning and one sentence under it; the filter as a small select above the line; the line itself, the
 * open question "You are here" in the ring, the next one named, the questions away from them folded into runs that open
 * in place (components/question/RouteLine.tsx, lib/question/route.ts); the link to the stage page. At every width the
 * column shows the same line; below 72.5rem it follows the main content (its place is workspace.css's). The data is the
 * stage page's own loader's.
 */
export function RouteColumn({ data, currentQuestionId, show, nextQuestionId }: {
  data: StagePageData; currentQuestionId: string; show: StageFilter;
  /** The page's own next question (the panel's position.nextId, the Next button's); when not given, the same rule over the rows. */
  nextQuestionId?: string | null;
}) {
  // The open question is always one of its stage's rows (the panel refuses a question outside the stage, and both read
  // the running content's stage): if it is not, the column would show no "You are here" and look right (review F1).
  if (!data.rows.some((r) => r.questionId === currentQuestionId)) mistake(`the open question is not in the stage's rows (${currentQuestionId.slice(0, 40)})`);
  const { counts, filters, sealNumber } = stageFilterSet(data.rows, data.changed);
  return (
    <nav className="route-column" aria-labelledby="route-column-heading">
      <h2 id="route-column-heading" className="route-column__heading">{STAGE_TITLE[data.stage]}</h2>
      <StageMeaning stage={data.stage} />
      <p className="route-column__intro">{QUESTION_COPY.stage.routeIntro}</p>
      <div className="route-column__list">
        {/* Keyed on the stage's versions: the list reads this browser's drafts once, on mount, and a save removes its
            draft and refreshes the page; a new key mounts the list again, so "Not saved in this browser" is read again. */}
        <StageQuestionList
          key={data.rows.map((r) => `${r.questionId}:${r.versionNumber ?? 0}`).join(',')}
          variant="column" currentQuestionId={currentQuestionId} nextQuestionId={nextQuestionId === undefined ? nextApplyingId(data.rows, currentQuestionId) : nextQuestionId}
          orgSlug={data.orgSlug} orgId={data.orgId} projectId={data.projectId} stage={data.stage} viewerId={data.viewerId}
          rows={data.rows} show={show} counts={counts} filters={filters}
          total={data.rows.length} sealNumber={sealNumber} marks={data.marks} scopeAnswer={data.scopeAnswer}
          termTips={routeTermTips(
            // The open question's words are the page's h1, ahead of the column: a term they use is not first used here.
            [data.rows.find((r) => r.questionId === currentQuestionId)?.text ?? '', ...data.rows], data.marks, data.scopeAnswer,
          )}
        />
      </div>
      <p className="route-column__all">
        <Link href={`/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}`}>{QUESTION_COPY.stage.allQuestionsInStage}</Link>
      </p>
    </nav>
  );
}
