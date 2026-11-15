import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Term } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import { MarkShape } from '@/components/ui/StatusMark';
import { TermTip } from '@/components/ui/TermTip';
import type { StatusMarkKind } from '@/components/ui/types';
import { tallyWords, positionWords } from '@/lib/ui/copy';
import { tallyOfRows } from '@/lib/question/route';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_TITLE } from '@/lib/question/stageList';
import { QUESTION_COPY } from '@/lib/question/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import {
  TERM_DONE, TERM_DOES_NOT_APPLY, TERM_FINDING, TERM_MITIGATION, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY,
} from '@/lib/vocabulary/terms';

const F = QUESTION_COPY.frame;
const C = PROJECT_COPY.followUpCounts;

/** The tally's kinds in the kit's order (spec 7.2's table; lib/ui/copy.ts TALLY_WORDS): the sketch's order, with "does not apply" where the kit puts it. */
const KINDS: readonly StatusMarkKind[] = ['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision'];

/**
 * The vocabulary entry each tally word is defined by (owner's ruling of 15 November 2026, 11:00: an (i) beside each
 * defined word). "answered" has no entry of its own (the personal data question's entry defines the question, not the
 * word), and "No decision" is defined but marked not to be defined at first use (`defineOnFirstUse: false`, which
 * `Definition` refuses), so neither gets a tip.
 */
const DEFINED: Readonly<Partial<Record<StatusMarkKind, DefinedEntry>>> = {
  done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE, does_not_apply: TERM_DOES_NOT_APPLY,
};

export type QuestionTopStripProps = {
  stage: StagePageData;
  /** This question's 1-based place in the stage and the stage's size, as the panel counts them (`position`). */
  n: number; total: number;
};

/** One count of the follow-up: a link with its term marked, the link described by the term's definition, then its (i). */
function FollowUpCount({ href, words, of, className, icon }: {
  href: string; words: string; of: typeof TERM_FINDING | typeof TERM_MITIGATION; className?: string; icon?: ReactNode;
}): ReactElement {
  return (
    <span className="question-top__count">
      <Link className={className} href={href} prefetch={false} aria-describedby={`term-tip-${of.id}-def`}>{icon}<Term of={of}>{words}</Term></Link>
      <TermTip of={of} label={F.whatIs(of.term)} />
    </span>
  );
}

/**
 * The top strip of the question page from 1160px (owner's answer R4; sketch assigned.html `.top`): line 1 the breadcrumb,
 * project › stage › "Question n of N", with the open findings and the overdue mitigations pushed to its right end, each a
 * link only above zero, to the lists StageFollowUpCounts links to; line 2 the stage's tally, one mark, a bold count and
 * the vocabulary's words per kind above zero. Each defined word (finding, mitigation, and the status words the vocabulary
 * defines) carries a TermTip, the owner's ruling of 11:00: the vocabulary's sentence opens on focus and on a press. The
 * sketch puts the counts on the tally's line; with every kind at two digits and its tip that line no longer fits 1280.
 * The data is the stage page's (`loadStagePage`), which the page has already read. workspace.css hides it under 1160px,
 * where the position strip does its job.
 */
export function QuestionTopStrip({ stage, n, total }: QuestionTopStripProps): ReactElement {
  const projectHref = `/orgs/${stage.orgSlug}/projects/${stage.projectId}`;
  const tally = tallyOfRows(stage.rows, stage.marks);
  const kinds = KINDS.filter((k) => (tally[k] ?? 0) > 0);
  const { openFindings, overdueMitigations } = stage.followUp;
  return (
    <div className="question-top">
      <Breadcrumb items={[
        { label: stage.projectName, href: projectHref },
        { label: STAGE_TITLE[stage.stage], href: `${projectHref}/stages/${stage.stage}` },
        { label: positionWords(n, total) },
      ]} />
      {/* The follow-up counts sit at the right end of the breadcrumb's row (fix round 1, I1). DOM order is the visual
          order: breadcrumb, counts, tally. */}
      {openFindings > 0 || overdueMitigations > 0 ? (
        <p className="question-top__follow">
          {openFindings > 0 ? (
            <FollowUpCount of={TERM_FINDING} href={`${projectHref}/findings`}
              words={`${openFindings} ${openFindings === 1 ? C.openFinding : C.openFindings}`} />
          ) : null}
          {overdueMitigations > 0 ? (
            <FollowUpCount of={TERM_MITIGATION} href={`${projectHref}#${stage.stage}`} className="question-top__overdue"
              icon={<Icon name="clock" size={16} />}
              words={`${overdueMitigations} ${overdueMitigations === 1 ? C.overdueMitigation : C.overdueMitigations}`} />
          ) : null}
        </p>
      ) : null}
      {/* Named by a label, not a heading: no heading comes before the page's h1. */}
      <ul className="question-top__tally" role="list" aria-label={F.tallyHeading}>
        {kinds.map((k) => {
          const count = tally[k] ?? 0;
          // The kit's words for one kind: "9 done", "1 answered"; the count is drawn in bold, so only the words follow it.
          const all = tallyWords({ [k]: count });
          if (!all.startsWith(`${count} `)) throw new Error(`QuestionTopStrip: the tally's words for ${k} do not start with the count`);
          const words = all.slice(String(count).length + 1);
          const entry = DEFINED[k];
          return (
            <li key={k} className="ui-mark" data-mark-kind={k}>
              <MarkShape kind={k} size={16} /><b>{count}</b> {entry === undefined ? words : <Term of={entry}>{words}</Term>}
              {entry === undefined ? null : <TermTip of={entry} label={F.whatMeans(entry.term)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
