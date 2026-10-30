import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { FieldError, OutsideRole } from '@/types/record';
import type { ContentRef, SaveDecisionRequest } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import { saveDecision } from '@/lib/data/decisions';
import { parseSaveDecisionRequest, parseWithdrawDecisionRequest } from '@/lib/decision/parse';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addEvidence, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let content: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  content = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const actor = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
const body = (over: Partial<SaveDecisionRequest> = {}): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Fixture reason', decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...over,
});
const save = (role: OrgRole, b: SaveDecisionRequest) =>
  saveDecision(ctxFor(fx, role), actor(role), { ...b, projectId: project.id }, requestDigest({ path: { id: project.id }, body: b }));
const countVersions = () => testDb.decisionVersion.count({ where: { projectId: project.id } });
/** The database's UTC date plus `days`, as 'YYYY-MM-DD'. */
async function dbUtcDatePlus(days: number): Promise<string> {
  const [{ d }] = await testDb.$queryRaw<{ d: string }[]>`SELECT (((clock_timestamp() AT TIME ZONE 'UTC')::date) + ${days}::int)::text AS d`;
  return d;
}

describe('saveDecision: server validation (FR-DEC-01, FR-DEC-02)', () => {
  const CASES: Array<[string, Partial<SaveDecisionRequest>, string]> = [
    ['no status', { status: null }, 'status'],
    ['status on the gate', { questionId: 'Q-PP-GATE-SENSITIVE', status: 'done' }, 'status'],
    ['scope answer on a practice question', { scopeAnswer: 'yes' }, 'scopeAnswer'],
    ['option not of the question', { questionId: 'Q-PP-16', status: 'partly', optionsInPlace: ['Not an option'] }, 'optionsInPlace'],
    ['options on a practice question', { optionsInPlace: ['x'] }, 'optionsInPlace'],
    ['question not in the running content', { questionId: 'Q-NOT-THERE' }, 'questionId'],
    ['question of another stage', { stage: 'in-processing' }, 'stage'],
    ['not yet without a reason code', { status: 'not_yet' }, 'reasonCode'],
    ['done with a reason code', { reasonCode: 'ny_planned_later' }, 'reasonCode'],
    ['reason code of the other status', { status: 'not_yet', reasonCode: 'na_other' }, 'reasonCode'],
    ['empty reason', { reason: '' }, 'reason'],
    ['4,001 characters', { reason: 'a'.repeat(4001) }, 'reason'],
    ['NUL in the reason', { reason: 'a\u0000b' }, 'reason'],
    ['outside role not on the list', { decidedBy: { kind: 'outside_role', role: 'astrologer' as OutsideRole } }, 'decidedBy'],
    ['31 February', { declaredDate: '2026-02-31' }, 'declaredDate'],
    ['date not a date', { declaredDate: '26-1' }, 'declaredDate'],
    ['year 0000', { declaredDate: '0000' }, 'declaredDate'],
  ];
  it.each(CASES)('FR-DEC-02: %s answers 422 and writes nothing', async (_n, over, field) => {
    const e = await save('assessor', body(over)).catch((x) => x);
    expect(e).toMatchObject({ status: 422, code: 'validation' });
    expect(e.extra.fields.map((f: FieldError) => f.field)).toContain(field);
    expect(await countVersions()).toBe(0);
  });

  it('FR-DEC-02: a declared date two days after the received date answers 422', async () => {
    const inTwoDays = await dbUtcDatePlus(2);
    await expect(save('assessor', body({ declaredDate: inTwoDays }))).rejects.toMatchObject({ status: 422 });
  });

  it('FR-DEC-01: no reason answers 422 naming reason', async () => {
    await expect(save('assessor', body({ reason: '' }))).rejects.toMatchObject({ extra: { fields: [{ field: 'reason' }] } });
  });

  it('FR-DEC-01 FR-DEC-02: a decider who never was a member, or is a member of another organisation, is refused', async () => {
    const stranger = (await buildOrg({ label: 'other' })).members.assessor.userId;
    await expect(save('assessor', body({ decidedBy: { kind: 'member', userId: stranger } }))).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'decidedBy' }] } });
  });

  it('FR-DEC-02: evidence of another project and a repeated evidence id answer 422', async () => {
    const other = await addProject(fx, { name: 'Other' });
    const ev = await addEvidence(fx, other.id, { kind: 'link', url: 'https://example.org/x' });
    await expect(save('assessor', body({ evidenceIds: [ev.id] }))).rejects.toMatchObject({ extra: { fields: [{ field: 'evidenceIds' }] } });
    const mine = await addEvidence(fx, project.id, { kind: 'link', url: 'https://example.org/y' });
    await expect(save('assessor', body({ evidenceIds: [mine.id, mine.id] }))).rejects.toMatchObject({ extra: { fields: [{ field: 'evidenceIds' }] } });
  });

  it('FR-DEC-02: more options in place than the question has answers 422 naming optionsInPlace', async () => {
    const e = await save('assessor', body({ questionId: 'Q-PP-16', status: 'partly', optionsInPlace: Array.from({ length: 50 }, (_, i) => `Option ${i}`) })).catch((x) => x);
    expect(e).toMatchObject({ status: 422, extra: { fields: [{ field: 'optionsInPlace' }] } });
    expect(await countVersions()).toBe(0);
  });

  it('FR-DEC-02 M-11: every problem found is answered in one 422, in field order', async () => {
    const e = await save('assessor', body({ status: 'not_yet', reason: '', declaredDate: '2026-13', evidenceIds: ['no-such-evidence'] })).catch((x) => x);
    expect(e.extra.fields.map((f: FieldError) => f.field)).toEqual(['reasonCode', 'reason', 'declaredDate', 'evidenceIds']);
    expect(content.semver).toBe('0.0.1-fixture');
  });
});

