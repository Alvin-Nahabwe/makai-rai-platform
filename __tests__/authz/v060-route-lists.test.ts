import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROUTE_ACTIONS, NON_ACTION_ROUTES, PENDING_ROUTES, REMOVED_METHODS, RETRY_KEYED_WRITES, UNKEYED_WRITES,
} from '@/lib/authz/routeActions';

const ORG = 'app/api/v1/orgs/[slug]/';
const P = `${ORG}projects/[id]/`;

/** Rows 1 to 22 and 28 to 29 of the contract's org-scoped route table, and rows 30, 33, 34, 37 and 40 to 46 of the other. */
const CONTRACT_ROUTE_FILES = [
  `${P}decisions/route.ts`,
  `${P}questions/[questionId]/withdrawal/route.ts`,
  `${P}evidence/route.ts`,
  `${ORG}evidence/[evidenceId]/route.ts`,
  `${P}findings/route.ts`,
  `${P}findings/[findingId]/mitigations/route.ts`,
  `${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`,
  `${P}findings/[findingId]/accepted-risks/route.ts`,
  `${P}findings/[findingId]/reopen/route.ts`,
  `${P}findings/[findingId]/withdrawal/route.ts`,
  `${P}findings/[findingId]/close-by-decision/route.ts`,
  `${P}reviews/route.ts`,
  `${P}reviews/[reviewId]/seals/route.ts`,
  `${P}reviews/[reviewId]/seals/[sealId]/check/route.ts`,
  `${P}reviews/[reviewId]/documents/preview/route.ts`,
  `${P}reviews/[reviewId]/documents/route.ts`,
  `${ORG}documents/[documentId]/pdf/route.ts`,
  `${ORG}documents/[documentId]/text/route.ts`,
  `${ORG}documents/[documentId]/withdrawal/route.ts`,
  `${ORG}export/route.ts`,
  `${P}archive/route.ts`,
  `${P}unarchive/route.ts`,
  `${ORG}invitations/[invitationId]/resend/route.ts`,
  `${ORG}invitations/[invitationId]/revoke/route.ts`,
  'app/api/acceptances/route.ts',
  'app/api/password-reset/route.ts',
  'app/api/password-reset/complete/route.ts',
  'app/api/users/me/preferences/route.ts',
  'app/api/internal/reminders/route.ts',
  'app/api/admin/organisations/route.ts',
  'app/api/admin/organisations/[orgId]/route.ts',
  'app/api/admin/organisations/[orgId]/agreements/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts',
];

/** Every method Next serves from a route file; K0b's lists name four of them. */
const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

function routeFilesOnDisk(dir = 'app/api'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFilesOnDisk(p);
    return name === 'route.ts' ? [p] : [];
  });
}

async function exportedMethods(file: string): Promise<string[]> {
  const mod = (await import(/* @vite-ignore */ '@/' + file.replace(/\.ts$/, ''))) as Record<string, unknown>;
  return HTTP_METHODS.filter((m) => typeof mod[m] === 'function');
}

