import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';
import { PROJECT_COPY } from '@/lib/project/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import type { QuestionOpenWork } from '@/lib/question/openWork';
import { TERM_FINDING, TERM_MITIGATION } from '@/lib/vocabulary/terms';
import { ReadingDefinition } from './ReadingDefinition';
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
 * What is still open on the question, on the read-only question page (plan 1C Task 7; directions/surfaces/viewer-reading.png):
 * each open finding as a white plate, its name a link to its page (the title in `<bdi>`, as S-14 prints it); under it,
 * for each open mitigation, "Mitigation: <what>" on one line (cut with an ellipsis; the finding's page shows it whole),
 * then who it is assigned to, the status word and the due phrase as separate elements. The overdue phrase alone is red,
 * with the clock: the word Overdue and "was due <date>" (spec 7.1: red on an overdue date and the word, never a name). A
 * finding with no open mitigation says "No mitigation yet" and "Not assigned yet". A server component: every value is a
 * React child, so it is text, never markup (NFR-SEC-11).
 */
export function OpenWorkList({ work, orgSlug, projectId }: OpenWorkListProps): ReactElement {
  return (
    <ul className="still-open__list">
      {work.findings.map((f) => (
        <li key={f.findingId} className="still-open__plate">
          <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${f.findingId}`} className="still-open__title"><bdi>{f.title}</bdi></ListLink>
          {f.mitigations.length === 0 ? (
            <p className="still-open__line"><span>{R.noMitigationYet}</span><span>{R.notAssignedYet}</span></p>
          ) : f.mitigations.map((m, i) => (
            <div key={i} className="still-open__mitigation">
              <p className="still-open__what">{m.what === null ? F.erased : R.mitigation(m.what)}</p>
              <p className="still-open__line">
                <span>{F.assignedTo(m.assignedTo)}</span>
                <span className="status-label">{STATUS_WORD[m.status]}</span>
                {m.overdue ? (
                  <span className="still-open__overdue" data-overdue><Icon name="clock" size={16} />{F.overdue}<span aria-hidden="true"> · </span>{R.wasDue(formatDay(m.dueDate))}</span>
                ) : (
                  <span>{F.due(formatDay(m.dueDate))}</span>
                )}
              </p>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Still open on this question: n findings" (spec 9.3: "open findings sit directly under it"), with the vocabulary's
 * definitions of finding and mitigation under the heading, each with its term (their first use on the page, spec 6;
 * design review S4-1), then the plates. Only
 * when something is open: null otherwise, so no heading stands over nothing.
 */
export function StillOpen({ work, orgSlug, projectId }: { work: QuestionOpenWork | null; orgSlug: string; projectId: string }): ReactElement | null {
  if (work === null || work.findings.length === 0) return null;
  return (
    <section data-region="open-work" aria-labelledby="s12-open-work" className="still-open">
      <h2 id="s12-open-work">{R.stillOpen(work.findings.length)}</h2>
      <ReadingDefinition of={TERM_FINDING} />
      <ReadingDefinition of={TERM_MITIGATION} />
      <OpenWorkList work={work} orgSlug={orgSlug} projectId={projectId} />
    </section>
  );
}
