import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import type { SaveDecisionRequest } from '@/types/api';
import { onShortfallSaved } from '@/lib/data/findings';
import { PENDING_ROUTES } from '@/lib/authz/routeActions';
import { POST as SAVE_POST } from '@/app/api/v1/orgs/[slug]/projects/[id]/decisions/route';
import { POST as WITHDRAW_POST } from '@/app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { clearSession, sessionFor } from '../helpers/authSession';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { addDecision, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';

// FND-a merges after DEC-a, so its real onShortfallSaved is the null stub here; this file alone replaces it to make it
// return a finding (contract rule 5). FND-a's own tests prove the same log line through the real function.
vi.mock('@/lib/data/findings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/findings')>()),
  onShortfallSaved: vi.fn(async () => null),
}));

// Concurrent route calls: `requireIdentityForApi` imports the mocked `lib/auth` dynamically, and vitest resolves only
// one of several overlapping dynamic imports of a factory-mocked module to the mock; the others load the real module,
// which cannot load outside Next ("this will not work if user does Promise.all(import(), import())",
// node_modules/vitest/dist/chunks/startVitestModuleRunner.DB-7oCpn.js:398). So this file queues the identity step
// alone, the real function unchanged; the saves behind it still overlap in the database. The mocked `auth()` reads the
// one session `sessionFor` set when the queued call runs, so concurrent calls in this file all use one role.
vi.mock('@/lib/auth/identity', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/identity')>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ...real,
    requireIdentityForApi: () => {
      const next = queue.then(() => real.requireIdentityForApi());
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  };
});

const SAVE_FILE ='app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts';
const WITHDRAW_FILE = 'app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route.ts';

let fx: OrgFixture;
let project: { id: string };
let contentVersionId: string;

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  project = await addProject(fx);
  clearSession();
  vi.mocked(onShortfallSaved).mockReset();   // back to the factory's `async () => null`, no once-values left over
});

