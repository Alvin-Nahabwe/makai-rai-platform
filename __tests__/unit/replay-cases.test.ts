import { describe, expect, it } from 'vitest';
import {
  checksChangedRequest, conflictingRequest, expectedEffect, expectedStatuses, sameResource, type PreparedReplay, type ReplayCase,
} from '../helpers/replayCases';

/** The generator of `__tests__/integration/retry-keyed-writes.test.ts`, pinned on fake prepared cases, with no database. */
const base = {
  role: 'assessor' as const,
  body: () => ({ requestId: 'r1' }),
  changedBody: () => ({ requestId: 'r1', reason: 'changed' }),
  rows: async () => 0,
  resourceId: () => 'x',
};

describe('__tests__/helpers/replayCases.ts', () => {
  it('FR-DEC-07 NFR-INT-02: a case with changedParams sends body() to changedParams() and ignores changedBody (two-object fake case)', () => {
    const p: PreparedReplay = { ...base, params: { id: 'A' }, changedParams: () => ({ id: 'B' }) };
    expect(conflictingRequest(p)).toEqual({ params: { id: 'B' }, body: { requestId: 'r1' } });
  });

  it('FR-DEC-07 NFR-INT-02: a case without changedParams sends changedBody() to the same params', () => {
    const p: PreparedReplay = { ...base, params: { id: 'A' } };
    expect(conflictingRequest(p)).toEqual({ params: { id: 'A' }, body: { requestId: 'r1', reason: 'changed' } });
  });

  it('FR-DEC-07 NFR-INT-02: the generator reads the contract row, not a private variant: changedParams is optional and returns Record<string, string>', () => {
    const p: PreparedReplay = { ...base, params: { id: 'A', questionId: 'Q' }, changedParams: () => ({ id: 'B', questionId: 'Q' }) };
    expect(Object.keys(conflictingRequest(p).params).sort()).toEqual(['id', 'questionId']);
  });

  // Round 9: the generator over a fake PATCH case and a fake 204 case
  const patchPrepared: PreparedReplay = { ...base, params: { id: 'P' }, resourceId: (j) => (j as { id: string }).id };
  const patchCase: ReplayCase = { route: 'app/api/v1/x/route.ts', method: 'PATCH', statuses: { first: 200, replay: 200 }, prepare: async () => patchPrepared };
  const noContentPrepared: PreparedReplay = {   // no resourceId: a 204 has no body
    role: 'owner', params: { id: 'P' }, body: () => ({ requestId: 'r2' }), changedBody: () => ({ requestId: 'r2', note: 'changed' }), rows: async () => 0,
  };
  const noContentCase: ReplayCase = { route: 'app/api/v1/y/route.ts', method: 'DELETE', statuses: { first: 204, replay: 204 }, prepare: async () => noContentPrepared };

  it('FR-DEC-07 NFR-INT-02: a case without statuses expects 201 then 200', () => {
    expect(expectedStatuses({})).toEqual({ first: 201, replay: 200 });
  });

  it('FR-DEC-07 NFR-INT-02: a fake PATCH case sends PATCH, expects 200 then 200 and compares the resource ids', () => {
    expect(patchCase.method).toBe('PATCH');
    expect(expectedStatuses(patchCase)).toEqual({ first: 200, replay: 200 });
    expect(sameResource(patchPrepared, { id: 'a' }, { id: 'a' })).toBe(true);
    expect(sameResource(patchPrepared, { id: 'a' }, { id: 'b' })).toBe(false);
  });

  it('FR-DEC-07 NFR-INT-02: the PATCH case sends changedBody() to the same params for the 409 case', () => {
    expect(conflictingRequest(patchPrepared)).toEqual({ params: { id: 'P' }, body: { requestId: 'r1', reason: 'changed' } });
  });

  it('FR-DEC-07 NFR-INT-02: a fake 204 case expects 204 then 204 and compares no ids (no resourceId, no body)', () => {
    expect(noContentCase.method).toBe('DELETE');
    expect(expectedStatuses(noContentCase)).toEqual({ first: 204, replay: 204 });
    expect(sameResource(noContentPrepared, undefined, undefined)).toBe(true);
    expect(conflictingRequest(noContentPrepared)).toEqual({ params: { id: 'P' }, body: { requestId: 'r2', note: 'changed' } });
  });

  it('FR-DEC-07 NFR-INT-02: a case whose replay is refused at the gate declares its own pair', () => {
    expect(expectedStatuses({ statuses: { first: 204, replay: 404 } })).toEqual({ first: 204, replay: 404 });
  });

  // Round 9b: a removal case and a case whose changed-request case is skipped
  it('FR-DEC-07 NFR-INT-02: a case without effect expects rows() to move by +1, and a removal case declares -1', () => {
    expect(expectedEffect({})).toBe(1);
    expect(expectedEffect({ effect: -1 })).toBe(-1);
  });

  it('FR-DEC-07 NFR-INT-02: the changed-request case runs unless the case sets changedRequest: false', () => {
    expect(checksChangedRequest({})).toBe(true);
    expect(checksChangedRequest({ changedRequest: false })).toBe(false);
  });

  const leaveCase: ReplayCase = {   // a fake of MEM's leave case: removal, gate-refused replay, no changed-request case
    route: 'app/api/v1/z/route.ts', method: 'POST', statuses: { first: 204, replay: 404 }, effect: -1, changedRequest: false, prepare: async () => noContentPrepared,
  };
  it('FR-DEC-07 NFR-INT-02: a fake leave case expects 204 then 404, a change of -1 and no changed-request case', () => {
    expect([expectedStatuses(leaveCase), expectedEffect(leaveCase), checksChangedRequest(leaveCase)]).toEqual([{ first: 204, replay: 404 }, -1, false]);
  });
});
