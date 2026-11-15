import type { ReactElement, ReactNode } from 'react';
import type { ChangeGroup, HomeBase } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { formatDay } from '@/lib/format/dates';
import { STAGES } from '@/types/record';
import { Term } from '@/components/ui/Definition';
import type { FirstUses } from '@/components/home/firstUse';
import { SLOT, SLOT_2, StageName, TERM_OF, TermList, personName, withSlots } from '@/components/home/parts';

/** Every kind named, so a kind the query starts returning fails here instead of reading as a seal. */
function wordsOf(g: ChangeGroup): string {
  switch (g.kind) {
    case 'decisions': return HOME_COPY.sinceDecisions(SLOT, g.count, SLOT_2);
    case 'finding': return HOME_COPY.sinceFindings(SLOT, g.count, SLOT_2);
    case 'seal': return HOME_COPY.sinceSeals(SLOT, g.count, SLOT_2);
    default: {
      const unknown: never = g.kind;
      throw new Error(`Home: no sentence for a change of kind ${String(unknown)}`);
    }
  }
}

/**
 * One group of changes as a sentence: who did what, how many, in which stage (the count agrees in number). The stage is
 * marked as a use of its term; a sentence about findings is a use of "finding".
 */
function sentenceOf(g: ChangeGroup): ReactNode {
  if (!STAGES.includes(g.stage)) throw new Error(`Home: a change names stage ${String(g.stage)}, which is not a stage`);
  const sentence = withSlots(wordsOf(g), [personName(g.who), <StageName key="stage" stage={g.stage} />]);
  return g.kind === 'finding' ? <Term of={TERM_OF.finding}>{sentence}</Term> : sentence;
}

/**
 * A dated list of changes (spec 9.1 (4) for a person who records, "what the team recorded in the last 14 days" for a
 * Viewer), as the sketch draws it: the day in a narrow column, the sentence beside it, a rule under each row. The day is
 * the change's calendar day as the loader grouped it (D5), so it is written as a date, not through LocalTime. When the
 * list is the page's first use of "finding" or "seal", their named definitions sit under the heading (stage names are
 * defined on the stage plates). With more groups than shown, one line says so.
 */
export function ChangesSince({ base, heading, groups, more, none, uses, terms }: {
  base: HomeBase; heading: ReactNode; groups: readonly ChangeGroup[]; more: boolean; none: string; uses: FirstUses; terms: string;
}): ReactElement {
  return (
    <section className="home-section home-changes">
      <h2>{heading}</h2>
      <TermList uses={uses} where={terms} />
      {groups.length === 0 ? <p className="home-empty">{none}</p> : (
        <ol className="home-changes__list" role="list">
          {groups.map((g) => {
            const project = base.projects.length > 1 ? g.projectName : null;
            return (
              <li key={`${g.day}:${g.who.userId}:${g.kind}:${g.projectId}:${g.stage}`} className="home-changes__row">
                <time className="home-changes__day" dateTime={g.day}>{formatDay(g.day)}</time>
                <div className="home-changes__what">
                  <p>{sentenceOf(g)}</p>
                  {project === null ? null : <p className="home-changes__meta"><bdi>{project}</bdi></p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {more ? <p className="home-changes__more">{HOME_COPY.sinceMore}</p> : null}
    </section>
  );
}
