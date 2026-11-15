import type { ReactElement, ReactNode } from 'react';
import type { ChangeGroup, HomeBase } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { formatDay } from '@/lib/format/dates';
import { TERM_SEAL } from '@/lib/vocabulary/terms';
import { Definition } from '@/components/ui/Definition';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { SLOT, personName, withSlot } from '@/components/home/parts';

/** One group of changes as a sentence: who did what, how many, in which stage. The count agrees in number. */
function sentenceOf(g: ChangeGroup): ReactNode {
  const stage = STAGE_NAME[g.stage];
  if (stage === undefined) throw new Error(`Home: a change names stage ${String(g.stage)}, which is not a stage`);
  return withSlot(wordsOf(g, stage), personName(g.who));
}

/** Every kind named, so a kind the query starts returning fails here instead of reading as a seal. */
function wordsOf(g: ChangeGroup, stage: string): string {
  switch (g.kind) {
    case 'decisions': return HOME_COPY.sinceDecisions(SLOT, g.count, stage);
    case 'finding': return HOME_COPY.sinceFindings(SLOT, g.count, stage);
    case 'seal': return HOME_COPY.sinceSeals(SLOT, g.count, stage);
    default: {
      const unknown: never = g.kind;
      throw new Error(`Home: no sentence for a change of kind ${String(unknown)}`);
    }
  }
}

/**
 * A dated list of changes (spec 9.1 (4) for a person who records, "what the team recorded in the last 14 days" for a
 * Viewer), as the sketch draws it: the day in a narrow column, the sentence beside it, a rule under each row. The day is
 * the change's calendar day as the loader grouped it (D5), so it is written as a date, not through LocalTime. The first
 * seal on the list carries the definition of "seal", as the sketch shows it. With more groups than shown, one line says so.
 */
export function ChangesSince({ base, heading, groups, more, none }: {
  base: HomeBase; heading: ReactNode; groups: readonly ChangeGroup[]; more: boolean; none: string;
}): ReactElement {
  const firstSeal = groups.findIndex((g) => g.kind === 'seal');
  return (
    <section className="home-section home-changes">
      <h2>{heading}</h2>
      {groups.length === 0 ? <p className="home-empty">{none}</p> : (
        <ol className="home-changes__list" role="list">
          {groups.map((g, i) => {
            const project = base.projects.length > 1 ? g.projectName : null;
            return (
              <li key={`${g.day}:${g.who.userId}:${g.kind}:${g.projectId}:${g.stage}`} className="home-changes__row">
                <time className="home-changes__day" dateTime={g.day}>{formatDay(g.day)}</time>
                <div className="home-changes__what">
                  <p>{sentenceOf(g)}</p>
                  {project === null ? null : <p className="home-changes__meta"><bdi>{project}</bdi></p>}
                  {i === firstSeal ? <Definition of={TERM_SEAL} as="p" /> : null}
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
