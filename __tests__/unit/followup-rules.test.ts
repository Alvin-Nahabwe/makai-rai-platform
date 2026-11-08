import { describe, expect, it } from 'vitest';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { canAct, reminderDue, reminderDueAfterCap, selectOpenMitigations } from '@/lib/followup/rules';
import type { FollowUpSourceRows } from '@/lib/data/tenant';
import type { MitigationStatus, Stage } from '@/types/record';

const at = (iso: string) => new Date(iso);

type M = { id: string; due: string; owner?: string; status?: MitigationStatus; finding?: string };
function rows(ms: M[], extra: Partial<FollowUpSourceRows> = {}, findingIds: string[] = ['f1']): FollowUpSourceRows {
  return {
    findings: findingIds.map((id) => ({ id, projectId: 'p1', stage: 'pre-processing' as Stage, source: 'team' as const })),
    events: [],
    acceptedRisks: [],
    currentMitigations: ms.map((m, i) => ({
      versionId: `v-${m.id}`, mitigationId: m.id, findingId: m.finding ?? 'f1', ownerUserId: m.owner ?? 'u-assessor',
      dueDate: m.due, status: m.status ?? 'planned', findingSeq: i + 1,
    })),
    archivedProjectIds: [],
    ...extra,
  };
}
const rowsWith = (pairs: Array<[string, string]>) => rows(pairs.map(([id, due]) => ({ id, due })));

const MIXED_ROWS: FollowUpSourceRows = (() => {
  const base = rows([
    { id: 'm-open-assessor', due: '2026-11-05', owner: 'u-assessor' },
    { id: 'm-open-viewer', due: '2026-11-06', owner: 'u-viewer' },
    { id: 'm-done', due: '2026-11-01', status: 'done', finding: 'f-done' },
    { id: 'm-cancelled', due: '2026-11-01', status: 'cancelled', finding: 'f-cancelled' },
    { id: 'm-accepted', due: '2026-11-01', finding: 'f-accepted' },
    { id: 'm-archived', due: '2026-11-01', finding: 'f-archived' },
  ], {}, ['f1', 'f-done', 'f-cancelled', 'f-accepted', 'f-archived']);
  base.findings = base.findings.map((f) => (f.id === 'f-archived' ? { ...f, projectId: 'p-arch' } : f));
  base.acceptedRisks = [{ findingId: 'f-accepted', findingSeq: 99 }];
  base.archivedProjectIds = ['p-arch'];
  return base;
})();

describe('follow-up rules', () => {
  it('FR-FUP-02: overdue turns at midnight East Africa Time, and a cancelled mitigation is never overdue', () => {
    expect(isOverdue({ status: 'planned', dueDate: '2026-11-02' }, 'open', eatDate(at('2026-11-02T20:59:00Z')))).toBe(false);
    expect(isOverdue({ status: 'planned', dueDate: '2026-11-02' }, 'open', eatDate(at('2026-11-02T21:00:00Z')))).toBe(true);
    expect(isOverdue({ status: 'cancelled', dueDate: '2026-11-01' }, 'open', eatDate(at('2026-11-02T21:00:00Z')))).toBe(false);
  });

  it('FR-FUP-01: due yesterday, today and next week are listed in that order, the first marked overdue', () => {
    const out = selectOpenMitigations(rowsWith([['m-week', '2026-11-09'], ['m-today', '2026-11-02'], ['m-yday', '2026-11-01']]), () => true, '2026-11-02');
    expect(out.map((m) => [m.mitigationId, m.overdue])).toEqual([['m-yday', true], ['m-today', false], ['m-week', false]]);
  });

  it('FR-FUP-01: equal due dates are ordered by mitigation id', () => {
    const out = selectOpenMitigations(rowsWith([['m-b', '2026-11-02'], ['m-a', '2026-11-02']]), () => true, '2026-11-02');
    expect(out.map((m) => m.mitigationId)).toEqual(['m-a', 'm-b']);
  });

  it('FR-FUP-05: done, cancelled, closed-finding and archived-project mitigations are not listed; an unactable owner is marked', () => {
    const out = selectOpenMitigations(MIXED_ROWS, (u) => u !== 'u-viewer', '2026-11-02');
    expect(out.map((m) => m.mitigationId).sort()).toEqual(['m-open-assessor', 'm-open-viewer']);
    expect(out.find((m) => m.mitigationId === 'm-open-viewer')!.ownerCanAct).toBe(false);
    expect(out.find((m) => m.mitigationId === 'm-open-assessor')!.ownerCanAct).toBe(true);
  });

  it('FR-FUP-05: canAct needs a role that may write mitigations and an active account', () => {
    expect([canAct('assessor', true), canAct('reviewer', true), canAct('viewer', true), canAct(undefined, true), canAct('owner', false), canAct('owner', undefined)])
      .toEqual([true, false, false, false, false, false]);
  });

  it('FR-FUP-03 NFR-REL-08: the due reminder is eligible from 06:00 EAT on the day and on the next day; the overdue one on days 7 and 8', () => {
    expect(reminderDue('2026-11-02', at('2026-11-02T02:59:00Z'))).toBeNull();          // 05:59 EAT
    expect(reminderDue('2026-11-02', at('2026-11-02T03:00:00Z'))).toBe('due');           // 06:00 EAT
    expect(reminderDue('2026-11-02', at('2026-11-03T20:59:00Z'))).toBe('due');           // 23:59 EAT, day after
    expect(reminderDue('2026-11-02', at('2026-11-03T21:00:00Z'))).toBeNull();
    expect(reminderDue('2026-11-02', at('2026-11-09T03:00:00Z'))).toBe('overdue');       // day 7, 06:00 EAT
    expect(reminderDue('2026-11-02', at('2026-11-10T12:00:00Z'))).toBe('overdue');       // day 8
    expect(reminderDue('2026-11-02', at('2026-11-10T21:00:00Z'))).toBeNull();            // day 9
  });

  it('FR-FUP-03: only the day after a kind\'s last eligible day has a held-back kind', () => {
    expect(reminderDueAfterCap('2026-11-02', at('2026-11-04T04:00:00Z'))).toBe('due');          // due + 2
    expect(reminderDueAfterCap('2026-11-02', at('2026-11-11T04:00:00Z'))).toBe('overdue');      // due + 9
    for (const iso of ['2026-11-02T04:00:00Z', '2026-11-03T04:00:00Z', '2026-11-05T04:00:00Z', '2026-11-10T04:00:00Z', '2026-11-12T04:00:00Z'])
      expect(reminderDueAfterCap('2026-11-02', at(iso)), iso).toBeNull();
  });
});
