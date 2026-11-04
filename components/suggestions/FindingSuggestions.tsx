import type { ReactElement } from 'react';
import { loadContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { controlsForArea } from '@/lib/content/suggestions';
import { ControlCard } from './ControlCard';

export type FindingSuggestionsProps = { contentSemver: string; riskArea: string | null };

/**
 * The controls suggested for a finding's risk area (FR-SUG-03). A slot of its screen (contract "Screens and slots"): the
 * screen's owner renders it, SUG fills it. Nothing when the finding has no risk area or the content has no such area.
 */
export async function FindingSuggestions({ contentSemver, riskArea }: FindingSuggestionsProps): Promise<ReactElement | null> {
  if (riskArea === null) return null;
  const c = loadContent(contentSemver);
  const controls = controlsForArea(c, riskArea).flatMap((g) => g.controls);
  if (controls.length === 0) return null;
  const resources = loadResources();
  return (
    <div className="suggested-controls">
      <h3>{`Ways teams address this (${controls.length})`}</h3>
      {controls.map((x) => <ControlCard key={x.control.id} control={x.control} resources={resources} headingLevel={4} />)}
    </div>
  );
}
