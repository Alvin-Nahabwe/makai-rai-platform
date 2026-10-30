import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { resetDb, testDb } from '../helpers/db';
import { buildTwoOrgFixture, FIXTURE_ROLES, type TwoOrgFixture, type FixtureOrg } from '../helpers/fixture';
import { sessionFor, clearSession } from '../helpers/authSession';
import { can, type Action } from '@/lib/authz/policy';
import { PENDING_ROUTES, ROUTE_ACTIONS, REMOVED_METHODS } from '@/lib/authz/routeActions';

/**
 * Every v0.6.0 route file exists from unit/k0b as a gated stub (contract "Routes"): the cross-origin check
 * for a write, then its gate, then a 501. This file is generated from PENDING_ROUTES, so a stub a producer
 * has not yet replaced is checked here and a producer's replacement leaves this file by leaving the list.
 * The producer column below is typed from the contract's route tables, not read from the files.
 */

type Gate = 'identity' | 'none' | 'token' | 'admin';

/** Contract rows 30, 33, 34, 37 and 40 to 46: the stubs that are not org-scoped, their methods and their gates. */
const NON_ORG: Record<string, { methods: string[]; gate: Gate } | undefined> = {
  'app/api/acceptances/route.ts': { methods: ['POST'], gate: 'identity' },
  'app/api/password-reset/route.ts': { methods: ['POST'], gate: 'none' },
  'app/api/password-reset/complete/route.ts': { methods: ['POST'], gate: 'none' },
  'app/api/users/me/preferences/route.ts': { methods: ['PATCH'], gate: 'identity' },
  'app/api/internal/reminders/route.ts': { methods: ['POST'], gate: 'token' },
  'app/api/admin/organisations/route.ts': { methods: ['POST'], gate: 'admin' },
  'app/api/admin/organisations/[orgId]/route.ts': { methods: ['PATCH'], gate: 'admin' },
  'app/api/admin/organisations/[orgId]/agreements/route.ts': { methods: ['POST'], gate: 'admin' },
  'app/api/admin/organisations/[orgId]/owner-invitations/route.ts': { methods: ['POST'], gate: 'admin' },
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts': { methods: ['POST'], gate: 'admin' },
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts': { methods: ['POST'], gate: 'admin' },
};

const ORG = 'app/api/v1/orgs/[slug]/';
const P = `${ORG}projects/[id]/`;
/** The contract's Producer column: the unit a stub names in `NotImplementedError`. */
const UNIT: Record<string, string> = {
  [`${P}decisions/route.ts`]: 'DEC-a',
  [`${P}questions/[questionId]/withdrawal/route.ts`]: 'DEC-a',
  [`${P}evidence/route.ts`]: 'EVD',
  [`${P}findings/route.ts`]: 'FND-b',
  [`${P}findings/[findingId]/mitigations/route.ts`]: 'FND-a',
  [`${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`]: 'FND-a',
  [`${P}findings/[findingId]/accepted-risks/route.ts`]: 'FND-a',
  [`${P}findings/[findingId]/reopen/route.ts`]: 'FND-a',
  [`${P}findings/[findingId]/withdrawal/route.ts`]: 'FND-a',
  [`${P}findings/[findingId]/close-by-decision/route.ts`]: 'FND-a',
  [`${P}reviews/route.ts`]: 'REV-b',
  [`${P}reviews/[reviewId]/seals/route.ts`]: 'REV-a',
  [`${P}reviews/[reviewId]/seals/[sealId]/check/route.ts`]: 'REV-a',
  [`${P}reviews/[reviewId]/documents/preview/route.ts`]: 'DOC-a',
  [`${P}reviews/[reviewId]/documents/route.ts`]: 'DOC-a',
  [`${ORG}documents/[documentId]/pdf/route.ts`]: 'DOC-a',
  [`${ORG}documents/[documentId]/text/route.ts`]: 'DOC-b',
  [`${ORG}documents/[documentId]/withdrawal/route.ts`]: 'DOC-b',
  [`${ORG}export/route.ts`]: 'EXP',
  [`${P}archive/route.ts`]: 'PRJ',
  [`${P}unarchive/route.ts`]: 'PRJ',
  [`${ORG}invitations/[invitationId]/resend/route.ts`]: 'MEM',
  [`${ORG}invitations/[invitationId]/revoke/route.ts`]: 'MEM',
  'app/api/acceptances/route.ts': 'ACC-a',
  'app/api/password-reset/route.ts': 'ACC-b',
  'app/api/password-reset/complete/route.ts': 'ACC-b',
  'app/api/users/me/preferences/route.ts': 'FUP',
  'app/api/internal/reminders/route.ts': 'OPS',
  'app/api/admin/organisations/route.ts': 'ORG',
  'app/api/admin/organisations/[orgId]/route.ts': 'ORG',
  'app/api/admin/organisations/[orgId]/agreements/route.ts': 'ORG',
  'app/api/admin/organisations/[orgId]/owner-invitations/route.ts': 'ORG',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts': 'ORG',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts': 'ORG',
};

