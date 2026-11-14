import type { OrgRole } from '@prisma/client';
import type { VocabularyEntry } from '@/lib/vocabulary/types';
import { TERM_ADMIN, TERM_ASSESSOR, TERM_OWNER, TERM_REVIEWER, TERM_VIEWER } from '@/lib/vocabulary/terms';

/** The words of the organisation screens. Titles only for now; later tasks add the rest. */
export const ORG_COPY = Object.freeze({
  titles: Object.freeze({
    chooser: 'Choose an organisation',
    projects: 'Projects',
    newProject: 'New project',
    members: 'Members',
    organisation: 'Organisation',
    invitation: 'Invitation',
  }),
});

const ROLE_TERMS: Readonly<Record<OrgRole, VocabularyEntry>> = Object.freeze({
  owner: TERM_OWNER,
  admin: TERM_ADMIN,
  assessor: TERM_ASSESSOR,
  reviewer: TERM_REVIEWER,
  viewer: TERM_VIEWER,
});

/** The vocabulary's entry for a role: a raw role value is never written into a sentence. */
export function roleTerm(role: OrgRole): VocabularyEntry {
  return ROLE_TERMS[role];
}

/**
 * The role as a sentence names it, with its article: "an Owner", "an Admin", "an Assessor", "a Reviewer", "a Viewer".
 * Server code only: no client file may import this module, which reads the vocabulary.
 */
export function roleWithArticle(role: OrgRole): string {
  const term = roleTerm(role).term;
  return `${/^[AEIOU]/.test(term) ? 'an' : 'a'} ${term}`;
}
