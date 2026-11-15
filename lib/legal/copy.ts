import type { AcceptedKind } from '@/types/legal';

/** The words of the legal-text screens that only server code shows (plan 1A Task 16b); no client file may import this module. */
export const LEGAL_COPY = Object.freeze({
  /** S-05 when a text the person accepted before has a newer version (plan 1B Task 7; spec 9.8). */
  changes: Object.freeze({
    heading: 'The terms have changed',
    /** "Terms of service: version 1 is now version 2"; `name` is LEGAL_KIND_NAMES' lower-case name. */
    title: (name: string, from: string, to: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}: version ${from} is now version ${to}`,
    whatChanged: 'What changed',
    readFull: (name: string): string => `Read the full ${name}`,
  }),
  titles: Object.freeze({
    acceptances: 'Read and accept',
    /** One version of a text: its heading (`legalTextHeading`), then the version. */
    version: (heading: string, version: string): string => `${heading}, version ${version}`,
  }),
  /** Route 30's answer for a body with no kind (audit A 263). */
  route: Object.freeze({
    tickOne: 'Tick at least one box.',
  }),
});

/** The two legal text pages (S-06) and the text view. */
export const LEGAL_PAGE_COPY = Object.freeze({
  /** "Version 2, published 1 Dec 2026" (7.5.8 dates), the line under the heading and the link text of a past version. */
  versionLine: (version: string, date: string): string => `Version ${version}, published ${date}`,
  /** The label of the fingerprint: "File ", the vocabulary's term "fingerprint", then this (audit A 111). */
  fingerprintBefore: 'File ',
  fingerprintAfter: ', for checking that this text has not changed',
  /** The words of the link to this version (audit A 113), and the sentence that follows the link in the same paragraph. */
  linkToVersion: (version: string): string => `Link to version ${version}`,
  textWillNotChange: 'This text will not change.',
  pastVersions: 'Past versions',
  allVersions: (name: string): string => `All versions of the ${name}`,
  earlierVersion: (currentVersion: string, publishedOn: string): string =>
    `This is an earlier version. The current one is version ${currentVersion}, published ${publishedOn}.`,
});

/** "What I have accepted" on My account. */
export const MY_ACCEPTANCES_COPY = Object.freeze({
  heading: 'What I have accepted',
  empty: 'You have not accepted any legal texts yet.',
  accepted: (name: string, version: string, date: string): string => `${name}, version ${version}. Accepted on ${date}.`,
  /** After a row that no longer counts as an acceptance (audit A 104). */
  olderVersion: 'This was an older version. Accept the current version.',
  newerAvailable: (version: string): string => `Version ${version} is now available.`,
  read: 'Read',
  readAndAccept: 'Read and accept',
});

/**
 * What changed in each published version after version 1 of an accepted kind, by version (plan 1B Task 7, ruling L5-16): the
 * owner-approved summaries (O7, 15 Nov 2026), copied exactly from records/plans/2026-11-11-ux-redesign/legal-v2/
 * change-summaries.md, one paragraph per text. Plain summaries, not quoted legal text, so they are not wrapped in
 * `verbatim` and the vocabulary lint reads them. Never reworded here: __tests__/unit/legal-change-summaries.test.ts pins
 * the object's sha256. Server code only, like the rest of this module: S-04's bundle never carries them.
 */
export const LEGAL_CHANGE_SUMMARIES: Readonly<Record<AcceptedKind, Readonly<Record<string, string>>>> = Object.freeze({
  terms: Object.freeze({
    '2': "The terms now say who provides the platform, how to contact us, and that the law of Uganda applies. They say that the platform records your team's decisions and does not approve or vouch for any AI system. They explain what it means to use the platform for your institution, what each team role can do, and what MAK-AI promises when it handles your team's records. They also say how an account or an organisation's records can be deleted, and how the terms will change in future.",
  }),
  privacy: Object.freeze({
    '2': "The earlier notice said you could not download your data or delete your account. You now can, on the My account page, and the notice explains what stays after deletion and why. It now says who is responsible for your data. It names every company that stores or carries your data, including the one that runs the server, and the country each is in. It also says how long each kind of data is kept, and how to use each of your rights. Finally, it describes the cookies and browser storage the platform uses, and how to complain.",
  }),
  'cross-border-consent': Object.freeze({
    '2': "The earlier version of this text held no real content. It now says plainly that your data is stored in Finland, and that Cloudflare, around the world, and Resend, in the United States, carry or handle it. It states the main risk of storing your data outside your country, and that you can withdraw your consent by deleting your account.",
  }),
});
