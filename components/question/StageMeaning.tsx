import type { ReactElement } from 'react';
import { Definition } from '@/components/ui/Definition';
import { TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import type { Stage } from '@/types/record';

/** Each stage's term in the vocabulary: its name and its plain meaning. */
const STAGE_TERM = { 'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3 } as const satisfies Record<Stage, unknown>;

/**
 * A stage's plain meaning under its name (spec 6 D1, line 495: stage names always with their plain meaning; plan 1C Task 3),
 * as the vocabulary's first-use definition. The stage page's `h1` and the question page's column heading use it.
 */
export function StageMeaning({ stage }: { stage: Stage }): ReactElement {
  return <Definition of={STAGE_TERM[stage]} as="p" />;
}
