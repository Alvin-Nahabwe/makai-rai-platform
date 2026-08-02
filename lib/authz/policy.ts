import type { OrgRole } from '@prisma/client';

/** Role order is load-bearing: the test matrix indexes into it. */
export const ROLES = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const;

export const ACTIONS = [
  'org:read', 'org:update', 'org:delete',
  'member:list', 'member:invite', 'member:remove', 'member:grant_owner',
  'project:create', 'project:read', 'project:update', 'project:delete',
  'assessment:create', 'assessment:read', 'assessment:respond',
  'assessment:complete', 'assessment:delete',
  'remediation:update',
] as const;

export type Action = (typeof ACTIONS)[number];

const READ_ALL: Action[] = ['org:read', 'member:list', 'project:read', 'assessment:read'];
const WRITE: Action[] = ['project:create', 'project:update', 'assessment:create',
  'assessment:respond', 'assessment:complete', 'remediation:update'];
const MANAGE: Action[] = ['org:update', 'member:invite', 'member:remove',
  'project:delete', 'assessment:delete'];
const OWNER_ONLY: Action[] = ['org:delete', 'member:grant_owner'];

const GRANTS: Record<OrgRole, Action[]> = {
  owner:    [...READ_ALL, ...WRITE, ...MANAGE, ...OWNER_ONLY],
  admin:    [...READ_ALL, ...WRITE, ...MANAGE],
  assessor: [...READ_ALL, ...WRITE],
  reviewer: [...READ_ALL],   // inert until the review spec lands (register D-004)
  viewer:   [...READ_ALL],
};

/** Pure: no I/O. RLS does isolation; this does authorization. (ADR-0001) */
export function can(role: OrgRole, action: Action): boolean {
  return GRANTS[role].includes(action);
}
