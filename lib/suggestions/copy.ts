import type { Stage } from '@/types/record';
import { PROJECT_COPY } from '@/lib/project/copy';

/**
 * The words of the suggestions: the question page's "Ways teams address this" slot, the finding page's, and the control
 * card they and the Guidance page's controls list share (copy audit B rows 279 to 298, CONSOLIDATED sections 2 and 3, plan
 * 1A Task 17). SERVER ONLY: SuggestedControls, FindingSuggestions and ControlCard are server components (ControlCard reads
 * the served files' sizes from disk), and no 'use client' file imports this module (ruling X-2).
 */
export const SUGGESTIONS_COPY = Object.freeze({
  intro: 'These are ideas. You can use any of them, none of them, or your own approach.',
  /** The closed group of the controls of the question's other areas, with their number (CONSOLIDATED 2 `control`). */
  more: (n: number): string => `More ways to address this (${n})`,
  showDetails: 'Show details',
  card: Object.freeze({
    type: (word: string): string => `Type: ${word}`,
    typeWords: Object.freeze({ technical: 'Technical', procedural: 'Procedural', informational: 'Informational' }) as Readonly<Record<string, string>>,
    alsoHelps: (areaNames: readonly string[]): string => `Also helps with: ${areaNames.join(', ')}`,
    usuallyApplied: (stage: Stage): string => `Usually applied in ${PROJECT_COPY.stageNames[stage]}`,
    template: (controlName: string): string => `Template: ${controlName}`,
    notebookTitle: 'Notebook: how to apply this with a free tool to your own data',
    downloadNotebook: 'Download notebook',
    downloadRequirements: 'Download the list of software it needs (requirements.txt)',
    runsOn: 'Run it on your own computer or in a notebook service.',
    reviewed: (reviewer: string, date: string): string => `Reviewed by ${reviewer} on ${date}.`,
    freeResources: 'Free resources',
    resourceTypeWords: Object.freeze({ framework: 'Framework', tool: 'Tool', paper: 'Paper', guidance: 'Guidance' }) as Readonly<Record<string, string>>,
    resource: (title: string, typeWord: string): string => `${title} (${typeWord})`,
    resourceElsewhere: (title: string, typeWord: string): string => `${title} (${typeWord}, opens another site)`,
  }),
});
