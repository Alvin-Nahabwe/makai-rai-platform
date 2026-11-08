import type { FindingSource, FindingEventKind, MitigationStatus, FindingState } from '../../types/record';

export function deriveFindingState(i: {
  source: FindingSource;
  events: ReadonlyArray<{ kind: FindingEventKind; findingSeq: number }>;
  currentMitigations: ReadonlyArray<{ status: MitigationStatus; findingSeq: number }>;
  acceptedRisks: ReadonlyArray<{ findingSeq: number }>;
}): FindingState;
