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
  /** The footer's first site link, to Help's legal section (plan 1A Task 12, R7). */
  footer: Object.freeze({ termsAndPrivacy: 'Terms and privacy' }),
  items: Object.freeze({
    home: 'Home', projects: 'Projects', findings: 'Findings', guidance: 'Guidance', help: 'Help',
    members: 'Members', organisation: 'Organisation details', account: 'My account',
    'admin-organisations': 'Organisations', 'admin-accounts': 'Accounts',
  } satisfies Record<RailItem['key'], string>),
});

/**
 * The words of the gate frame (plan 1B Task 1, ruling L5-1): the frame the signed-in pages outside the shell render in
 * (S-05, S-29, S-07) and, from plan 1B Task 2, the signed-out door pages. The route lists the steps of the door the person is
 * going through; a stop is named only when this person will meet it.
 */
export const GATE_COPY = Object.freeze({
  signOut: SHELL_COPY.signOut,
  help: SHELL_COPY.items.help,
  /** The accessible name of the route's list. */
  routeLabel: 'Your steps',
  /** Above the current stop's name, in the wide column. */
  here: 'You are here',
  /** The narrow band's line for the current stop. */
  where: (stop: string): string => `You are here: ${stop}`,
  /** The narrow band's line for the stop after the current one, when the route lists one (never a count: ruling L5-21). */
  next: (stop: string): string => `Next: ${stop}`,
  stops: Object.freeze({
    changePassword: 'Change your password',
    signInAgain: 'Sign in again',
    signIn: 'Sign in',
    accept: 'Accept the terms',
    chooseOrganisation: 'Choose an organisation',
    home: SHELL_COPY.items.home,
  }),
});
