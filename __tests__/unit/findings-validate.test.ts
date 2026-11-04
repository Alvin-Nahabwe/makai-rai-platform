import { describe, expect, it } from 'vitest';
import type { AcceptRiskRequest, AddMitigationRequest, UpdateMitigationRequest } from '@/types/api';
import {
  CHANGE_NOTE_MAX, TEXT_MAX, parseAcceptRisk, parseAddMitigation, parseCloseByDecision, parseFindingEvent, parseUpdateMitigation, textLength,
} from '@/lib/findings/validate';
import { onlyRolesCanText } from '@/lib/findings/messages';

const R = '0b8f7c1e-3a2d-4c5b-9e6f-7a8b9c0d1e2f';
const ADD: AddMitigationRequest = {
  requestId: R, what: 'Relabel the minority class', ownerUserId: 'user-1', dueDate: '2026-11-10', status: 'planned',
  followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [],
};
const UPDATE: UpdateMitigationRequest = { ...ADD, baseVersionNumber: 1, changeNote: null };
const ACCEPT: AcceptRiskRequest = {
  requestId: R, mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Out of budget this year',
  lookAgainOn: null, lookAgainNote: null,
};
const fieldsOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { extra?: { fields?: Array<{ field: string }> } }).extra?.fields?.map((f) => f.field); }
  return [];
};

