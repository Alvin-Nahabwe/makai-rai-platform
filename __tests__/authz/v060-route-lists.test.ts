import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    // MEM changes the PATCH action from member:grant_owner to member:role with the handler; either is right here.
    expect(['member:grant_owner', 'member:role']).toContain(ROUTE_ACTIONS[`${ORG}members/[userId]/route.ts`].PATCH);
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
      [`${ORG}members/leave/route.ts`]: { POST: 'member:leave' },
    };
    for (const [f, actions] of Object.entries(expected)) expect({ f, actions: ROUTE_ACTIONS[f] }).toEqual({ f, actions });
    // members/[userId]: MEM moves PATCH to member:role (rows 25 to 29); DELETE stays member:remove.
    const member = ROUTE_ACTIONS[`${ORG}members/[userId]/route.ts`];
    expect(Object.keys(member).sort()).toEqual(['DELETE', 'PATCH']);
    expect(['member:grant_owner', 'member:role']).toContain(member.PATCH);
    expect(member.DELETE).toBe('member:remove');
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

  const REASONS = ['keyed by MEM or PRJ (owner answer A1)', 'removed by RM', 'writes nothing'];
  const LEGACY_ASSESSMENT_WRITES = [
    `${ORG}assessments/[id]/complete/route.ts`, `${ORG}assessments/[id]/evidence/route.ts`, `${ORG}assessments/[id]/remediation/route.ts`,
    `${ORG}assessments/[id]/route.ts`, `${ORG}assessments/route.ts`,
  ];

  it('NFR-INT-02 (owner answer A1): every reason is one of the contract\'s three strings, and each belongs to its own routes', () => {
    // A subset, not the full set: PRJ and MEM remove the A1 reason when the last of rows 21 to 29 is keyed, and RM removes
    // 'removed by RM' with the assessment routes.
    for (const [f, v] of Object.entries(UNKEYED_WRITES)) expect({ f, reasonIsKnown: REASONS.includes(v.reason) }).toEqual({ f, reasonIsKnown: true });
    const where = (reason: string) => Object.entries(UNKEYED_WRITES).filter(([, v]) => v.reason === reason).map(([f]) => f).sort();
    expect(where('writes nothing')).toEqual([`${P}reviews/[reviewId]/documents/preview/route.ts`]);
    expect(where('removed by RM').every((f) => /\/assessments\//.test(f))).toBe(true);
  });

  it('NFR-INT-02: the five legacy assessment writes are listed as "removed by RM" while their routes exist, and none is once RM has deleted them', () => {
    const where = Object.entries(UNKEYED_WRITES).filter(([, v]) => v.reason === 'removed by RM').map(([f]) => f).sort();
    expect(where).toEqual(existsSync(`app/api/v1/orgs/[slug]/assessments/route.ts`) ? [...LEGACY_ASSESSMENT_WRITES].sort() : []);
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

  it('NFR-INT-02 (owner answer A1): each method of rows 21 to 29 is unkeyed with the A1 reason or retry-keyed, never both, and the A1 reason is on no other row', () => {
    // PRJ (rows 21 to 24) and MEM (rows 25 to 29) move a method from the first to the second with its handler.
    for (const [f, methods] of Object.entries(ROWS_21_TO_29)) {
      for (const m of methods) {
        const unkeyed = (UNKEYED_WRITES[f]?.methods ?? []).includes(m as 'POST');
        const keyed = (RETRY_KEYED_WRITES[f] ?? []).includes(m as 'POST');
        expect({ f, m, exactlyOne: unkeyed !== keyed }).toEqual({ f, m, exactlyOne: true });
        if (unkeyed) expect({ f, m, reason: UNKEYED_WRITES[f].reason }).toEqual({ f, m, reason: 'keyed by MEM or PRJ (owner answer A1)' });
      }
    }
    const withReason = Object.entries(UNKEYED_WRITES).filter(([, v]) => v.reason === 'keyed by MEM or PRJ (owner answer A1)').map(([f]) => f);
    for (const f of withReason) expect({ f, isRow21To29: f in ROWS_21_TO_29 }).toEqual({ f, isRow21To29: true });
  });

  it('NFR-INT-02: RETRY_KEYED_WRITES holds rows 1 to 3, 5 to 13, 16 and 19 with every non-GET method of each, and besides them only rows 21 to 29', () => {
    const rows = [
      `${P}decisions/route.ts`, `${P}questions/[questionId]/withdrawal/route.ts`, `${P}evidence/route.ts`, `${P}findings/route.ts`,
      `${P}findings/[findingId]/mitigations/route.ts`, `${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`,
      `${P}findings/[findingId]/accepted-risks/route.ts`, `${P}findings/[findingId]/reopen/route.ts`,
      `${P}findings/[findingId]/withdrawal/route.ts`, `${P}findings/[findingId]/close-by-decision/route.ts`,
      `${P}reviews/route.ts`, `${P}reviews/[reviewId]/seals/route.ts`, `${P}reviews/[reviewId]/documents/route.ts`,
      `${ORG}documents/[documentId]/withdrawal/route.ts`,
    ];
    for (const f of rows) expect({ f, methods: [...(RETRY_KEYED_WRITES[f] ?? [])] }).toEqual({ f, methods: Object.keys(ROUTE_ACTIONS[f]).filter((m) => m !== 'GET') });
    for (const f of Object.keys(RETRY_KEYED_WRITES)) expect({ f, allowed: rows.includes(f) || f in ROWS_21_TO_29 }).toEqual({ f, allowed: true });
    for (const [f, ms] of Object.entries(RETRY_KEYED_WRITES)) {
      if (f in ROWS_21_TO_29) for (const m of ms) expect({ f, m, inRow: ROWS_21_TO_29[f].includes(m) }).toEqual({ f, m, inRow: true });
    }
  });

  it('NFR-MNT-01: a route is in PENDING_ROUTES exactly when its file still throws NotImplementedError', () => {
    for (const f of routeFilesOnDisk()) {
      expect({ f, pending: PENDING_ROUTES.includes(f) }).toEqual({ f, pending: readFileSync(f, 'utf8').includes('NotImplementedError(') });
    }
  });

  it('FR-AUTHZ-02 NFR-MNT-01: a removed method is still an exported handler, because Next answers 405 for a method a route does not export', async () => {
    for (const [f, methods] of Object.entries(REMOVED_METHODS)) {
      for (const m of methods) expect({ f, m, exported: (await exportedMethods(f)).includes(m) }).toEqual({ f, m, exported: true });
    }
  });

  it('NFR-MNT-01: every route listed in PENDING_ROUTES exists on disk', () => {
    const onDisk = new Set(routeFilesOnDisk());
    for (const f of PENDING_ROUTES) expect({ f, exists: onDisk.has(f) }).toEqual({ f, exists: true });
  });

  it('NFR-MNT-01: no route is listed twice, and PENDING_ROUTES names only declared routes', () => {
    expect(new Set(PENDING_ROUTES).size).toBe(PENDING_ROUTES.length);
    for (const f of PENDING_ROUTES) expect({ f, declared: f in ROUTE_ACTIONS || NON_ACTION_ROUTES.includes(f) }).toEqual({ f, declared: true });
  });
});
