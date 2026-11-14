import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';
import { PROJECT_COPY } from '@/lib/project/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import type { QuestionOpenWork } from '@/lib/question/openWork';
import './OpenWorkList.css';

export type OpenWorkListProps = { work: QuestionOpenWork; orgSlug: string; projectId: string };

/**
 * The mitigation status words, the same as StageFollowUp.tsx's `STATUS_WORD` (SRS 5.3 item 11), held here because importing
 * that module would bring its stylesheet, components/followup/FollowUp.css, to this page. The claims crawl exempts them
 * only inside .status-label; __tests__/lint/claim-allowlist.json allows "In progress" in this file's source.
 */
const STATUS_WORD = { planned: 'Planned', in_progress: 'In progress' } as const;

const F = PROJECT_COPY.followUp;
const R = QUESTION_COPY.reading;

/**
 * What is still open on the question, on the read-only question page (plan 1C Task 7): each open finding as a link to its
 * page (the title in `<bdi>`, as S-14 prints it), then each of its open mitigations on a line of separate elements: its text,
 * who it is assigned to, the status word and the due phrase, in the words and the pattern of the project page's follow-up
 * (components/followup/StageFollowUp.tsx): the word Overdue alone is red (spec 7.1), ": was due <date>" plain after it. A
 * finding with no open mitigation says "No mitigation yet". A server component: every value is a React child, so it is
 * text, never markup (NFR-SEC-11).
 */
export function OpenWorkList({ work, orgSlug, projectId }: OpenWorkListProps): ReactElement {
  return (
    <ul className="open-work">
      {work.findings.map((f) => (
        <li key={f.findingId} className="open-work__finding">
          <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${f.findingId}`} className="open-work__title"><bdi>{f.title}</bdi></ListLink>
          {f.mitigations.length === 0 ? (
            <p>{R.noMitigationYet}</p>
          ) : (
            <ul className="open-work__mitigations">
              {f.mitigations.map((m, i) => (
                <li key={i}>
                  <span>{m.what === null ? F.erased : R.mitigation(m.what)}</span>{' '}
                  <span>{F.assignedTo(m.assignedTo)}</span>{' '}
                  <span className="status-label">{STATUS_WORD[m.status]}</span>{' '}
                  {m.overdue ? (
                    <span data-overdue><span className="open-work__overdue">{F.overdue}</span>{F.wasDue(formatDay(m.dueDate))}</span>
                  ) : (
                    <span>{F.due(formatDay(m.dueDate))}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
