import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Definition, Term } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import { MarkShape } from '@/components/ui/StatusMark';
import type { StatusMarkKind } from '@/components/ui/types';
import { tallyWords, positionWords } from '@/lib/ui/copy';
import { tallyOfRows } from '@/lib/question/route';
import type { StagePageData } from '@/lib/question/stagePage';
import { STAGE_TITLE } from '@/lib/question/stageList';
import { QUESTION_COPY } from '@/lib/question/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { TERM_FINDING, TERM_MITIGATION } from '@/lib/vocabulary/terms';

const F = QUESTION_COPY.frame;
const C = PROJECT_COPY.followUpCounts;

/** The tally's kinds in the kit's order (spec 7.2's table; lib/ui/copy.ts TALLY_WORDS): the sketch's order, with "does not apply" where the kit puts it. */
const KINDS: readonly StatusMarkKind[] = ['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision'];

export type QuestionTopStripProps = {
  stage: StagePageData;
  /** This question's 1-based place in the stage and the stage's size, as the panel counts them (`position`). */
  n: number; total: number;
};

/**
 * One count of the follow-up, a link, with its term marked and its definition one press away (spec 6: a term's first use
 * on a screen carries its definition). The strip must stay one line at 1280px, so the definition sits in a toggletip:
 * a small button right after the link opens it in place (the popover attribute, no script), and the link names it as
 * its description, so a screen reader hears it with the link. modern-web-guidance `interest-triggered-tooltips`.
 */
function FollowUpCount({ id, href, words, of, className, icon }: {
  id: 'finding' | 'mitigation'; href: string; words: string; of: typeof TERM_FINDING | typeof TERM_MITIGATION; className?: string; icon?: ReactNode;
}): ReactElement {
  const tip = `question-top-tip-${id}`;
  const def = `question-top-def-${id}`;
  return (
    <span className="question-top__count">
      <Link className={className} href={href} prefetch={false} aria-describedby={def}>{icon}<Term of={of}>{words}</Term></Link>
      <button type="button" className="question-top__tip" popoverTarget={tip} aria-label={F.whatIs(of.term)}><Icon name="info" size={16} /></button>
      <span id={tip} popover="auto" className="question-top__tip-body"><Definition of={of} id={def} /></span>
    </span>
  );
}

/**
 * The top strip of the question page from 1160px (owner's answer R4; sketch assigned.html `.top`): line 1 the breadcrumb,
 * project › stage › "Question n of N"; line 2 the stage's tally, one mark, a bold count and the vocabulary's words per
 * kind above zero, then, pushed right, the open findings and the overdue mitigations, each a link only above zero, to the
 * lists StageFollowUpCounts links to. The data is the stage page's (`loadStagePage`), which the page has already read.
 * workspace.css hides it under 1160px, where the position strip does its job.
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
      <div className="question-top__line">
        <h2 className="visually-hidden">{F.tallyHeading}</h2>
        <ul className="question-top__tally" role="list">
          {kinds.map((k) => {
            const count = tally[k] ?? 0;
            // The kit's words for one kind: "9 done", "1 answered"; the count is drawn in bold, so only the words follow it.
            const all = tallyWords({ [k]: count });
            if (!all.startsWith(`${count} `)) throw new Error(`QuestionTopStrip: the tally's words for ${k} do not start with the count`);
            const words = all.slice(String(count).length + 1);
            return (
              <li key={k} className="ui-mark" data-mark-kind={k}><MarkShape kind={k} size={16} /><b>{count}</b> {words}</li>
            );
          })}
        </ul>
        {openFindings > 0 || overdueMitigations > 0 ? (
          <p className="question-top__follow">
            {openFindings > 0 ? (
              <FollowUpCount id="finding" of={TERM_FINDING} href={`${projectHref}/findings`}
                words={`${openFindings} ${openFindings === 1 ? C.openFinding : C.openFindings}`} />
            ) : null}
            {overdueMitigations > 0 ? (
              <FollowUpCount id="mitigation" of={TERM_MITIGATION} href={`${projectHref}#${stage.stage}`} className="question-top__overdue"
                icon={<Icon name="clock" size={16} />}
                words={`${overdueMitigations} ${overdueMitigations === 1 ? C.overdueMitigation : C.overdueMitigations}`} />
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
