import Link from 'next/link';
import { RouteRow } from '@/components/ui/RouteRow';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { questionHref } from '@/lib/question/draft';
import { stageFilterSet, stopsOf, tallyOfRows } from '@/lib/question/route';
import { moduleGroups, STAGE_TITLE, type StageFilter } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import { tallyWords } from '@/lib/ui/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import './route-column.css';

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; plan 1C decision C2): the stage's
 * questions beside the question. A `<nav>` named by its heading, the stage's name; the whole stage as a row of marks
 * with the open question ringed and its tally in words; the stage's list as a column (the filter as a select, a
 * disclosure per topic, the open question "You are here"); the link to the stage page. Under 72.5rem only the heading,
 * the row of marks with its tally and the link show (route-column.css). The data is the stage page's own loader's.
 */
export function RouteColumn({ data, currentQuestionId, show }: { data: StagePageData; currentQuestionId: string; show: StageFilter }) {
  const { counts, filters, sealNumber } = stageFilterSet(data.rows, data.changed);
  const topicTallies: Record<string, string> = {};
  for (const g of moduleGroups(data.rows)) topicTallies[g.moduleId] = tallyWords(tallyOfRows(g.rows, data.marks));
  return (
    <nav className="route-column" aria-labelledby="route-column-heading">
      <h2 id="route-column-heading" className="route-column__heading">{STAGE_TITLE[data.stage]}</h2>
      <div className="route-column__marks">
        <RouteRow
          label={QUESTION_COPY.stage.routeLabel}
          stops={stopsOf(data.rows, data.marks, (q) => questionHref(data, q), currentQuestionId, data.scopeAnswer)}
          tally={tallyOfRows(data.rows, data.marks)}
        />
      </div>
      <div className="route-column__list">
        {/* Keyed on the stage's versions: the list reads this browser's drafts once, on mount, and a save removes its
            draft and refreshes the page; a new key mounts the list again, so "Not saved yet" is read again. */}
        <StageQuestionList
          key={data.rows.map((r) => `${r.questionId}:${r.versionNumber ?? 0}`).join(',')}
          variant="column" currentQuestionId={currentQuestionId} topicTallies={topicTallies}
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
