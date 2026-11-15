import Link from 'next/link';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { StageMeaning } from '@/components/question/StageMeaning';
import { nextApplyingId, stageFilterSet } from '@/lib/question/route';
import { STAGE_TITLE, type StageFilter } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { QUESTION_COPY } from '@/lib/question/copy';
import './route-column.css';

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; owner's answer R1, 15 November 2026):
 * the stage's questions as one line beside the question. A `<nav>` named by its heading, the stage's name, with the
 * stage's plain meaning and one sentence under it; the filter as a small select above the line; the line itself, the
 * open question "You are here" in the ring, the next one named, the questions away from them folded into runs that open
 * in place (components/question/RouteLine.tsx, lib/question/route.ts); the link to the stage page. At every width the
 * column shows the same line; below 72.5rem it follows the main content (its place is workspace.css's). The data is the
 * stage page's own loader's.
 */
export function RouteColumn({ data, currentQuestionId, show }: { data: StagePageData; currentQuestionId: string; show: StageFilter }) {
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
          variant="column" currentQuestionId={currentQuestionId} nextQuestionId={nextApplyingId(data.rows, currentQuestionId)}
          orgSlug={data.orgSlug} orgId={data.orgId} projectId={data.projectId} stage={data.stage} viewerId={data.viewerId}
          rows={data.rows} show={show} counts={counts} filters={filters}
          total={data.rows.length} sealNumber={sealNumber} marks={data.marks} scopeAnswer={data.scopeAnswer}
        />
      </div>
      <p className="route-column__all">
        <Link href={`/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}`}>{QUESTION_COPY.stage.allQuestionsInStage}</Link>
      </p>
    </nav>
  );
}
