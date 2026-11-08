import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';

/** The roles in the order M-26 names them (FR-AUTHZ-01's matrix order, SRS lines 629-646). */
const ROLE_ORDER: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
const PLURAL: Readonly<Record<OrgRole, string>> = { owner: 'owners', admin: 'admins', assessor: 'assessors', reviewer: 'reviewers', viewer: 'viewers' };
const ACTION_TEXT = {
  'risk:accept': 'accept a risk',
  'mitigation:write': 'add or update a mitigation',
  'finding:reopen': 'reopen a finding',
} as const;

/** "A", "A and B", "A, B and C". */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * M-26 (SRS line 2573): "Only <roles> can <action>." The roles are read from `can` (lib/authz/policy.ts), so a
 * change to the grants changes the text with it (gap G060). FND-b shows it where a form is absent (UX-17).
 */
export function onlyRolesCanText(action: keyof typeof ACTION_TEXT): string {
  const roles = ROLE_ORDER.filter((r) => can(r, action)).map((r) => PLURAL[r]);
  // A grant table that gives the action to nobody is a policy defect, not a sentence to print.
  if (roles.length === 0) throw new Error(`onlyRolesCanText: no role holds ${action}`);
  return `Only ${joinAnd(roles)} can ${ACTION_TEXT[action]}.`;
}
