/**
 * The outcome lines of a decision save and of a withdrawal (SRS 7.5.7 M-01 to M-12 as reworded by copy audit B rows 400 to
 * 423, CONSOLIDATED section 8 rows 1, 2 and 7, voice rule 3), and the line for evidence a restored draft holds. They show on
 * the question page, the stage page and the history page, through lib/question/saveOutcome.ts and lib/question/draft.ts,
 * which keep their exported names and read this module (ruling X-2: a client file imports a module of its own screens'
 * words). "Your text" is what the person typed; "your decision" the record (the owner's decision D2).
 */
export const DECISION_OUTCOME_COPY = Object.freeze({
  save: Object.freeze({
    saving: 'Saving...',
    slow: 'Still saving. The connection is slow. A copy of your text is kept in this browser.',
    connection: 'Not saved. The connection was lost. Your text is still here. Select Retry.',
    // True: a repeated request id is answered with the version it saved, never saved again (lib/data/decisions.ts idempotentWrite).
    noReply: 'Not saved yet. We did not get a reply in time, so your decision may already be saved. Select Retry. It will not save twice.',
    server: 'Not saved. Something went wrong on our side. Your text is still here. Select Retry.',
    signedOut: 'Not saved. You have been signed out. Your text is kept in this browser. Sign in again to save it.',
    forbidden: 'Not saved. Your role no longer allows this. Ask an Owner or Admin to change your role.',
    archived: 'Not saved. This project is archived. Owners and Admins can unarchive it.',
  }),
  /** M-04: the request id was seen before, and the version it made is replayed. */
  alreadySaved: (time: string, versionNumber: number): string => `This was already saved at ${time} (version ${versionNumber}).`,
  gate: Object.freeze({
    terms: 'Not saved. Accept the updated terms first. Copy your text before you go: this browser cannot keep it.',
    password: 'Not saved. Change your password first. Copy your text before you go: this browser cannot keep it.',
    termsLink: 'Go to the terms',
    passwordLink: 'Change password',
  }),
  /** M-10: someone, or this same account, saved a newer version after the person started. */
  conflict: Object.freeze({
    other: (name: string, time: string): string => `${name} saved a newer version at ${time}. Compare it with your version, then choose what to keep.`,
    own: (time: string): string => `You saved a newer version at ${time}. Compare it with your version, then choose what to keep.`,
  }),
  withdraw: Object.freeze({
    withdrawing: 'Withdrawing...',
    withdrawn: 'Withdrawn. The question has no current decision.',
    // True: route 2 replays a repeated request id (lib/data/decisions.ts idempotentWrite), so Retry cannot withdraw twice.
    maybeArrived: 'Not withdrawn yet. We did not get a reply in time, so it may already be withdrawn. Select Retry. It will not withdraw twice.',
    moved: 'Not withdrawn. Someone saved a newer version. Reload the page to see it.',
    forbidden: 'Not withdrawn. Your role no longer allows this. Ask an Owner or Admin.',
    archived: 'Not withdrawn. This project is archived. Owners and Admins can unarchive it.',
    signedOut: 'Not withdrawn. You have been signed out. Sign in again to withdraw it.',
    server: 'Not withdrawn. Something went wrong on our side. Select Retry.',
  }),
  /** Evidence a restored draft holds that the evidence block cannot name: kept, and attached when the person saves. */
  keptEvidence: (n: number): string => (n === 1
    ? '1 file or link you added earlier is still part of this decision. It will be attached when you save.'
    : `${n} files or links you added earlier are still part of this decision. They will be attached when you save.`),
});
