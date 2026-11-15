import type { ReactElement } from 'react';
import { loadContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { controlsForQuestion, type ControlGroup } from '@/lib/content/suggestions';
import type { LoadedContent, ResourcesFile } from '@/types/content';
import { SUGGESTIONS_COPY } from '@/lib/suggestions/copy';
import { ControlCard } from './ControlCard';

export type SuggestedControlsProps = { contentSemver: string; questionId: string; tickedOptions: readonly string[] };

function Groups({ groups, c, resources }: { groups: ControlGroup[]; c: LoadedContent; resources: ResourcesFile }): ReactElement {
  return (
    <>
      {groups.map((g) => (
        <section key={g.area.id} className="suggested-controls__group">
          <h3>{g.area.name}</h3>
          <p>{g.area.description}</p>
          {g.controls.map((x) => (
            <ControlCard
              key={x.control.id}
              control={x.control}
              resources={resources}
              alsoAddresses={x.alsoAddresses.flatMap((id) => c.areas.get(id) ?? [])}
              usuallyAppliedIn={x.usuallyAppliedIn}
              headingLevel={4}
            />
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * Distinct control cards in the groups: a control reached through two risk areas is shown once (SRS line 1910).
 * `controlsForQuestion` already places each control once, so the Set only guards a caller that hands in groups that overlap.
 */
const countOf = (...lists: ControlGroup[][]): number =>
  new Set(lists.flatMap((groups) => groups.flatMap((g) => g.controls.map((x) => x.control.id)))).size;

/**
 * The number n of cards `SuggestedControls` shows for these props. The S-12 page calls it for the in-page link "Ways teams
 * address this (n)" and to leave the section out at 0 (the gate). The slot itself shows no count line (copy audit B#279): the link carries the number.
 */
export function suggestionCount({ contentSemver, questionId, tickedOptions }: SuggestedControlsProps): number {
  const { first, rest } = controlsForQuestion(loadContent(contentSemver), questionId, tickedOptions);
  return countOf(first, rest);
}

/**
 * "Ways teams address this" on S-12 (UX-08, UX-13): the controls mapped to the question, shown before any answer. A
 * slot of its screen (contract "Screens and slots"): the screen's owner renders it, SUG fills it. A server component
 * with no script. The gate shows none (FR-SUG-02). The shell names its region with its own heading, "Ways teams address
 * this", with no count (the "(8)" beside it in the wireframe is a note marker), so the slot starts with its one line of
 * introduction; the number of cards is in the content region's link "Ways teams address this (n)" (copy audit B#279).
 */
export function SuggestedControls({ contentSemver, questionId, tickedOptions }: SuggestedControlsProps): ReactElement | null {
  const c = loadContent(contentSemver);
  const { first, rest } = controlsForQuestion(c, questionId, tickedOptions);
  const total = countOf(first, rest);
  if (total === 0) return null;
  const resources = loadResources();
  return (
    <div className="suggested-controls">
      <p>{SUGGESTIONS_COPY.intro}</p>
      <Groups groups={first} c={c} resources={resources} />
      {rest.length > 0 && (
        <details>
          <summary>{SUGGESTIONS_COPY.more(countOf(rest))}</summary>
          <Groups groups={rest} c={c} resources={resources} />
        </details>
      )}
    </div>
  );
}
