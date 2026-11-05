import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';

/** What a member may do on S-10 for one project, by role and archived state (FR-PRJ-03, UX-29, UX-31). */
export type ProjectActions = { update: boolean; archive: boolean; archiveControl: boolean; export: boolean; openReview: boolean };

/**
 * `archiveControl` is the role alone: the control stays mounted after an archive, so its status line survives the
 * refresh that follows; the control itself hides its button once the project is archived. Everything else is off for an
 * archived project, which is read-only.
 */
export function projectActions(role: OrgRole, archived: boolean): ProjectActions {
  return {
    update: can(role, 'project:update') && !archived,
    archive: can(role, 'project:archive') && !archived,
    archiveControl: can(role, 'project:archive'),
    export: can(role, 'team:export'),
    openReview: can(role, 'review:open') && !archived,
  };
}
