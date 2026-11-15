import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import { DOCUMENTS_COPY, STAGE_TERMS } from '@/lib/documents/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { TERM_FINDING, TERM_SEAL } from '@/lib/vocabulary/terms';
import { Definition, Term } from '@/components/ui/Definition';

/**
 * The top of S-18 (spec 6; lane 6's house pattern: definitions sit under the page heading). The lead names the review, whose name begins
 * with its stage, with the stage's plain meaning after it (D1). Then one line per term the page uses before it could be defined in place:
 * "seal" (the seal select, the never-sealed line and the content's help can use it first), the names of other stages the form's notes
 * name, and "finding" (the mitigation plan's help can name it first). Each line is the term, then the vocabulary's own sentence.
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

/** `stages`: the other stages the form's never-sealed notes name, in stage order. `finding`: the form (and its mitigation plan) is shown. */
export function DocumentTerms({ stages, finding }: { stages: readonly Stage[]; finding: boolean }): ReactElement {
  return (
    <div>
      <p><Term of={TERM_SEAL}>{DOCUMENTS_COPY.terms.seal}</Term> <Definition of={TERM_SEAL} /></p>
      {stages.map((st) => <p key={st}><Term of={STAGE_TERMS[st]}>{FINDINGS_COPY.stages[st]}</Term> <Definition of={STAGE_TERMS[st]} /></p>)}
      {finding ? <p><Term of={TERM_FINDING}>{DOCUMENTS_COPY.terms.finding}</Term> <Definition of={TERM_FINDING} /></p> : null}
    </div>
  );
}
