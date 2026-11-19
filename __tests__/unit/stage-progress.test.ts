import { describe, expect, it } from 'vitest';
import { stageProgress } from '@/lib/project/stageProgress';
import type { StageCounts } from '@/types/api';

const counts = (over: Partial<StageCounts>): StageCounts => ({
  questions: 20, noDecision: 20, byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0, withdrawn: 0 } as StageCounts['byStatus'],
  doneWithoutEvidence: 0, openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0, overdueMitigations: 0,
  acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0, ...over,
});

describe('stageProgress (G4)', () => {
  it('recordable leaves out gated questions and recorded is what is left once the open ones are taken off', () => {
    expect(stageProgress(counts({ questions: 20, notApplicableByGate: 2, noDecision: 5 }))).toEqual({ recordable: 18, recorded: 13 });
  });
  it('a finished stage reads recorded === recordable', () => {
    expect(stageProgress(counts({ questions: 20, notApplicableByGate: 3, noDecision: 0 }))).toEqual({ recordable: 17, recorded: 17 });
  });
});
