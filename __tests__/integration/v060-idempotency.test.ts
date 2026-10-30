import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { OrgContext, TenantTx } from '../../lib/data/tenant';
import { withOrg } from '../../lib/data/tenant';
import {
  derivedRequestId, idempotentWrite, isRequestId, requestDigest, type ReceiptResult,
} from '../../lib/data/idempotency';
import { resetDb, testDb } from '../helpers/db';

/**
 * NFR-INT-02 (SRS line 3079), FR-DEC-07, SRS 5.3 item 4 (line 1261), 9.5 rule 5: a write is
 * retry-safe. Normal mode keys on the record table's (orgId, requestId); receipt mode (owner
 * answer A1; 00-contract.md Services, idempotentWrite, rounds 9 and 9b) keys on
 * request_receipts under a transaction-scoped advisory lock, always at READ COMMITTED.
 */

const FV = 'fv_k0a_idem';
const BODY = { status: 'done' };
const DIGEST = requestDigest({ path: { id: 'p' }, body: BODY });
const ROUTE = 'app/api/v1/orgs/[slug]/projects/route.ts::POST';

let orgA: string; let orgB: string; let owner: string; let other: string; let ownerB: string; let p1: string; let p2: string;
let ctxA: OrgContext; let ctxB: OrgContext;
let REQ: string;

beforeAll(async () => {
  await testDb.$executeRaw`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES (${FV}, '0.0.0-k0a-idem', ${'c'.repeat(64)}, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`;
});
beforeEach(async () => {
  await resetDb();
  const user = async () => (await testDb.user.create({ data: { email: `idem-${randomUUID()}@fixture.test`, name: 'u', passwordHash: 'x' } })).id;
  [owner, other, ownerB] = [await user(), await user(), await user()];
  orgA = (await testDb.organization.create({ data: { name: 'A', slug: `idem-a-${randomUUID().slice(0, 6)}` } })).id;
  orgB = (await testDb.organization.create({ data: { name: 'B', slug: `idem-b-${randomUUID().slice(0, 6)}` } })).id;
  p1 = (await testDb.project.create({ data: { orgId: orgA, name: 'p1', createdById: owner } })).id;
  p2 = (await testDb.project.create({ data: { orgId: orgA, name: 'p2', createdById: owner } })).id;
  ctxA = { orgId: orgA, role: 'owner' } as OrgContext;
  ctxB = { orgId: orgB, role: 'owner' } as OrgContext;
  REQ = randomUUID();
});
afterAll(async () => { await testDb.$disconnect(); });

/** Normal mode: a decision save, as route 1 makes one. */
function saveArgs(requestId: string, over: { digest?: string; actorUserId?: string; projectId?: string } = {}) {
  const digest = over.digest ?? DIGEST;
  const actor = over.actorUserId ?? owner;
  const projectId = over.projectId ?? p1;
  return {
    table: 'decision_versions' as const, requestId, digest, actorUserId: actor,
    write: async (tx: TenantTx) => tx.decisionVersion.create({ data: {
      orgId: orgA, projectId, stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: FV,
      versionNumber: (await tx.decisionVersion.count({ where: { projectId, questionId: 'Q-PP-01' } })) + 1,
      status: 'done', enteredById: actor, enteredByRole: 'owner', requestId, requestDigest: digest,
    } }),
    replay: (tx: TenantTx, rowId: string) => tx.decisionVersion.findUniqueOrThrow({ where: { id: rowId } }),
  };
}

/** Receipt mode: one projects row, as route 23 (row 23 POST) creates. */
function receiptArgs(requestId: string, over: Partial<{ ctxOrg: string; actorUserId: string; digest: string; route: string;
  write: (tx: TenantTx) => Promise<{ id: string }>; result: ReceiptResult }> = {}) {
  const orgId = over.ctxOrg ?? orgA;
  const actor = over.actorUserId ?? owner;
  const seen: Array<{ rowId: string | null; result: ReceiptResult | null }> = [];
  return {
    seen,
    args: {
      table: 'request_receipts' as const, route: over.route ?? ROUTE, requestId, digest: over.digest ?? DIGEST, actorUserId: actor,
      write: over.write ?? ((tx: TenantTx) => tx.project.create({ data: { orgId, name: 'p', createdById: actor } })),
      receipt: (p: { id: string }) => ({ rowId: p.id, result: over.result ?? { emailSent: false, count: 1 } }),
      replay: (tx: TenantTx, r: { rowId: string | null; result: ReceiptResult | null }) => {
        seen.push(r);
        return tx.project.findUniqueOrThrow({ where: { id: r.rowId as string } });
      },
    },
  };
}