describe('lib/findings/messages.ts and lib/findings/validate.ts', () => {
  it('M-26 FR-FND-05 UX-17: the not-allowed texts come from GRANTS', () => {
    expect(onlyRolesCanText('risk:accept')).toBe('Only owners and admins can accept a risk.');
    expect(onlyRolesCanText('mitigation:write')).toBe('Only owners, admins and assessors can add or update a mitigation.');
    expect(onlyRolesCanText('finding:reopen')).toBe('Only owners, admins and assessors can reopen a finding.');
  });

  it('FR-FND-03: text limits: 4,000 characters, the change note 1,000, counted in code points after NFC', () => {
    expect([TEXT_MAX, CHANGE_NOTE_MAX]).toEqual([4000, 1000]);
    expect(textLength('Café')).toBe(4);
    expect(textLength('Café')).toBe(4);                       // NFC joins e + combining acute
    expect(textLength('  \u{1F600} ')).toBe(1);                      // trimmed; an emoji counts once
    expect(() => parseUpdateMitigation({ ...UPDATE, changeNote: 'x'.repeat(1001) })).toThrow(expect.objectContaining({ status: 422 }));
    expect(parseUpdateMitigation({ ...UPDATE, changeNote: 'x'.repeat(1000) }).changeNote).toHaveLength(1000);
    expect(() => parseAddMitigation({ ...ADD, what: 'x'.repeat(4001) })).toThrow(expect.objectContaining({ status: 422 }));
    expect(parseAddMitigation({ ...ADD, what: '\u{1F600}'.repeat(4000) }).what).toHaveLength(8000);   // 4,000 code points
    expect(() => parseAcceptRisk({ ...ACCEPT, reason: '   ' })).toThrow(expect.objectContaining({ extra: { fields: [{ field: 'reason', message: 'Write why the risk is accepted.' }] } }));
  });

  it('FR-FND-07: an event code other than null is refused (no code set exists in v1)', () => {
    expect(() => parseFindingEvent({ requestId: R, reason: 'x', eventCode: 'any' })).toThrow(expect.objectContaining({ status: 422 }));
    expect(parseFindingEvent({ requestId: R, reason: 'x', eventCode: null })).toEqual({ requestId: R, reason: 'x', eventCode: null });
    expect(() => parseFindingEvent({ requestId: R, reason: '', eventCode: null })).toThrow(expect.objectContaining({
      extra: { fields: [{ field: 'reason', message: 'Write a reason.' }] } }));
  });

  it('FR-FND-03 FR-FND-04 UX-16: the field texts of the mitigation form', () => {
    const one = (body: unknown) => { try { parseAddMitigation(body); } catch (e) { return (e as { extra: { fields: unknown[] } }).extra.fields; } return []; };
    expect(one({ ...ADD, ownerUserId: '' })).toEqual([{ field: 'ownerUserId', message: 'Choose an owner.' }]);
    expect(one({ ...ADD, dueDate: '2026-02-30' })).toEqual([{ field: 'dueDate', message: 'Enter a due date.' }]);
    expect(one({ ...ADD, dueDate: null })).toEqual([{ field: 'dueDate', message: 'Enter a due date.' }]);
    expect(one({ ...ADD, what: ' ' })).toEqual([{ field: 'what', message: 'Write what will be done.' }]);
    expect(one({ ...ADD, status: 'done' })).toEqual([{ field: 'closureNote', message: 'Add closure evidence, or say why there is none.' }]);
    expect(one({ ...ADD, status: 'done', evidenceIds: ['ev-1'] })).toEqual([]);
    expect(one({ ...ADD, status: 'cancelled' })).toEqual([{ field: 'cancelReason', message: 'Say why it is cancelled.' }]);
    expect(fieldsOf(() => parseUpdateMitigation({ ...UPDATE, baseVersionNumber: 0 }))).toEqual(['baseVersionNumber']);
  });

  it('FR-FND-03 NFR-SEC-02: a body is read as exactly its own keys, and hand-made shapes answer 422 naming the field', () => {
    const parsed = parseAddMitigation({ ...ADD, enteredById: 'forged', enteredByRole: 'owner', receivedAt: '2000-01-01T00:00:00Z' });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(ADD).sort());
    expect(fieldsOf(() => parseAddMitigation(null))).toEqual(['body']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, requestId: 'nope' }))).toEqual(['requestId']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, status: 'closed' }))).toEqual(['status']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, evidenceIds: ['a', 'a'] }))).toEqual(['evidenceIds']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, evidenceIds: Array.from({ length: 101 }, (_, i) => `e${i}`) }))).toEqual(['evidenceIds']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, what: 'a\u0000b' }))).toEqual(['what']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, closureNote: 'kept', status: 'planned' }))).toEqual(['closureNote']);
    expect(fieldsOf(() => parseAddMitigation({ ...ADD, cancelReason: 'why', status: 'planned' }))).toEqual(['cancelReason']);
  });

  it('FR-FND-05: accept and keep-accepted bodies: who accepted, the look-again date and its note', () => {
    expect(fieldsOf(() => parseAcceptRisk({ ...ACCEPT, acceptedBy: { kind: 'member' } }))).toEqual(['acceptedBy']);
    expect(fieldsOf(() => parseAcceptRisk({ ...ACCEPT, mode: 'other' }))).toEqual(['mode']);
    expect(fieldsOf(() => parseAcceptRisk({ ...ACCEPT, lookAgainOn: '2026-13-01' }))).toEqual(['lookAgainOn']);
    expect(fieldsOf(() => parseAcceptRisk({ ...ACCEPT, mode: 'keep_accepted' }))).toEqual(['lookAgainNote']);
    expect(parseAcceptRisk({ ...ACCEPT, mode: 'keep_accepted', lookAgainNote: 'Still out of budget', lookAgainOn: '2027-03-01' }))
      .toMatchObject({ mode: 'keep_accepted', lookAgainOn: '2027-03-01' });
    expect(parseCloseByDecision({ requestId: R, decisionVersionId: 'v2', extra: 1 })).toEqual({ requestId: R, decisionVersionId: 'v2' });
    expect(fieldsOf(() => parseCloseByDecision({ requestId: R, decisionVersionId: '' }))).toEqual(['decisionVersionId']);
  });

  it('FR-FND-03 FR-FND-04: a blank optional note reads as none; a missing or non-text one is named as such', () => {
    expect(parseAddMitigation({ ...ADD, status: 'done', evidenceIds: ['ev-1'], closureNote: '' }).closureNote).toBeNull();
    expect(parseAddMitigation({ ...ADD, cancelReason: '  ' }).cancelReason).toBeNull();
    expect(parseUpdateMitigation({ ...UPDATE, changeNote: ' ' }).changeNote).toBeNull();
    expect(parseAcceptRisk({ ...ACCEPT, lookAgainNote: '' }).lookAgainNote).toBeNull();
    const one = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { extra: { fields: unknown[] } }).extra.fields; } return []; };
    expect(one(() => parseAddMitigation({ ...ADD, status: 'done', closureNote: '' }))).toEqual([{ field: 'closureNote', message: 'Add closure evidence, or say why there is none.' }]);
    expect(one(() => parseAddMitigation({ ...ADD, closureNote: 5 }))).toEqual([{ field: 'closureNote', message: 'closureNote must be text or null.' }]);
    const { cancelReason: _omitted, ...noCancelKey } = ADD;
    expect(one(() => parseAddMitigation(noCancelKey))).toEqual([{ field: 'cancelReason', message: 'cancelReason must be text or null.' }]);
    expect(one(() => parseUpdateMitigation({ ...UPDATE, changeNote: false }))).toEqual([{ field: 'changeNote', message: 'changeNote must be text or null.' }]);
  });

  it('FR-FND-03 F12: every text is stored as measured: trimmed and NFC, so padding cannot carry it past the limit', () => {
    const padded = 'x'.repeat(3990) + ' '.repeat(1010);
    expect(parseAddMitigation({ ...ADD, what: padded }).what).toHaveLength(3990);
    expect(parseAddMitigation({ ...ADD, what: '  Cafe\u0301  ' }).what).toBe('Caf\u00e9');
    expect(parseAddMitigation({ ...ADD, status: 'done', closureNote: ` ${padded}` }).closureNote).toHaveLength(3990);
    expect(parseAddMitigation({ ...ADD, status: 'cancelled', cancelReason: `${padded}\n` }).cancelReason).toHaveLength(3990);
    expect(parseUpdateMitigation({ ...UPDATE, changeNote: `  ${'n'.repeat(1000)}  ` }).changeNote).toHaveLength(1000);
    expect(parseAcceptRisk({ ...ACCEPT, reason: padded, lookAgainNote: padded })).toMatchObject({ reason: 'x'.repeat(3990), lookAgainNote: 'x'.repeat(3990) });
    expect(parseFindingEvent({ requestId: R, reason: padded, eventCode: null }).reason).toHaveLength(3990);
  });

  it('FR-FND-03 NFR-SEC-02: an id field holding a character the database cannot store answers 422 on that field', () => {
    const one = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { extra: { fields: unknown[] } }).extra.fields; } return []; };
    expect(one(() => parseAddMitigation({ ...ADD, ownerUserId: 'user\u0000-1' }))).toEqual([{ field: 'ownerUserId', message: 'Choose an owner.' }]);
    expect(one(() => parseAddMitigation({ ...ADD, evidenceIds: ['ev\u0000'] }))).toEqual([{ field: 'evidenceIds', message: 'Attach each evidence item once, and at most 100.' }]);
    expect(one(() => parseAcceptRisk({ ...ACCEPT, acceptedBy: { kind: 'member', userId: 'u\u0000' } }))).toEqual([{ field: 'acceptedBy', message: 'Choose who accepted the risk.' }]);
    expect(one(() => parseCloseByDecision({ requestId: R, decisionVersionId: 'v\uD800' }))).toEqual([{ field: 'decisionVersionId', message: 'Choose the decision version that closes this finding.' }]);
  });
});
