/** The words of the legal-text screens that only server code shows (plan 1A Task 16b); no client file may import this module. */
export const LEGAL_COPY = Object.freeze({
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
