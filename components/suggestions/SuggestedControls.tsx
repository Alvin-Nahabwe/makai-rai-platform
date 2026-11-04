import type { ReactElement } from 'react';
import { loadContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { controlsForQuestion, type ControlGroup } from '@/lib/content/suggestions';
import type { LoadedContent, ResourcesFile } from '@/types/content';
import { ControlCard } from './ControlCard';

export type SuggestedControlsProps = { contentSemver: string; questionId: string; tickedOptions: readonly string[] };

function Groups({ groups, c, resources }: { groups: ControlGroup[]; c: LoadedContent; resources: ResourcesFile }): ReactElement {
  return (
    <>
      {groups.map((g) => (
        <section key={g.area.id} className="suggested-controls__group">
          <h3>{`Risk area ${g.area.id} ${g.area.name}`}</h3>
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

const countOf = (groups: ControlGroup[]): number => groups.reduce((n, g) => n + g.controls.length, 0);

/**
 * "Ways teams address this" on S-12 (UX-08, UX-13): the controls mapped to the question, shown before any answer. A
 * slot of its screen (contract "Screens and slots"): the screen's owner renders it, SUG fills it. A server component
 * with no script. The gate shows none (FR-SUG-02). The shell names its region with its own heading, so the count here
 * is a line, not a second heading with the same words.
 */
export async function SuggestedControls({ contentSemver, questionId, tickedOptions }: SuggestedControlsProps): Promise<ReactElement | null> {
  const c = loadContent(contentSemver);
  const { first, rest } = controlsForQuestion(c, questionId, tickedOptions);
  const total = countOf(first) + countOf(rest);
  if (total === 0) return null;
  const resources = loadResources();
  return (
    <div className="suggested-controls">
      <p className="suggested-controls__count">{`Ways teams address this (${total})`}</p>
      <p>Shown before you answer. Use any, none, or your own approach.</p>
      <Groups groups={first} c={c} resources={resources} />
      {rest.length > 0 && (
        <details>
          <summary>{`Other controls for this question (${countOf(rest)})`}</summary>
          <Groups groups={rest} c={c} resources={resources} />
        </details>
      )}
    </div>
  );
}