const receiptsFor = (orgId: string) => testDb.requestReceipt.findMany({ where: { orgId } });
const countProjects = (orgId: string) => testDb.project.count({ where: { orgId } });
const countDecisionVersions = () => testDb.decisionVersion.count({ where: { orgId: orgA } });

describe('requestDigest, isRequestId, derivedRequestId', () => {
  it('NFR-INT-02 (9.5 rule 5): derived request ids are RFC 4122 version 5 and deterministic', () => {
    expect(derivedRequestId('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(derivedRequestId('0f8fad5b-d9cb-469f-a165-70867728950e', 'mitigation_versions:m-1')).toBe('c29ae6cd-4720-5acb-963a-559a08d375ce');
    expect(derivedRequestId('0F8FAD5B-D9CB-469F-A165-70867728950E', 'mitigation_versions:m-1')).toBe('c29ae6cd-4720-5acb-963a-559a08d375ce');
    expect(() => derivedRequestId('x', 'y')).toThrow(TypeError);
  });

  it('NFR-INT-02 FR-DEC-07: requestDigest is the SHA-256 of the canonical body, path ids included; isRequestId takes any 8-4-4-4-12 hex', () => {
    expect(requestDigest({ b: 1, a: 'x' })).toBe(createHash('sha256').update('{"a":"x","b":1}').digest('hex'));
    expect(requestDigest({ path: { id: 'p1' }, body: BODY })).not.toBe(requestDigest({ path: { id: 'p2' }, body: BODY }));
    expect(() => requestDigest({ x: 1.5 })).toThrow(TypeError);
    expect([isRequestId(randomUUID()), isRequestId(randomUUID().toUpperCase()), isRequestId('not-a-uuid'), isRequestId(7)]).toEqual([true, true, false, false]);
  });
});

describe('idempotentWrite, normal mode', () => {
  it('NFR-INT-02 FR-DEC-07: 20 concurrent copies of one request create one row and 20 equal answers', async () => {
    const outs = await Promise.all(Array.from({ length: 20 }, () => idempotentWrite(ctxA, saveArgs(REQ))));
    expect(await countDecisionVersions()).toBe(1);
    expect(new Set(outs.map((o) => o.value.id)).size).toBe(1);
    expect(outs.filter((o) => !o.replayed)).toHaveLength(1);
  });

  it('NFR-INT-02 FR-DEC-07: the same request id with a different digest answers 409 request_id_reused', async () => {
    await idempotentWrite(ctxA, saveArgs(REQ));
    await expect(idempotentWrite(ctxA, saveArgs(REQ, { digest: 'other' }))).rejects.toMatchObject({ status: 409, code: 'request_id_reused' });
    expect(await countDecisionVersions()).toBe(1);
  });

  it('NFR-INT-02: another account replaying a request id gets 409 and no data', async () => {
    await idempotentWrite(ctxA, saveArgs(REQ));
    const e = await idempotentWrite(ctxA, saveArgs(REQ, { actorUserId: other })).catch((x) => x);
    expect(e).toMatchObject({ status: 409, code: 'request_id_reused' });
    expect(e.extra).toBeUndefined();
    expect(JSON.stringify(e.extra ?? {})).not.toContain(REQ);
  });

  it('NFR-INT-02 FR-DEC-07: the same request id and body against two projects answers 409 request_id_reused (the digest covers the path)', async () => {
    await idempotentWrite(ctxA, saveArgs(REQ, { digest: requestDigest({ path: { id: p1 }, body: BODY }), projectId: p1 }));
    await expect(idempotentWrite(ctxA, saveArgs(REQ, { digest: requestDigest({ path: { id: p2 }, body: BODY }), projectId: p2 })))
      .rejects.toMatchObject({ code: 'request_id_reused' });
  });

  it('NFR-INT-02: a malformed request id answers 422 on requestId before any SQL', async () => {
    let wrote = false;
    const blank = { orgId: '', role: 'owner' } as OrgContext;   // withOrg would refuse this; validation must come first
    await expect(idempotentWrite(blank, { ...saveArgs('not-a-uuid'), write: async () => { wrote = true; return null as never; } }))
      .rejects.toMatchObject({ status: 422, code: 'validation', extra: { fields: [expect.objectContaining({ field: 'requestId' })] } });
    expect(wrote).toBe(false);
  });

  it('NFR-INT-02 FR-DEC-07: a copy whose own state check fails because the first copy committed meanwhile still replays', async () => {
    // Copy 2 looks up (nothing yet), then waits inside its write until copy 1 has committed,
    // then its state check sees copy 1's row and refuses, as DEC-a's base-version check would.
    let firstCommitted!: () => void;
    const committed = new Promise<void>((r) => (firstCommitted = r));
    const second = idempotentWrite(ctxA, { ...saveArgs(REQ), write: async (tx: TenantTx) => {
      await committed;
      if ((await tx.decisionVersion.count({ where: { projectId: p1, questionId: 'Q-PP-01' } })) > 0) {
        throw Object.assign(new Error('base_version_moved'), { status: 409, code: 'base_version_moved' });
      }
      throw new Error('unreachable: copy 1 committed first');
    } });
    await new Promise((r) => setTimeout(r, 150));   // copy 2 is past its lookup
    const first = await idempotentWrite(ctxA, saveArgs(REQ));
    firstCommitted();
    expect(await second).toMatchObject({ replayed: true, value: { id: first.value.id } });
    // With no row under the request id, the state check's own error reaches the caller unchanged.
    const lone = await idempotentWrite(ctxA, { ...saveArgs(randomUUID()), write: async () => { throw Object.assign(new Error('base_version_moved'), { code: 'base_version_moved' }); } }).catch((x) => x);
    expect(lone).toMatchObject({ message: 'base_version_moved', code: 'base_version_moved' });
  });

  it('NFR-INT-02: a write that does not stamp the request id on its row is refused, so a retry cannot add a second row', async () => {
    const unstamped = { ...saveArgs(REQ), write: (tx: TenantTx) => tx.decisionVersion.create({ data: {
      orgId: orgA, projectId: p1, stage: 'pre-processing', questionId: 'Q-PP-02', contentVersionId: FV, versionNumber: 1, status: 'done',
      enteredById: owner, enteredByRole: 'owner', requestId: randomUUID(), requestDigest: DIGEST } }) };
    await expect(idempotentWrite(ctxA, unstamped)).rejects.toThrow(TypeError);
    expect(await countDecisionVersions()).toBe(0);   // rolled back
  });

  it('NFR-INT-02: a write creating two rows of one table under one request does not collide', async () => {
    const finding = await testDb.finding.create({ data: { orgId: orgA, projectId: p1, stage: 'pre-processing', source: 'team', raisedById: owner, requestId: randomUUID(), requestDigest: 'd' } });
    const m1 = randomUUID(); const m2 = randomUUID();
    const mv = (tx: TenantTx, mitigationId: string, requestId: string, findingSeq: number) => tx.mitigationVersion.create({ data: {
      orgId: orgA, findingId: finding.id, mitigationId, versionNumber: 1, ownerUserId: owner, dueDate: new Date('2026-11-10'),
      status: 'cancelled', kind: 'action', enteredById: owner, enteredByRole: 'owner', findingSeq,
      requestId, requestDigest: DIGEST } });
    const args = {
      table: 'mitigation_versions' as const, requestId: REQ, digest: DIGEST, actorUserId: owner,
      write: async (tx: TenantTx) => {
        const first = await mv(tx, m1, REQ, 1);
        await mv(tx, m2, derivedRequestId(REQ, `mitigation_versions:${m2}`), 2);
        return first;
      },
      replay: (tx: TenantTx, rowId: string) => tx.mitigationVersion.findUniqueOrThrow({ where: { id: rowId } }),
    };
    const out = await idempotentWrite(ctxA, args);
    expect(out.replayed).toBe(false);
    expect(await testDb.mitigationVersion.count({ where: { requestDigest: DIGEST } })).toBe(2);
    expect(await idempotentWrite(ctxA, args)).toMatchObject({ replayed: true, value: { id: out.value.id } });
  });
});

describe('idempotentWrite, receipt mode (owner answer A1)', () => {
  it('NFR-INT-02: receipt mode inserts one receipt carrying the actor, route, digest, row id and result with the first write', async () => {
    const out = await idempotentWrite(ctxA, receiptArgs(REQ).args);
    expect(out.replayed).toBe(false);
    expect(await receiptsFor(orgA)).toEqual([expect.objectContaining({ requestId: REQ, requestDigest: DIGEST, actorUserId: owner,
      route: ROUTE, rowId: out.value.id, result: { emailSent: false, count: 1 } })]);
    expect(await countProjects(orgA)).toBe(3);   // p1, p2 and the one created
  });

  it('NFR-INT-02: receipt mode, a replay by the same actor, route and digest answers replayed true with the stored receipt, and writes nothing', async () => {
    const first = await idempotentWrite(ctxA, receiptArgs(REQ).args);
    const again = receiptArgs(REQ, { write: () => { throw new Error('write must not run on a replay'); } });
    expect(await idempotentWrite(ctxA, again.args)).toMatchObject({ replayed: true, value: { id: first.value.id } });
    expect(again.seen).toEqual([{ rowId: first.value.id, result: { emailSent: false, count: 1 } }]);
    expect(await receiptsFor(orgA)).toHaveLength(1);
    expect(await countProjects(orgA)).toBe(3);
  });

  it('NFR-INT-02: receipt mode, the same id and digest on a different route answers 409 request_id_reused', async () => {
    await idempotentWrite(ctxA, receiptArgs(REQ).args);
    const e = await idempotentWrite(ctxA, receiptArgs(REQ, { route: 'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts::POST' }).args).catch((x) => x);
    expect(e).toMatchObject({ status: 409, code: 'request_id_reused' });
    expect(e.extra).toBeUndefined();
    expect(await countProjects(orgA)).toBe(3);
  });

  it('NFR-INT-02: receipt mode, another actor or another digest answers 409 request_id_reused with no row data', async () => {
    await idempotentWrite(ctxA, receiptArgs(REQ).args);
    const byOther = await idempotentWrite(ctxA, receiptArgs(REQ, { actorUserId: other }).args).catch((x) => x);
    const byDigest = await idempotentWrite(ctxA, receiptArgs(REQ, { digest: 'other' }).args).catch((x) => x);
    for (const e of [byOther, byDigest]) {
      expect(e).toMatchObject({ status: 409, code: 'request_id_reused' });
      expect(JSON.stringify(e.extra ?? {})).not.toContain(REQ);
    }
    expect(await countProjects(orgA)).toBe(3);
  });

  it('NFR-INT-02: receipt mode, 20 concurrent copies give one effect, one receipt, one first answer and 19 replays, none failing', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => idempotentWrite(ctxA, receiptArgs(REQ).args)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);   // no 40001, no 409
    const outs = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean; value: { id: string } }>).value);
    expect(outs.filter((o) => !o.replayed)).toHaveLength(1);
    expect(outs.filter((o) => o.replayed)).toHaveLength(19);
    expect(new Set(outs.map((o) => o.value.id)).size).toBe(1);
    expect(await receiptsFor(orgA)).toHaveLength(1);
    expect(await countProjects(orgA)).toBe(3);
  });

  it('NFR-INT-02: receipt mode, a state change stores a null row id and its replay is passed it', async () => {
    const args = (seen: unknown[]) => ({
      table: 'request_receipts' as const, route: 'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts::POST', requestId: REQ, digest: DIGEST, actorUserId: owner,
      write: async () => 'archived' as const,
      receipt: () => ({ rowId: null }),
      replay: async (_tx: TenantTx, r: { rowId: string | null; result: ReceiptResult | null }) => { seen.push(r); return 'archived' as const; },
    });
    const seen: unknown[] = [];
    expect(await idempotentWrite(ctxA, args(seen))).toEqual({ replayed: false, value: 'archived' });
    expect(await idempotentWrite(ctxA, args(seen))).toEqual({ replayed: true, value: 'archived' });
    expect(seen).toEqual([{ rowId: null, result: null }]);
    expect((await receiptsFor(orgA))[0]).toMatchObject({ rowId: null, result: null });
  });

  it('NFR-INT-02: receipt mode, a write that throws leaves no receipt, and a malformed request id answers 422 on requestId', async () => {
    await expect(idempotentWrite(ctxA, receiptArgs(REQ, { write: () => { throw new Error('boom'); } }).args)).rejects.toThrow('boom');
    expect(await receiptsFor(orgA)).toEqual([]);
    await expect(idempotentWrite(ctxA, receiptArgs('not-a-uuid').args)).rejects.toMatchObject({ status: 422, code: 'validation', extra: { fields: [expect.objectContaining({ field: 'requestId' })] } });
    // A failed first attempt leaves the request id free: the retry is a first write.
    expect((await idempotentWrite(ctxA, receiptArgs(REQ).args)).replayed).toBe(false);
  });

  it('NFR-INT-02 NFR-SEC-01: receipt mode, another organisation cannot see a receipt, and the same request id there is a new request', async () => {
    await idempotentWrite(ctxA, receiptArgs(REQ).args);
    expect(await withOrg(ctxB, (tx) => tx.requestReceipt.findMany())).toEqual([]);   // RLS: org B reads none of org A's receipts
    expect(await withOrg(ctxA, (tx) => tx.requestReceipt.count())).toBe(1);
    const inB = await idempotentWrite(ctxB, receiptArgs(REQ, { ctxOrg: orgB, actorUserId: ownerB }).args);
    expect(inB.replayed).toBe(false);
    expect(await receiptsFor(orgA)).toHaveLength(1);
    expect(await receiptsFor(orgB)).toHaveLength(1);
  });

  it('NFR-INT-02 (round 9b): receipt mode always runs at READ COMMITTED, and refuses a string in the stored result at run time', async () => {
    const level = receiptArgs(REQ, { write: async (tx) => {
      const [{ l }] = await tx.$queryRaw<{ l: string }[]>`SELECT current_setting('transaction_isolation') AS l`;
      expect(l).toBe('read committed');
      return tx.project.create({ data: { orgId: orgA, name: 'p', createdById: owner } });
    } });
    expect((await idempotentWrite(ctxA, level.args)).replayed).toBe(false);
    const REQ2 = randomUUID();
    const withString = receiptArgs(REQ2, { result: { acceptUrl: 'https://x.test/invite/secret' } as unknown as ReceiptResult });
    await expect(idempotentWrite(ctxA, withString.args)).rejects.toThrow(TypeError);
    expect(await testDb.requestReceipt.count({ where: { requestId: REQ2 } })).toBe(0);
    expect(await countProjects(orgA)).toBe(3);   // the write rolled back with it
  });

  it('NFR-INT-02 (round 9b): ReceiptResult holds booleans, numbers and null only, and receipt mode takes no isolationLevel (type test, checked by npm run typecheck)', () => {
    const ok: ReceiptResult = { emailSent: true, count: 2, none: null };
    // @ts-expect-error a string is not a ReceiptResult value: no token, URL, address or free text is stored
    const bad: ReceiptResult = { acceptUrl: 'https://x.test/t' };
    // @ts-expect-error receipt mode always runs at READ COMMITTED: it takes no isolationLevel
    const call = () => idempotentWrite(ctxA, { ...receiptArgs(REQ).args, isolationLevel: 'RepeatableRead' });
    expect([ok, bad, typeof call]).toHaveLength(3);
  });
});
