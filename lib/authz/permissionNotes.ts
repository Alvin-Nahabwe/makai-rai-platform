import type { OrgRole } from '@prisma/client';
import { can } from './policy';

/**
 * UX-14 (SRS lines 2319-2320): the one line S-12 shows in place of the answer form to a role that records no
 * decision. Null when the role may record one, and null in an archived project, whose line is ArchivedBanner's
 * (SRS line 2368). DEC-b's DecisionForm renders it. Advice only: the server refuses the save by `can()`.
 */
export function decisionFormNote(role: OrgRole, projectArchived: boolean): string | null {
  if (projectArchived || can(role, 'decision:write')) return null;
  return 'Only owners, admins and assessors record decisions.';
}
