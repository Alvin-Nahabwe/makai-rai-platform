import { describe, expect, it } from 'vitest';
import type { AcceptedRiskView, FindingView, UserRef } from '@/types/api';
import { deciderLabel } from '@/lib/decision/copy';
import { findingSourceLabel, findingStateLabel, OUTSIDE_ROLE_LABELS, overdueLabel, stageCountHeading, STAGE_NAMES } from '@/lib/findings/labels';

const ANNA: UserRef = { userId: 'u-anna', name: 'Anna K.', formerMember: false };
const AR = { id: 'a1', findingId: 'f1', acceptedBy: { kind: 'member', user: ANNA }, accepterRole: 'owner', reason: 'Why', lookAgainNote: null, lookAgainOn: null,
  enteredBy: ANNA, enteredByRole: 'owner', findingSeq: 3, receivedAt: '2026-10-30T10:00:00.000Z', erasedFields: [] } as AcceptedRiskView;
const SHORTFALL = { id: 'f1', source: 'shortfall', questionId: 'Q-PP-12' } as FindingView;
const TEAM = { id: 'f2', source: 'team', questionId: 'Q-PP-12' } as FindingView;

describe('finding labels (7.5.6, 7.5.8)', () => {
  it('FR-FND-05: state labels follow 7.5.6, naming the accepter', () => {
    expect(findingStateLabel('closed_accepted_risk', { ...AR, acceptedBy: { kind: 'outside_role', role: 'ethics_committee' } })).toBe(`Closed: risk accepted by ${deciderLabel({ kind: 'outside_role', role: 'ethics_committee' }, '', 'record')}`);
    expect(findingStateLabel('closed_accepted_risk', AR)).toBe('Closed: risk accepted by Anna K.');
    expect(findingStateLabel('closed_accepted_risk', { ...AR, acceptedBy: { kind: 'member', user: { ...ANNA, formerMember: true } } })).toBe('Closed: risk accepted by Anna K. (former member)');
    expect(findingStateLabel('closed_mitigation', null)).toBe('Closed by mitigation');
    expect(findingStateLabel('open', null)).toBe('Open');
    expect(findingStateLabel('withdrawn', null)).toBe('Withdrawn');
    expect(findingSourceLabel(SHORTFALL, { versionNumber: 3, status: 'not_yet' })).toBe('From question Q-PP-12 (version 3, status Not yet)');
    expect(findingSourceLabel(SHORTFALL, { versionNumber: 1, status: 'partly' })).toBe('From question Q-PP-12 (version 1, status Partly)');
    expect(findingSourceLabel(TEAM, null)).toBe('Raised by the team');
  });

  it('FR-DEC-01: the outside roles are FR-DEC-01\'s list', () => {
    expect(Object.values(OUTSIDE_ROLE_LABELS)).toEqual(['Principal investigator', 'Supervisor', 'Ethics committee', 'Data-access committee',
      'Institutional data-protection officer', 'Funder', 'Other']);
  });

  it('UX-07 UX-06 (R13-7, R13-9): the stage heading carries a whole-number count with the singular for one, and the overdue phrase comes in two parts', () => {
    expect(stageCountHeading('Pre-processing', 41)).toBe('Pre-processing: 41 findings');
    expect(stageCountHeading('In-processing', 1)).toBe('In-processing: 1 finding');
    expect(overdueLabel('2026-10-28')).toEqual({ label: 'Overdue', rest: ': was due 28 Oct 2026' });
    expect(STAGE_NAMES).toEqual({ 'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing' });
  });
});
