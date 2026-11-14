/**
 * The line a Reviewer or Viewer reads on the question page in place of the decision form (audit D row OR87, role names
 * capitalised; the coordinator's ruling OR87). Its importer is lib/authz/permissionNotes.ts. Ruling X-2: DecisionForm, a
 * client component, renders the line, so this module holds these two sentences and nothing else.
 */
export const AUTHZ_COPY = Object.freeze({
  decisionFormNote: Object.freeze({
    reviewer: 'Only Owners, Admins and Assessors can record decisions. You can read them and raise a finding.',
    viewer: 'Only Owners, Admins and Assessors can record decisions. You can read them.',
  }),
});
