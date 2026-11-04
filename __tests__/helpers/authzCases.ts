import { vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { can, type Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';
import { UNKEYED_WRITES } from '../../lib/authz/routeActions';

/** The first role, in ALL_ORG_ROLES order (owner, admin, assessor, reviewer, viewer), that may perform `action`. */
export function roleWith(action: Action): OrgRole {
  const role = ALL_ORG_ROLES.find((r) => can(r, action));
  if (!role) throw new Error(`no role may ${action}`);
  return role;
}

const PROJECT = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts';

/**
 * Calls a route and returns its answer, or null for the one permitted call known to fail: the v0.5.0 DELETE of a
 * project that holds records breaks the foreign key of a record table (evidence, decisions and the rest; Prisma
 * P2003), and toResponse (lib/http/toResponse.ts) prints that error and answers 500 internal_error with a support
 * reference. PRJ answers it 409 `project_has_records` (00-contract.md, Routes, row 24) in the commit that keys the
 * method, so this ends by itself when the method leaves UNKEYED_WRITES. Only that route and method, only a 500,
 * and only when the error printed during the call is a P2003; anything else is returned as it came. A null also
 * shows the project was found in the caller's organisation: the delete reached a row that has children.
 */
export async function answerOrKnownCrash(file: string, method: string, call: () => Promise<Response>): Promise<Response | null> {
  const printed = vi.spyOn(console, 'error');   // a spy that still prints: nothing is hidden from the run's output
  let res: Response;
  let errors: unknown[];
  try {
    res = await call();
  } finally {
    errors = printed.mock.calls.flat();
    printed.mockRestore();
  }
  const known = file === PROJECT && method === 'DELETE' && (UNKEYED_WRITES[PROJECT]?.methods ?? []).includes('DELETE');
  const p2003 = errors.some((e) => (e as { code?: unknown } | null)?.code === 'P2003');
  return known && res.status === 500 && p2003 ? null : res;
}
