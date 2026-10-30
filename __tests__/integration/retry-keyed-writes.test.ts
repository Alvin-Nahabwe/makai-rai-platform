import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PENDING_ROUTES, RETRY_KEYED_WRITES } from '@/lib/authz/routeActions';
import { resetDb } from '../helpers/db';
import { clearSession, sessionFor } from '../helpers/authSession';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import {
  checksChangedRequest, concurrentCopiesProblems, conflictingRequest, expectedEffect, expectedStatuses, loadReplayCases, sameResource,
  type PreparedReplay, type ReplayBody, type ReplayCase,
} from '../helpers/replayCases';

/**
 * NFR-INT-02 over every retry-keyed write route (contract `replayCases.ts` row; 00-master.md Review Focus RF-1): each
 * `RETRY_KEYED_WRITES` route and method whose file has left `PENDING_ROUTES` has a case file under
 * `replay-cases/`, and every case is run three ways: a replay, the same request id with a changed request, and 20
 * concurrent copies. Each case starts from an empty database (`resetDb`) and one new organisation.
 */

// Concurrent route calls need the identity step queued (the vitest limitation is stated at queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

beforeEach(async () => {
  await resetDb();
  clearSession();
});

/** Sends `body` with the case's method to its route as the case's role; a JSON body or a FormData body. */
async function call(fx: OrgFixture, c: ReplayCase, p: PreparedReplay, body: ReplayBody, params: Record<string, string> = p.params): Promise<Response> {
  sessionFor(fx.members[p.role].userId);
  const mod = (await import(/* @vite-ignore */ `@/${c.route.replace(/\.ts$/, '')}`)) as Record<string, Handler>;
  const handler = mod[c.method];
  if (typeof handler !== 'function') throw new Error(`${c.route} exports no ${c.method}`);
  const init = body instanceof FormData
    ? { method: c.method, body }
    : { method: c.method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  return handler(new NextRequest('http://localhost/replay', init), { params: Promise.resolve(params) });
}

const cases = await loadReplayCases();

// one (route, method) pair per RETRY_KEYED_WRITES entry: route 24 holds a PATCH and a DELETE under one file
const implemented = Object.entries(RETRY_KEYED_WRITES)
  .filter(([f]) => !PENDING_ROUTES.includes(f))
  .flatMap(([f, methods]) => methods.map((m) => `${f}::${m}`));

it('NFR-INT-02: every implemented retry-keyed write route and method has a replay case', () => {
  const have = new Set(cases.map((c) => `${c.route}::${c.method}`));
  expect(implemented.length).toBeGreaterThan(0);
  expect(implemented.filter((k) => !have.has(k))).toEqual([]);
});

describe.each(cases)('$route $method', (c) => {
  const { first, replay } = expectedStatuses(c);
  const effect = expectedEffect(c);

  it(`FR-DEC-07 NFR-INT-02: replaying ${c.method} ${c.route} with the same request id has one effect`, async () => {
    const fx = await buildOrg();
    const p = await c.prepare(fx);
    const before = await p.rows();
    const r1 = await call(fx, c, p, p.body());
    const r2 = await call(fx, c, p, p.body());
    expect([r1.status, r2.status]).toEqual([first, replay]);
    if (p.resourceId) expect(sameResource(p, await r1.json(), await r2.json())).toBe(true);   // a 204 has no body
    expect((await p.rows()) - before).toBe(effect);
  });

  it.skipIf(!checksChangedRequest(c))(`NFR-INT-02: ${c.method} ${c.route} with the same request id and a changed request answers 409 request_id_reused and changes nothing more`, async () => {
    const fx = await buildOrg();
    const p = await c.prepare(fx);
    const before = await p.rows();
    await call(fx, c, p, p.body());
    const conflict = conflictingRequest(p);
    const r = await call(fx, c, p, conflict.body, conflict.params);
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect((await p.rows()) - before).toBe(effect);   // the refused request changed nothing, in either object
  });

  it(`NFR-INT-02: 20 concurrent copies of ${c.method} ${c.route} have one effect`, async () => {
    const fx = await buildOrg();
    const p = await c.prepare(fx);
    const before = await p.rows();
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(fx, c, p, p.body())));
    expect(concurrentCopiesProblems(c, rs.map((r) => r.status), (await p.rows()) - before)).toEqual([]);
  });
});
