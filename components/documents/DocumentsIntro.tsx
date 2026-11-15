import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import { STAGE_TERMS } from '@/lib/documents/copy';
import { TERM_FINDING, TERM_SEAL } from '@/lib/vocabulary/terms';
import { Definition, Term } from '@/components/ui/Definition';
import { TermList, type TermListItem } from '@/components/review/TermList';

/**
 * The top of S-18 (spec 6; lane 6's house pattern: definitions sit under the page heading). The lead names the review, whose name begins
 * with its stage, with the stage's plain meaning after it (D1). Then one line per term the page uses before it could be defined in place:
 * "seal" (the seal select, the never-sealed line and the content's help can use it first), the names of other stages the form's notes
 * name, and "finding" (the mitigation plan's help can name it first), in the term list the findings and review screens use.
 * Server-rendered; shown once per page.
 */

export function DocumentsLead({ reviewName, stage }: { reviewName: string; stage: Stage }): ReactElement {
  return (
    <>
      <p><Term of={STAGE_TERMS[stage]}>{reviewName}</Term></p>
      <Definition of={STAGE_TERMS[stage]} as="p" />
    </>
  );
}

/**
 * `stages`: the other stages the form's never-sealed notes name, in stage order. `finding`: the form (and its mitigation plan) is shown.
 * The findings and review screens' term list (FX4, DF I1): each label is the page's first use, its definition the next element.
 */
export function DocumentTerms({ stages, finding }: { stages: readonly Stage[]; finding: boolean }): ReactElement | null {
  const items: TermListItem[] = [TERM_SEAL, ...stages.map((st) => STAGE_TERMS[st]), ...(finding ? [TERM_FINDING] : [])].map((of) => ({ of, marked: true }));
  return <TermList idPrefix="documents-terms" items={items} />;
}
