import type { RailItem } from '@/lib/shell/types';

/**
 * The words of the shell (plan 1A Task 11): the rail, the top bar, the switcher, the theme switch and the public header.
 * Client components import this module, and the bundler ships it whole to every page whose client code does (ruling X-2),
 * so it holds only the words those components show: the role words are lib/shell/data.ts's, on the server.
 */
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
  } satisfies Record<RailItem['key'], string>),
});
