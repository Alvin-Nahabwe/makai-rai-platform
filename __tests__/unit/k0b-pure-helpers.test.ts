import { describe, it, expect } from 'vitest';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { invitationState } from '@/lib/data/invitationState';

describe('K0b pure helpers', () => {
  it('FR-FUP-02 (helper): overdue turns at 21:00Z on the due date; cancelled never overdue', () => {
    const m = { status: 'planned' as const, dueDate: '2026-11-02' };
    expect(isOverdue(m, 'open', eatDate(new Date('2026-11-02T20:59:00Z')))).toBe(false);
    expect(isOverdue(m, 'open', eatDate(new Date('2026-11-02T21:00:00Z')))).toBe(true);
    expect(isOverdue({ status: 'cancelled', dueDate: '2026-11-01' }, 'open', eatDate(new Date('2026-11-02T21:00:00Z')))).toBe(false);
    expect(isOverdue(m, 'closed_accepted_risk', '2026-11-10')).toBe(false);
  });

  it('FR-FUP-02 (helper): only planned and in progress mitigations of an open finding can be overdue', () => {
    const due = '2026-11-01';
    const today = '2026-11-02';
    expect(isOverdue({ status: 'planned', dueDate: due }, 'open', today)).toBe(true);
    expect(isOverdue({ status: 'in_progress', dueDate: due }, 'open', today)).toBe(true);
    expect(isOverdue({ status: 'done', dueDate: due }, 'open', today)).toBe(false);
    expect(isOverdue({ status: 'cancelled', dueDate: due }, 'open', today)).toBe(false);
    for (const state of ['closed_mitigation', 'closed_accepted_risk', 'withdrawn'] as const)
      expect(isOverdue({ status: 'planned', dueDate: due }, state, today), state).toBe(false);
    // due today is not yet overdue; due yesterday is; a year boundary compares as dates
    expect(isOverdue({ status: 'planned', dueDate: today }, 'open', today)).toBe(false);
    expect(isOverdue({ status: 'planned', dueDate: '2026-12-31' }, 'open', '2027-01-01')).toBe(true);
  });

  it('FR-FUP-02 (helper): eatDate is the date in UTC+3, across a day, a month and a year boundary', () => {
    expect(eatDate(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
    expect(eatDate(new Date('2026-11-02T20:59:59.999Z'))).toBe('2026-11-02');
    expect(eatDate(new Date('2026-11-02T21:00:00.000Z'))).toBe('2026-11-03');
    expect(eatDate(new Date('2026-10-31T21:00:00Z'))).toBe('2026-11-01');
    expect(eatDate(new Date('2026-12-31T21:00:00Z'))).toBe('2027-01-01');
    expect(eatDate(new Date('2028-02-28T21:00:00Z'))).toBe('2028-02-29');
    expect(() => eatDate(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('FR-ORG-02 FR-MEM-02 (helper): a pending invitation past expiresAt reads expired', () => {
    expect(invitationState({ status: 'pending', expiresAt: new Date('2026-11-01') }, new Date('2026-11-02'))).toBe('expired');
    expect(invitationState({ status: 'revoked', expiresAt: new Date('2026-12-01') }, new Date('2026-11-02'))).toBe('revoked');
  });

  it('FR-ORG-02 FR-MEM-02 (helper): pending is valid until expiresAt, which itself is expired; the other states never change', () => {
    const at = new Date('2026-11-02T10:00:00Z');
    expect(invitationState({ status: 'pending', expiresAt: new Date('2026-11-02T10:00:01Z') }, at)).toBe('pending');
    expect(invitationState({ status: 'pending', expiresAt: at }, at)).toBe('expired');
    const past = new Date('2020-01-01');
    for (const status of ['accepted', 'expired', 'revoked'] as const)
      expect(invitationState({ status, expiresAt: past }, at), status).toBe(status);
  });
});
