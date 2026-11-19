import { questionsInStage, runningContent } from '@/lib/content/loader';
import { buildStageRows } from '@/lib/question/stageList';
import type { StagePageData } from '@/lib/question/stagePage';
import type { StatusMarkKind } from '@/components/ui/types';
import type { Stage } from '@/types/record';

/**
 * The stage page's data (lib/question/stagePage.ts) for the question page's unit tests, from the running content (the
 * fixture bundle in a unit test) with no decision recorded: every row "none" and every mark "no_decision", unless
 * `marks` sets a question's mark or `openFindings` its open findings. The tally reads the marks, so a test sets the
 * marks it counts.
 */
export function stageFixture(over: {
  stage?: Stage; marks?: Record<string, StatusMarkKind>; openFindings?: Record<string, number>;
  followUp?: StagePageData['followUp']; projectName?: string;
} = {}): StagePageData {
  const stage = over.stage ?? 'pre-processing';
  const rows = buildStageRows({
    questions: questionsInStage(runningContent(), stage), current: new Map(), gate: null,
    openFindingsByQuestion: new Map(Object.entries(over.openFindings ?? {})), changed: [], reworded: [],
  });
  const marks: Record<string, StatusMarkKind> = {};
  for (const r of rows) marks[r.questionId] = over.marks?.[r.questionId] ?? 'no_decision';
  return {
    orgSlug: 'acme-health', orgId: 'o1', projectId: 'p1', projectName: over.projectName ?? 'Antenatal Risk Triage Model', projectArchived: false,
    stage, viewerId: 'u1', rows, nothingRecorded: true, changed: null, review: null,
    followUp: over.followUp ?? { openFindings: 0, overdueMitigations: 0 }, marks, scopeAnswer: null, sealStep: { kind: 'hidden' },
  };
}
