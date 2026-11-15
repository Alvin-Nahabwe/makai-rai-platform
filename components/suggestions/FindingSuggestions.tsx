import type { ReactElement } from 'react';
import { loadContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { Definition } from '@/components/ui/Definition';
import { markTerms, usesTerm } from '@/components/review/markTerms';
import { TERM_MODEL_CARD } from '@/lib/vocabulary/terms';
import { controlsForArea } from '@/lib/content/suggestions';
import { SUGGESTIONS_COPY } from '@/lib/suggestions/copy';
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
 *
 * Lane 6, FX3 (ruling X-5, spec 6): the cards repeat on a page, so this slot defines "model card" once, at its first use.
 * The names line comes first, so a control name that uses the term (C-17, "Model Documentation (Model Card)") holds the
 * first use: the name marks it and the definition is the element right after the names line. Otherwise the first card
 * whose description uses it gets `defineModelCard`.
 */
export function FindingSuggestions(p: FindingSuggestionsProps): ReactElement | null {
  const controls = controlsOf(p);
  if (controls.length === 0) return null;
  const resources = loadResources();
  const inName = controls.findIndex((x) => usesTerm(x.control.name, TERM_MODEL_CARD));
  const cardIndex = inName >= 0 ? -1 : controls.findIndex((x) => usesTerm(x.control.description, TERM_MODEL_CARD));
  return (
    <div className="suggested-controls">
      <p className="suggested-controls__names">
        {controls.map((x, i) => (
          <span key={x.control.id}>
            {i > 0 ? <span aria-hidden="true"> {'\u00b7'} </span> : null}
            {i === inName ? markTerms(x.control.name, [TERM_MODEL_CARD]) : x.control.name}
          </span>
        ))}
      </p>
      {inName >= 0 ? <Definition of={TERM_MODEL_CARD} as="p" /> : null}
      <details>
        <summary>{SUGGESTIONS_COPY.showDetails}</summary>
        {controls.map((x, i) => <ControlCard key={x.control.id} control={x.control} resources={resources} headingLevel={3} defineModelCard={i === cardIndex} />)}
      </details>
    </div>
  );
}
