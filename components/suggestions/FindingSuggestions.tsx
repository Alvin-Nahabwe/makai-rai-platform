import type { ReactElement } from 'react';
import { loadContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { controlsForArea } from '@/lib/content/suggestions';
import { ControlCard } from './ControlCard';

export type FindingSuggestionsProps = { contentSemver: string; riskArea: string | null };

function controlsOf({ contentSemver, riskArea }: FindingSuggestionsProps) {
  if (riskArea === null) return [];
  return controlsForArea(loadContent(contentSemver), riskArea).flatMap((g) => g.controls);
}

/**
 * The number of controls the slot shows for a finding's risk area: 0 for no area or an area the content lacks. S-15 leaves
 * its "Ways teams address this" section out at 0, as S-12 does for the gate.
 */
export function findingSuggestionCount(p: FindingSuggestionsProps): number {
  return controlsOf(p).length;
}

/**
 * The controls suggested for a finding's risk area (FR-SUG-03). A slot of its screen (contract "Screens and slots"): the
 * screen's owner renders it under its own heading, "Ways teams address this (for risk area <id>)", so the slot has no heading and
 * no count line (SRS W-5, line 1996). SRS W-5 note 5: the controls are collapsed to their names on one line, with the full cards
 * in a closed "Show details".
 */
export function FindingSuggestions(p: FindingSuggestionsProps): ReactElement | null {
  const controls = controlsOf(p);
  if (controls.length === 0) return null;
  const resources = loadResources();
  return (
    <div className="suggested-controls">
      <p className="suggested-controls__names">{controls.map((x) => `${x.control.id} ${x.control.name}`).join(' \u00b7 ')}</p>
      <details>
        <summary>Show details</summary>
        {controls.map((x) => <ControlCard key={x.control.id} control={x.control} resources={resources} headingLevel={4} />)}
      </details>
    </div>
  );
}
