import type { OrgRole } from '@prisma/client';
import { can } from './policy';
import { AUTHZ_COPY } from './copy';

/**
 * UX-14 (SRS lines 2319-2320): the one line S-12 shows in place of the answer form to a role that records no
 * decision, saying what that role can do instead (audit D row OR87): a role that may raise a finding (Reviewer) is told
 * so, any other (Viewer) that it can read them. Null when the role may record one, and null in an archived project,
 * whose line is ArchivedBanner's (SRS line 2368). DEC-b's DecisionForm renders it. Advice only: the server refuses the
 * save by `can()`.
 */
export function decisionFormNote(role: OrgRole, projectArchived: boolean): string | null {
  if (projectArchived || can(role, 'decision:write')) return null;
  return can(role, 'finding:raise') ? AUTHZ_COPY.decisionFormNote.reviewer : AUTHZ_COPY.decisionFormNote.viewer;
}