describe('parseSaveDecisionRequest and parseWithdrawDecisionRequest (FR-DEC-02, FR-DEC-08)', () => {
  const good = (): Record<string, unknown> => ({
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
    optionsInPlace: [], reasonCode: null, reason: 'r', decidedBy: { kind: 'outside_role', role: 'funder' }, declaredDate: '2026', evidenceIds: [],
  });
  const fieldsOf = (fn: () => unknown): string[] => {
    try { fn(); } catch (e) { return (e as { extra: { fields: FieldError[] } }).extra.fields.map((f) => f.field); }
    throw new Error('expected a ValidationFailed');
  };

  it('FR-DEC-02: a body that is not an object answers 422 naming body', () => {
    for (const json of [null, [], 'text', 3]) expect(fieldsOf(() => parseSaveDecisionRequest(json))).toEqual(['body']);
  });

  it('FR-DEC-02: a float baseVersionNumber and wrong-typed fields answer 422 naming every faulty field', () => {
    expect(fieldsOf(() => parseSaveDecisionRequest({ ...good(), baseVersionNumber: 1.5 }))).toEqual(['baseVersionNumber']);
    expect(fieldsOf(() => parseSaveDecisionRequest({ ...good(), requestId: 'nope', stage: 'later', status: 'withdrawn', optionsInPlace: [1],
      reasonCode: 7, reason: undefined, decidedBy: { kind: 'member' }, declaredDate: 2026, evidenceIds: 'x' })))
      .toEqual(['requestId', 'stage', 'status', 'optionsInPlace', 'reasonCode', 'reason', 'decidedBy', 'declaredDate', 'evidenceIds']);
  });

  it('FR-DEC-09: unknown keys are dropped, so they cannot reach the digest or the row', () => {
    const b = good();
    const parsed = parseSaveDecisionRequest({ ...b, enteredById: 'someone', receivedAt: '2000-01-01T00:00:00.000Z', weight: 0.5 });
    expect(parsed).toEqual(b);
    expect(() => requestDigest({ path: { id: 'p' }, body: parsed })).not.toThrow();
  });

  it('FR-DEC-02: more than 100 evidence ids answer 422 naming evidenceIds, before the service reads them', () => {
    expect(fieldsOf(() => parseSaveDecisionRequest({ ...good(), evidenceIds: Array.from({ length: 101 }, (_, i) => `ev-${i}`) }))).toEqual(['evidenceIds']);
    expect(parseSaveDecisionRequest({ ...good(), evidenceIds: Array.from({ length: 100 }, (_, i) => `ev-${i}`) }).evidenceIds).toHaveLength(100);
  });

  it('FR-DEC-08: a withdrawal needs a known withdrawal code, a base version and a reason of 1 to 4,000 characters', () => {
    const w = { requestId: randomUUID(), stage: 'pre-processing', baseVersionNumber: 2, withdrawalCode: 'duplicate', reason: 'Duplicate of Q-PP-02.' };
    expect(parseWithdrawDecisionRequest({ ...w, extra: true })).toEqual(w);
    expect(fieldsOf(() => parseWithdrawDecisionRequest({ ...w, withdrawalCode: 'oops', reason: '', baseVersionNumber: null })))
      .toEqual(['baseVersionNumber', 'withdrawalCode', 'reason']);
  });
});
