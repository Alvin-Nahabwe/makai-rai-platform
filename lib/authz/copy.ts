/**
 * The line a Reviewer or Viewer reads on the question page in place of the decision form (audit D row OR87, role names
 * capitalised; the coordinator's ruling OR87). Its importer is lib/authz/permissionNotes.ts. Ruling X-2: DecisionForm, a
 * client component, renders the line, so this module holds these two sentences and nothing else.
 */
export const AUTHZ_COPY = Object.freeze({
  decisionFormNote: Object.freeze({
    reviewer: 'You can read this record and raise a finding. Owners, Admins and Assessors can change it.',
    viewer: 'You can read this record. Owners, Admins and Assessors can change it.',
  }),
});