describe('route lists', () => {
  it('NFR-MNT-01 FR-AUTHZ-02: every route of the contract is declared, and every exported method is accounted for', async () => {
    for (const f of CONTRACT_ROUTE_FILES) expect({ f, declared: f in ROUTE_ACTIONS || NON_ACTION_ROUTES.includes(f) }).toEqual({ f, declared: true });
    expect(ROUTE_ACTIONS[`${P}decisions/route.ts`]).toEqual({ POST: 'decision:write' });
    expect(ROUTE_ACTIONS[`${ORG}evidence/[evidenceId]/route.ts`]).toEqual({ GET: 'record:read' });
    expect(REMOVED_METHODS).toEqual({ [`${ORG}evidence/[evidenceId]/route.ts`]: ['DELETE'] });
    expect(ROUTE_ACTIONS[`${ORG}members/[userId]/route.ts`].PATCH).toBe('member:grant_owner'); // MEM changes it to member:role with the handler
    for (const f of routeFilesOnDisk()) {
      if (NON_ACTION_ROUTES.includes(f)) continue;
      for (const m of await exportedMethods(f)) {
        expect({ f, m, declared: m in (ROUTE_ACTIONS[f] ?? {}) || ((REMOVED_METHODS[f] ?? []) as readonly string[]).includes(m) }).toEqual({ f, m, declared: true });
      }
    }
  });

  it('FR-AUTHZ-01 NFR-MNT-01: each row of the contract declares the action its row names', () => {
    const expected: Record<string, Record<string, string>> = {
      [`${P}questions/[questionId]/withdrawal/route.ts`]: { POST: 'decision:withdraw' },
      [`${P}evidence/route.ts`]: { POST: 'evidence:create' },
      [`${P}findings/route.ts`]: { POST: 'finding:raise' },
      [`${P}findings/[findingId]/mitigations/route.ts`]: { POST: 'mitigation:write' },
      [`${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`]: { POST: 'mitigation:write' },
      [`${P}findings/[findingId]/accepted-risks/route.ts`]: { POST: 'risk:accept' },
      [`${P}findings/[findingId]/reopen/route.ts`]: { POST: 'finding:reopen' },
      [`${P}findings/[findingId]/withdrawal/route.ts`]: { POST: 'finding:withdraw' },
      [`${P}findings/[findingId]/close-by-decision/route.ts`]: { POST: 'mitigation:write' },
      [`${P}reviews/route.ts`]: { POST: 'review:open' },
      [`${P}reviews/[reviewId]/seals/route.ts`]: { POST: 'review:seal' },
      [`${P}reviews/[reviewId]/seals/[sealId]/check/route.ts`]: { GET: 'record:read' },
      [`${P}reviews/[reviewId]/documents/preview/route.ts`]: { POST: 'document:generate' },
      [`${P}reviews/[reviewId]/documents/route.ts`]: { POST: 'document:generate' },
      [`${ORG}documents/[documentId]/pdf/route.ts`]: { GET: 'record:read' },
      [`${ORG}documents/[documentId]/text/route.ts`]: { GET: 'record:read' },
      [`${ORG}documents/[documentId]/withdrawal/route.ts`]: { POST: 'document:withdraw' },
      [`${ORG}export/route.ts`]: { GET: 'team:export' },
      [`${P}archive/route.ts`]: { POST: 'project:archive' },
      [`${P}unarchive/route.ts`]: { POST: 'project:archive' },
      [`${ORG}invitations/[invitationId]/resend/route.ts`]: { POST: 'member:invite' },
      [`${ORG}invitations/[invitationId]/revoke/route.ts`]: { POST: 'member:invite' },
      // rows 23 to 27 exist and keep their actions
      [`${ORG}projects/route.ts`]: { GET: 'project:read', POST: 'project:create' },
      [`${P}route.ts`]: { GET: 'project:read', PATCH: 'project:update', DELETE: 'project:delete' },
      [`${ORG}members/route.ts`]: { GET: 'member:read', POST: 'member:invite' },
      [`${ORG}members/[userId]/route.ts`]: { PATCH: 'member:grant_owner', DELETE: 'member:remove' },
      [`${ORG}members/leave/route.ts`]: { POST: 'member:leave' },
    };
    for (const [f, actions] of Object.entries(expected)) expect({ f, actions: ROUTE_ACTIONS[f] }).toEqual({ f, actions });
  });

  it('NFR-MNT-01 FR-AUTHZ-02: the routes that gate on identity, a token or the platform role are in NON_ACTION_ROUTES, not in ROUTE_ACTIONS', () => {
    for (const f of CONTRACT_ROUTE_FILES.filter((x) => !x.startsWith(ORG))) {
      expect({ f, nonAction: NON_ACTION_ROUTES.includes(f), action: f in ROUTE_ACTIONS }).toEqual({ f, nonAction: true, action: false });
    }
    expect(new Set(NON_ACTION_ROUTES).size).toBe(NON_ACTION_ROUTES.length);
    for (const f of NON_ACTION_ROUTES) expect({ f, action: f in ROUTE_ACTIONS }).toEqual({ f, action: false });
  });

  it('NFR-INT-02: every non-GET method of ROUTE_ACTIONS is in exactly one of RETRY_KEYED_WRITES and UNKEYED_WRITES, and neither names a method ROUTE_ACTIONS lacks', () => {
    for (const [f, methods] of Object.entries(ROUTE_ACTIONS)) {
      for (const m of Object.keys(methods).filter((x) => x !== 'GET')) {
        const keyed = (RETRY_KEYED_WRITES[f] ?? []).includes(m as 'POST');
        const unkeyed = (UNKEYED_WRITES[f]?.methods ?? []).includes(m as 'POST');
        expect({ f, m, exactlyOne: keyed !== unkeyed }).toEqual({ f, m, exactlyOne: true });
      }
    }
    const listed: Array<[string, string]> = [
      ...Object.entries(RETRY_KEYED_WRITES).flatMap(([f, ms]) => ms.map((m) => [f, m] as [string, string])),
      ...Object.entries(UNKEYED_WRITES).flatMap(([f, v]) => v.methods.map((m) => [f, m] as [string, string])),
    ];
    for (const [f, m] of listed) {
      expect({ f, m, inRouteActions: m !== 'GET' && m in (ROUTE_ACTIONS[f] ?? {}) }).toEqual({ f, m, inRouteActions: true });
    }
  });

  it('NFR-INT-02 (owner answer A1): the reasons are exactly the contract\'s three strings, and each belongs to its own routes', () => {
    const reasons = new Set(Object.values(UNKEYED_WRITES).map((v) => v.reason));
    expect([...reasons].sort()).toEqual(['keyed by MEM or PRJ (owner answer A1)', 'removed by RM', 'writes nothing']);
    const where = (reason: string) => Object.entries(UNKEYED_WRITES).filter(([, v]) => v.reason === reason).map(([f]) => f).sort();
    expect(where('writes nothing')).toEqual([`${P}reviews/[reviewId]/documents/preview/route.ts`]);
    expect(where('removed by RM').every((f) => /\/assessments\//.test(f))).toBe(true);
    expect(where('removed by RM')).toEqual([
      `${ORG}assessments/[id]/complete/route.ts`, `${ORG}assessments/[id]/evidence/route.ts`, `${ORG}assessments/[id]/remediation/route.ts`,
      `${ORG}assessments/[id]/route.ts`, `${ORG}assessments/route.ts`,
    ]);
  });

  /** Contract Routes rows 21 to 29: every non-GET method (owner answer A1; SRS line 3080). PRJ (21 to 24) and MEM (25 to 29) move each to RETRY_KEYED_WRITES with the handler. */
  const ROWS_21_TO_29: Record<string, string[]> = {
    [`${P}archive/route.ts`]: ['POST'],
    [`${P}unarchive/route.ts`]: ['POST'],
    [`${ORG}projects/route.ts`]: ['POST'],
    [`${P}route.ts`]: ['DELETE', 'PATCH'],
    [`${ORG}members/route.ts`]: ['POST'],
    [`${ORG}members/[userId]/route.ts`]: ['DELETE', 'PATCH'],
    [`${ORG}members/leave/route.ts`]: ['POST'],
    [`${ORG}invitations/[invitationId]/resend/route.ts`]: ['POST'],
    [`${ORG}invitations/[invitationId]/revoke/route.ts`]: ['POST'],
  };

  it('NFR-INT-02 (owner answer A1): rows 21 to 29 stay in UNKEYED_WRITES until MEM or PRJ keys them, and no other file has that reason', () => {
    for (const [f, methods] of Object.entries(ROWS_21_TO_29)) {
      expect({ f, unkeyed: [...(UNKEYED_WRITES[f]?.methods ?? [])].sort(), reason: UNKEYED_WRITES[f]?.reason, retryKeyed: RETRY_KEYED_WRITES[f] })
        .toEqual({ f, unkeyed: methods, reason: 'keyed by MEM or PRJ (owner answer A1)', retryKeyed: undefined });
    }
    const withReason = Object.entries(UNKEYED_WRITES).filter(([, v]) => v.reason === 'keyed by MEM or PRJ (owner answer A1)').map(([f]) => f).sort();
    expect(withReason).toEqual(Object.keys(ROWS_21_TO_29).sort());
  });

  it('NFR-INT-02: RETRY_KEYED_WRITES holds exactly rows 1 to 3, 5 to 13, 16 and 19, every non-GET method of each', () => {
    const rows = [
      `${P}decisions/route.ts`, `${P}questions/[questionId]/withdrawal/route.ts`, `${P}evidence/route.ts`, `${P}findings/route.ts`,
      `${P}findings/[findingId]/mitigations/route.ts`, `${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`,
      `${P}findings/[findingId]/accepted-risks/route.ts`, `${P}findings/[findingId]/reopen/route.ts`,
      `${P}findings/[findingId]/withdrawal/route.ts`, `${P}findings/[findingId]/close-by-decision/route.ts`,
      `${P}reviews/route.ts`, `${P}reviews/[reviewId]/seals/route.ts`, `${P}reviews/[reviewId]/documents/route.ts`,
      `${ORG}documents/[documentId]/withdrawal/route.ts`,
    ].sort();
    expect(Object.keys(RETRY_KEYED_WRITES).sort()).toEqual(rows);
    for (const f of rows) expect({ f, methods: [...RETRY_KEYED_WRITES[f]] }).toEqual({ f, methods: Object.keys(ROUTE_ACTIONS[f]).filter((m) => m !== 'GET') });
  });

  it('NFR-MNT-01: a route is in PENDING_ROUTES exactly when its file still throws NotImplementedError', () => {
    for (const f of routeFilesOnDisk()) {
      expect({ f, pending: PENDING_ROUTES.includes(f) }).toEqual({ f, pending: readFileSync(f, 'utf8').includes('NotImplementedError(') });
    }
  });

  it('NFR-MNT-01: no route is listed twice, and PENDING_ROUTES names only declared routes', () => {
    expect(new Set(PENDING_ROUTES).size).toBe(PENDING_ROUTES.length);
    for (const f of PENDING_ROUTES) expect({ f, declared: f in ROUTE_ACTIONS || NON_ACTION_ROUTES.includes(f) }).toEqual({ f, declared: true });
  });
});
