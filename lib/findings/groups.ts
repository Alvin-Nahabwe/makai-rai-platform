import { STAGES, type Stage } from '@/types/record';
import type { FindingView } from '@/types/api';

type ToClose = FindingView & { reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; decisionVersionId: string };
type StageGroup = { noMitigation: FindingView[]; overdue: FindingView[]; other: FindingView[] };

/** S-14's groups, in UX-15's order (SRS line 2322). */
export interface FindingGroups {
  decisionDone: Array<FindingView & { decisionVersionId: string }>;
  decisionWithdrawn: Array<FindingView & { decisionVersionId: string }>;
  openByStage: Record<Stage, StageGroup>;
  lookAgain: FindingView[];
  closed: FindingView[];
  withdrawn: FindingView[];
}

const oldestFirst = (x: FindingView, y: FindingView) => x.raisedAt.localeCompare(y.raisedAt) || x.id.localeCompare(y.id);

/**
 * UX-15: "Decision now done: close it" (FR-FND-06; a gate answered "no" is listed here too), then "Decision withdrawn:
 * close it" (FR-DEC-08), then the open findings per stage ("Open, no mitigation yet" first, then those with overdue
 * mitigations, then the rest), then "Accepted risks to look at again", then closed, then withdrawn. Each finding is in
 * exactly one group: a finding to close by a decision is in its toClose group only, a finding on the look-again list in
 * that group only, and a withdrawn finding never in an open or closed group (FR-FND-07). Within a group the oldest
 * raised comes first. Pure: the inputs are `listFindings`, `findingsToCloseByDecision` and `acceptedRisksToLookAgain`.
 */
export function groupFindings(i: {
  findings: readonly FindingView[];
  toClose: ReadonlyArray<ToClose>;
  lookAgain: readonly FindingView[];
}): FindingGroups {
  const g: FindingGroups = {
    decisionDone: [], decisionWithdrawn: [],
    openByStage: Object.fromEntries(STAGES.map((s) => [s, { noMitigation: [], overdue: [], other: [] }])) as unknown as Record<Stage, StageGroup>,
    lookAgain: [], closed: [], withdrawn: [],
  };
  const placed = new Set<string>();
  for (const { reason, ...finding } of i.toClose) {
    if (placed.has(finding.id)) continue;
    placed.add(finding.id);
    (reason === 'decision_withdrawn' ? g.decisionWithdrawn : g.decisionDone).push(finding);
  }
  const lookAgain = new Set(i.lookAgain.map((f) => f.id));
  for (const f of i.findings) {
    if (placed.has(f.id)) continue;
    placed.add(f.id);
    if (f.state === 'withdrawn') g.withdrawn.push(f);
    else if (f.state === 'open') {
      const s = g.openByStage[f.stage];
      if (s === undefined) throw new Error(`groupFindings: finding ${f.id} has unknown stage ${JSON.stringify(f.stage)}`);
      (f.hasNoMitigation ? s.noMitigation : f.overdueMitigations > 0 ? s.overdue : s.other).push(f);
    } else if (lookAgain.has(f.id)) g.lookAgain.push(f);
    else g.closed.push(f);
  }
  for (const list of [g.decisionDone, g.decisionWithdrawn, g.lookAgain, g.closed, g.withdrawn]) list.sort(oldestFirst);
  for (const s of Object.values(g.openByStage)) for (const list of [s.noMitigation, s.overdue, s.other]) list.sort(oldestFirst);
  return g;
}