function methodsOf(file: string): Array<[string, Action | null]> {
  const org = ROUTE_ACTIONS[file];
  if (org) return Object.entries(org) as Array<[string, Action]>;
  const other = NON_ORG[file];
  if (!other) throw new Error(`v060-route-stubs: ${file} is in PENDING_ROUTES but is neither in ROUTE_ACTIONS nor in this file's NON_ORG table`);
  return other.methods.map((m) => [m, null]);
}

type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  file: string, method: string, slug: string, headers: Record<string, string> = {},
): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ '@/' + file.replace(/\.ts$/, ''))) as Record<string, RouteHandler>;
  const params: Record<string, string> = {};
  for (const [, name] of file.matchAll(/\[(\w+)\]/g)) params[name] = name === 'slug' ? slug : `probe-${name}`;
  return mod[method](new NextRequest('http://localhost/probe', { method, headers }), { params: Promise.resolve(params) });
}

const UNAUTHENTICATED = { error: 'Unauthorized', code: 'unauthenticated' };

describe('v0.6.0 route stubs', () => {
  let fixture: TwoOrgFixture;
  let orgA: FixtureOrg;
  let orgB: FixtureOrg;
  let platformAdminId: string;

  const seat = (org: FixtureOrg, role: (typeof FIXTURE_ROLES)[number]): string => {
    const u = fixture.users.find((x) => x.orgSlug === org.slug && x.role === role && x.index === 0);
    if (!u) throw new Error(`no ${role} seat in ${org.slug}`);
    return u.userId;
  };

  beforeAll(async () => {
    await resetDb();
    fixture = await buildTwoOrgFixture();
    [orgA, orgB] = fixture.orgs;
    // A platform administrator with no organisation, as the v1 seed creates one (FR-ORG-04).
    platformAdminId = (await testDb.user.create({
      data: { email: 'stub-platform-admin@fixture.test', name: 'Stub Platform Admin', passwordHash: 'x', role: 'admin' },
    })).id;
  });

  it('NFR-MNT-01: PENDING_ROUTES holds every stub of this pull request, and each has a producer', () => {
    expect(PENDING_ROUTES.length).toBe(Object.keys(UNIT).length);
    for (const f of PENDING_ROUTES) expect({ f, unit: UNIT[f] !== undefined }).toEqual({ f, unit: true });
    for (const f of PENDING_ROUTES) expect(methodsOf(f).length).toBeGreaterThan(0);
  });

  for (const file of PENDING_ROUTES) {
    const gate: Gate | 'org' = NON_ORG[file]?.gate ?? 'org';
    for (const [method, action] of methodsOf(file)) {
      const write = method !== 'GET';
      const steps = { org: '401, 404, 403, ', identity: '401, ', none: '', token: '401, ', admin: '401, 403, ' }[gate];
      it(`NFR-SEC-02 NFR-SEC-08: ${method} ${file} (${gate}): ${steps}${write ? 'cross-origin 403, ' : ''}then 501`, async () => {
        const answers501 = async (res: Response) => {
          expect(res.status).toBe(501);
          expect(await res.json()).toEqual({ error: 'Not implemented', code: 'not_implemented', unit: UNIT[file] });
        };
        const crossOrigin = async (extra: Record<string, string> = {}) => {
          for (const origin of ['https://evil.example', 'null']) {
            const res = await call(file, method, orgA.slug, { ...extra, origin, host: 'localhost' });
            expect([origin, res.status, (await res.json()).code]).toEqual([origin, 403, 'cross_origin']);
          }
          // the same site is not another site (a request that names an Origin also names its Host)
          expect((await call(file, method, orgA.slug, { ...extra, origin: 'http://localhost', host: 'localhost' })).status).toBe(501);
        };

        if (gate === 'org') {
          clearSession();
          const anon = await call(file, method, orgA.slug);
          expect([anon.status, await anon.json()]).toEqual([401, UNAUTHENTICATED]);

          sessionFor(seat(orgB, 'owner'));
          expect((await call(file, method, orgA.slug)).status).toBe(404);

          const denied = FIXTURE_ROLES.find((r) => !can(r, action as Action));
          if (denied) {
            sessionFor(seat(orgA, denied));
            const res = await call(file, method, orgA.slug);
            expect([res.status, await res.json()]).toEqual([403, { error: 'Forbidden', code: 'forbidden' }]);
          }

          const allowed = FIXTURE_ROLES.find((r) => can(r, action as Action));
          if (!allowed) throw new Error(`no role holds ${action}`);
          sessionFor(seat(orgA, allowed));
          if (write) await crossOrigin();
          await answers501(await call(file, method, orgA.slug));
        } else if (gate === 'identity') {
          clearSession();
          const anon = await call(file, method, orgA.slug);
          expect([anon.status, await anon.json()]).toEqual([401, UNAUTHENTICATED]);
          sessionFor(seat(orgA, 'viewer'));
          await crossOrigin();
          await answers501(await call(file, method, orgA.slug));
        } else if (gate === 'none') {
          clearSession();
          await crossOrigin();
          await answers501(await call(file, method, orgA.slug));
        } else if (gate === 'token') {
          clearSession();
          const noHeader = await call(file, method, orgA.slug);
          expect([noHeader.status, await noHeader.json()]).toEqual([401, UNAUTHENTICATED]);
          await crossOrigin({ authorization: 'Bearer anything' });
          await answers501(await call(file, method, orgA.slug, { authorization: 'Bearer anything' }));
        } else {
          clearSession();
          const anon = await call(file, method, orgA.slug);
          expect([anon.status, await anon.json()]).toEqual([401, UNAUTHENTICATED]);
          sessionFor(seat(orgA, 'owner')); // an organisation owner is not a platform administrator
          const notAdmin = await call(file, method, orgA.slug);
          expect([notAdmin.status, await notAdmin.json()]).toEqual([403, { error: 'Forbidden', code: 'forbidden' }]);
          sessionFor(platformAdminId);
          await crossOrigin();
          await answers501(await call(file, method, orgA.slug));
        }
      });
    }
  }

  it('NFR-SEC-14 FR-OPS-02 (helper): the reminder stub answers 401 without a token header and reads no setting', async () => {
    const file = 'app/api/internal/reminders/route.ts';
    expect(readFileSync(file, 'utf8')).not.toMatch(/process\.env/);
    clearSession();
    const seen: unknown[] = [];
    for (const setting of [undefined, 'a'.repeat(64)]) {
      if (setting === undefined) delete process.env.REMINDER_JOB_TOKEN; else process.env.REMINDER_JOB_TOKEN = setting;
      try {
        for (const headers of [{} as Record<string, string>, { authorization: '' }]) {
          const res = await call(file, 'POST', orgA.slug, headers);
          seen.push([res.status, (await res.json()).code]);
        }
        // a header is all the stub asks for; OPS adds the comparison, so a matching token and a wrong one answer alike
        for (const authorization of [`Bearer ${'a'.repeat(64)}`, `Bearer ${'b'.repeat(64)}`]) {
          const res = await call(file, 'POST', orgA.slug, { authorization });
          seen.push([res.status, (await res.json()).code]);
        }
      } finally {
        delete process.env.REMINDER_JOB_TOKEN;
      }
    }
    expect(seen).toEqual(Array(2).fill([[401, 'unauthenticated'], [401, 'unauthenticated'], [501, 'not_implemented'], [501, 'not_implemented']]).flat());
  });

  it('FR-AUTHZ-02 NFR-MNT-01: a stub is in PENDING_ROUTES exactly when its file throws NotImplementedError, and every listed file exists', () => {
    for (const f of PENDING_ROUTES) expect({ f, throws: readFileSync(f, 'utf8').includes('NotImplementedError(') }).toEqual({ f, throws: true });
    expect(new Set(PENDING_ROUTES).size).toBe(PENDING_ROUTES.length);
  });

  for (const [file, methods] of Object.entries(REMOVED_METHODS)) {
    for (const method of methods) {
      it(`FR-AUTHZ-02: ${method} ${file} is an exported handler that answers 404, whoever asks`, async () => {
        clearSession();
        const anon = await call(file, method, orgA.slug);
        expect([anon.status, await anon.json()]).toEqual([404, { error: 'Not found', code: 'not_found' }]);
        for (const role of FIXTURE_ROLES) {
          sessionFor(seat(orgA, role));
          const res = await call(file, method, orgA.slug);
          expect([role, res.status, await res.json()]).toEqual([role, 404, { error: 'Not found', code: 'not_found' }]);
        }
      });
    }
  }
});
