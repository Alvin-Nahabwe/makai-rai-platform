import { describe, expect, it } from 'vitest';
import type { FindingView } from '@/types/api';
import { groupFindings } from '@/lib/findings/groups';

const base: FindingView = {
  id: '', projectId: 'p', stage: 'pre-processing', source: 'team', questionId: null, decisionVersionId: null, riskArea: null,
  title: 't', description: 'd', raisedBy: { userId: 'u', name: 'U', formerMember: false }, raisedAt: '2026-11-01T08:00:00.000Z',
  state: 'open', openMitigations: 1, hasNoMitigation: false, overdueMitigations: 0,
};
const f = (id: string, over: Partial<FindingView> = {}): FindingView => ({ ...base, id, ...over });
const OPEN_NONE = f('open-none', { openMitigations: 0, hasNoMitigation: true });
const OPEN_OVERDUE = f('open-overdue', { overdueMitigations: 1 });
const OPEN_OTHER = f('open-other');
const CLOSED = f('closed', { state: 'closed_mitigation', openMitigations: 0, hasNoMitigation: true });
const ACCEPTED_DUE = f('accepted-due', { state: 'closed_accepted_risk', openMitigations: 0, hasNoMitigation: true });
const WITHDRAWN = f('withdrawn', { state: 'withdrawn' });
const DONE_TO_CLOSE = f('done-to-close', { source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: 'v1', hasNoMitigation: true, openMitigations: 0 });
const WD_TO_CLOSE = f('wd-to-close', { source: 'shortfall', questionId: 'Q-PP-02', decisionVersionId: 'v1b' });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
const empty = { noMitigation: [], overdue: [], other: [] };

describe('lib/findings/groups.ts (UX-15, SRS line 2322)', () => {
  it('UX-15 FR-FND-05 FR-FND-06 FR-FND-07: one finding of each kind lands in its group, and withdrawn ones in no open or closed group', () => {
    const g = groupFindings({ findings: [OPEN_NONE, OPEN_OVERDUE, OPEN_OTHER, CLOSED, ACCEPTED_DUE, WITHDRAWN, DONE_TO_CLOSE, WD_TO_CLOSE],
      toClose: [{ ...DONE_TO_CLOSE, reason: 'decision_done', decisionVersionId: 'v2' }, { ...WD_TO_CLOSE, reason: 'decision_withdrawn', decisionVersionId: 'v3' }], lookAgain: [ACCEPTED_DUE] });
    expect(ids(g.decisionDone)).toEqual([DONE_TO_CLOSE.id]); expect(ids(g.decisionWithdrawn)).toEqual([WD_TO_CLOSE.id]);
    expect(g.decisionDone[0].decisionVersionId).toBe('v2'); expect(g.decisionWithdrawn[0].decisionVersionId).toBe('v3');
    expect(g.openByStage['pre-processing']).toEqual({ noMitigation: [OPEN_NONE], overdue: [OPEN_OVERDUE], other: [OPEN_OTHER] });
    expect(g.openByStage['in-processing']).toEqual(empty); expect(g.openByStage['post-processing']).toEqual(empty);
    expect(ids(g.lookAgain)).toEqual([ACCEPTED_DUE.id]); expect(ids(g.closed)).toEqual([CLOSED.id]); expect(ids(g.withdrawn)).toEqual([WITHDRAWN.id]);
    const all: FindingView[] = [...g.decisionDone, ...g.decisionWithdrawn, ...Object.values(g.openByStage).flatMap((s) => [...s.noMitigation, ...s.overdue, ...s.other]),
      ...g.lookAgain, ...g.closed, ...g.withdrawn];
    expect(new Set(ids(all)).size).toBe(8); expect(all).toHaveLength(8);
  });

  it('UX-15 FR-FND-06: a gate answered "no" lists under decision now done; an accepted risk not yet due is closed', () => {
    const g = groupFindings({ findings: [OPEN_OTHER, ACCEPTED_DUE], toClose: [{ ...OPEN_OTHER, reason: 'gate_no', decisionVersionId: 'gate-v' }], lookAgain: [] });
    expect(g.decisionDone.map((x) => [x.id, x.decisionVersionId])).toEqual([[OPEN_OTHER.id, 'gate-v']]);
    expect(g.openByStage['pre-processing']).toEqual(empty);
    expect(ids(g.closed)).toEqual([ACCEPTED_DUE.id]); expect(g.lookAgain).toEqual([]);
  });

  it('UX-15: open findings group by their own stage, and within a group the oldest raised comes first', () => {
    const late = f('late', { raisedAt: '2026-11-03T08:00:00.000Z', stage: 'post-processing' });
    const early = f('early', { raisedAt: '2026-10-01T08:00:00.000Z', stage: 'post-processing' });
    const g = groupFindings({ findings: [late, early, f('mid', { stage: 'in-processing' })], toClose: [], lookAgain: [] });
    expect(ids(g.openByStage['post-processing'].other)).toEqual(['early', 'late']);
    expect(ids(g.openByStage['in-processing'].other)).toEqual(['mid']);
  });
});