const body = (over: Partial<SaveDecisionRequest> = {}): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Fixture reason', decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...over,
});
const countVersions = () => testDb.decisionVersion.count({ where: { projectId: project.id } });
const jsonReq = (path: string, b: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', body: typeof b === 'string' ? b : b instanceof Uint8Array ? new Blob([new Uint8Array(b)]) : JSON.stringify(b),
  headers: { 'content-type': 'application/json', ...headers },
});
const post = (role: OrgRole | null, b: unknown, headers: Record<string, string> = {}) => {
  if (role) sessionFor(fx.members[role].userId); else clearSession();
  return SAVE_POST(jsonReq(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, b, headers),
    { params: Promise.resolve({ slug: fx.org.slug, id: project.id }) });
};
const withdraw = (role: OrgRole, b: unknown, questionId = 'Q-PP-01') => {
  sessionFor(fx.members[role].userId);
  return WITHDRAW_POST(jsonReq(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/questions/${questionId}/withdrawal`, b),
    { params: Promise.resolve({ slug: fx.org.slug, id: project.id, questionId }) });
};

/** NFR-REL-04: a deferred constraint trigger that raises at COMMIT, so the transaction fails after its callback finished. */
async function withCommitFault<T>(fn: () => Promise<T>): Promise<T> {
  await testDb.$executeRawUnsafe(`CREATE FUNCTION test_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit fault'; END $$`);
  await testDb.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER test_commit_fault AFTER INSERT ON decision_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_commit_fault()`);
  try {
    return await fn();
  } finally {
    await testDb.$executeRawUnsafe('DROP TRIGGER test_commit_fault ON decision_versions');
    await testDb.$executeRawUnsafe('DROP FUNCTION test_commit_fault()');
  }
}

describe('the decision routes (contract Routes rows 1 and 2)', () => {
  it('FR-DEC-07 UX-27: a dropped reply replayed answers 200 with the same version; a changed body under the same id answers 409', async () => {
    const b = body();
    const first = await post('assessor', b);
    expect(first.status).toBe(201);
    const again = await post('assessor', b);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
    expect(await countVersions()).toBe(1);
    const changed = await post('assessor', { ...b, reason: 'Edited after the send' });
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe('request_id_reused');
    const edited = await post('assessor', { ...b, requestId: randomUUID(), reason: 'Edited after the send', baseVersionNumber: 1 });
    expect(edited.status).toBe(201);
  });

  it('FR-DEC-07 NFR-INT-02: the same request id and body sent to another project answers 409 request_id_reused and writes nothing there', async () => {
    const b = body();
    expect((await post('assessor', b)).status).toBe(201);
    const other = await addProject(fx, { name: 'Other' });
    sessionFor(fx.members.assessor.userId);
    const r = await SAVE_POST(jsonReq(`/api/v1/orgs/${fx.org.slug}/projects/${other.id}/decisions`, b), { params: Promise.resolve({ slug: fx.org.slug, id: other.id }) });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('request_id_reused');
    expect(await testDb.decisionVersion.count({ where: { projectId: other.id } })).toBe(0);
  });

  it('FR-DEC-07: two copies of one save at the same moment both answer 2xx with the same version number', async () => {
    const b = body();
    const rs = await Promise.all([post('assessor', b), post('assessor', b)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(new Set(await Promise.all(rs.map(async (r) => (await r.json()).versionNumber))).size).toBe(1);
  });

  it('UX-28 FR-DEC-05: the 409 body carries the newer version, who entered it and when', async () => {
    await post('assessor', body());
    await post('owner', body({ baseVersionNumber: 1, status: 'partly', reason: 'Owner reason' }));
    const r = await post('assessor', body({ baseVersionNumber: 1, reason: 'Mine' }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'base_version_moved', current: { versionNumber: 2, reason: 'Owner reason',
      enteredBy: { userId: fx.members.owner.userId, name: expect.any(String) }, receivedAt: expect.any(String) } });
  });

  it('FR-DEC-01 NFR-SEC-02: a reviewer and a viewer get 403 and nothing is written', async () => {
    for (const role of ['reviewer', 'viewer'] as const) expect((await post(role, body())).status).toBe(403);
    expect(await countVersions()).toBe(0);
  });

  it('NFR-SEC-02: a project of organisation B answers 404 to organisation A', async () => {
    const fxB = await buildOrg({ label: 'B' });
    const pB = await addProject(fxB);
    sessionFor(fx.members.assessor.userId);
    const r = await SAVE_POST(jsonReq(`/api/v1/orgs/${fx.org.slug}/projects/${pB.id}/decisions`, body()), { params: Promise.resolve({ slug: fx.org.slug, id: pB.id }) });
    expect(r.status).toBe(404);
    expect(await testDb.decisionVersion.count()).toBe(0);
  });

  it('NFR-SEC-08: a cross-origin save answers 403 and writes nothing', async () => {
    // A NextRequest built in vitest sets no Host, and assertSameOrigin refuses an Origin with no Host (contract
    // lib/http/sameOrigin.ts row), so each call sets host to the request's own host: the first is refused for the
    // foreign Origin and not for a missing Host.
    expect((await post('assessor', body(), { origin: 'https://evil.example', host: 'localhost' })).status).toBe(403);
    expect(await countVersions()).toBe(0);
    expect((await post('assessor', body(), { origin: 'http://localhost', host: 'localhost' })).status).toBe(201);
  });

  it('FR-PRJ-03 (helper): a save and a withdrawal in an archived project answer 409 project_archived and write nothing', async () => {
    project = await addProject(fx, { archived: true });
    const r = await post('assessor', body());
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('project_archived');
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId });
    const w = await withdraw('assessor', { requestId: randomUUID(), stage: 'pre-processing', baseVersionNumber: 1, withdrawalCode: 'duplicate', reason: 'Duplicate.' });
    expect(w.status).toBe(409);
    expect((await w.json()).code).toBe('project_archived');
    expect(await countVersions()).toBe(1);
  });

  it('FR-DEC-02: malformed JSON and a float baseVersionNumber answer 422, not 500', async () => {
    const malformed = await post('assessor', '{"reason":');
    expect(malformed.status).toBe(422);
    expect((await malformed.json()).fields).toEqual([expect.objectContaining({ field: 'body' })]);
    // A reason holding the byte 0xFF, which is not UTF-8: refused, not stored as U+FFFD.
    const json = new TextEncoder().encode(JSON.stringify(body({ reason: 'XX' })));
    const at = json.indexOf(0x58);
    json[at] = 0xff;
    const notUtf8 = await post('assessor', json);
    expect(notUtf8.status).toBe(422);
    expect((await notUtf8.json()).fields).toEqual([expect.objectContaining({ field: 'body' })]);
    const float = await post('assessor', { ...body(), baseVersionNumber: 1.5 });
    expect(float.status).toBe(422);
    expect((await float.json()).fields).toEqual([expect.objectContaining({ field: 'baseVersionNumber' })]);
    expect(await countVersions()).toBe(0);
  });

  it('NFR-REL-04: a database failure at commit leaves no version and no 2xx', async () => {
    await withCommitFault(async () => {
      const outcome = await post('assessor', body()).then((r) => r.status, () => 'threw');
      expect(outcome === 'threw' || (typeof outcome === 'number' && outcome >= 500)).toBe(true);
      expect(await countVersions()).toBe(0);
    });
  });

  it('NFR-OBS-01 NFR-PRIV-03: one DECISION_SAVED line with ids only, none on a replay', async () => {
    const b = body({ reason: markerFor('reason', 1) });
    const { lines } = await captureLogs(async () => { await post('assessor', b); await post('assessor', b); });
    const ev = lines.filter((l) => l.includes('"DECISION_SAVED"'));
    expect(ev).toHaveLength(1);
    expect(Object.keys(JSON.parse(ev[0]).details).sort()).toEqual(['orgId', 'projectId', 'versionId', 'versionNumber']);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-OBS-01 FR-FND-01 (helper): a save that raises a shortfall logs one FINDING_RAISED after commit, with ids only, and none on its replay', async () => {
    vi.mocked(onShortfallSaved).mockResolvedValueOnce({ findingId: 'f-1' });
    const b = body({ status: 'partly', reasonCode: null });
    const { lines } = await captureLogs(async () => { await post('assessor', b); await post('assessor', b); });
    const ev = lines.filter((l) => l.includes('"FINDING_RAISED"'));
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]).details).toEqual({ orgId: fx.org.id, projectId: project.id, findingId: 'f-1', source: 'shortfall' });
  });

  it('NFR-OBS-01 NFR-REL-04: a save whose transaction fails after onShortfallSaved returned a finding logs no FINDING_RAISED', async () => {
    vi.mocked(onShortfallSaved).mockResolvedValueOnce({ findingId: 'f-2' });
    await withCommitFault(async () => {
      const { result: outcome, lines } = await captureLogs(() => post('assessor', body({ status: 'partly' })).then((r) => r.status, () => 'threw'));
      expect(outcome === 'threw' || (typeof outcome === 'number' && outcome >= 500)).toBe(true);
      expect(vi.mocked(onShortfallSaved)).toHaveBeenCalledTimes(1);
      expect(lines.filter((l) => l.includes('"FINDING_RAISED"') || l.includes('"DECISION_SAVED"'))).toEqual([]);
      expect(await countVersions()).toBe(0);
    });
  });

  it('FR-DEC-08: the withdrawal route answers 201 and logs DECISION_WITHDRAWN', async () => {
    expect((await post('assessor', body())).status).toBe(201);
    expect((await post('assessor', body({ baseVersionNumber: 1, status: 'partly' }))).status).toBe(201);
    const w = { requestId: randomUUID(), stage: 'pre-processing', baseVersionNumber: 2, withdrawalCode: 'duplicate', reason: 'Duplicate of Q-PP-02.' };
    const { result, lines } = await captureLogs(async () => {
      const r = await withdraw('assessor', w);
      return { status: r.status, json: await r.json(), again: (await withdraw('assessor', w)).status };
    });
    expect(result).toMatchObject({ status: 201, json: { versionNumber: 3, status: 'withdrawn', withdrawalCode: 'duplicate' }, again: 200 });
    const ev = lines.filter((l) => l.includes('"DECISION_WITHDRAWN"'));
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]).details).toEqual({ orgId: fx.org.id, projectId: project.id, versionId: result.json.id, versionNumber: 3 });
  });

  it('FR-DEC-08 NFR-SEC-02: the withdrawal route answers 403 to a viewer, 403 to an assessor on another member\'s entry, and 422 to a bad body', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, by: 'owner' });
    const w = { requestId: randomUUID(), stage: 'pre-processing', baseVersionNumber: 1, withdrawalCode: 'duplicate', reason: 'Duplicate.' };
    expect((await withdraw('viewer', w)).status).toBe(403);
    expect((await withdraw('assessor', w)).status).toBe(403);
    expect((await withdraw('assessor', { ...w, withdrawalCode: 'oops' })).status).toBe(422);
    expect(await countVersions()).toBe(1);
  });

  it('UX-24 NFR-MNT-01: the decision routes export POST only and are no longer pending', async () => {
    for (const f of [SAVE_FILE, WITHDRAW_FILE]) {
      const mod = (await import(/* @vite-ignore */ `@/${f.replace(/\.ts$/, '')}`)) as Record<string, unknown>;
      expect(Object.keys(mod).filter((k) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
      expect(PENDING_ROUTES).not.toContain(f);
    }
  });
});
