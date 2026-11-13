import { TERM_ADMIN, TERM_ASSESSOR, TERM_OWNER, TERM_REVIEWER, TERM_VIEWER } from '@/lib/vocabulary/terms';

/** The words of the shell (plan 1A Task 11): the rail, the top bar, the switcher, the theme switch and the public header. */
export const SHELL_COPY = Object.freeze({
  nav: 'Main',
  publicNav: 'Site',
  menu: 'Menu',
  skip: 'Skip to content',
  signOut: 'Sign out',
  switchOrganisation: 'Switch organisation',
  theme: Object.freeze({ toDark: 'Switch to dark theme', toLight: 'Switch to light theme' }),
  public: Object.freeze({ about: 'About', signIn: 'Sign in' }),
  items: Object.freeze({
    home: 'Home', projects: 'Projects', findings: 'Findings', guidance: 'Guidance', help: 'Help',
    members: 'Members', organisation: 'Organisation details', account: 'My account',
    'admin-organisations': 'Organisations', 'admin-accounts': 'Accounts',
  }),
});

/** The organisation roles as orgRoleLabel returns them (lower case), and the word the shell shows for each. */
const ROLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  owner: TERM_OWNER.term,
  admin: TERM_ADMIN.term,
  assessor: TERM_ASSESSOR.term,
  reviewer: TERM_REVIEWER.term,
  viewer: TERM_VIEWER.term,
});

/**
 * The role word shown under the person's name (CONSOLIDATED section 2: capitalised, "Viewer"). Any label that is not one of
 * the five roles is shown as it is, never hidden; it is looked up as an own property, so a label such as "toString" is
 * not mistaken for one.
 */
export function roleWord(label: string): string {
  return Object.hasOwn(ROLE_WORDS, label) ? ROLE_WORDS[label] : label;
}
