/**
 * The copy-link box of the members and administrator screens (`components/invitations/CopyLinkFallback.tsx`; plan 1A
 * Task 16b). In a module of its own so that the public invitation page, which does not show the box, does not carry
 * its words (a copy module ships whole, ruling T16-18). It imports nothing.
 */

export const COPY_LINK_COPY = Object.freeze({
  copied: 'Link copied.',
  copyFailed: 'The link could not be copied. Select it and copy it by hand.',
  emailFailed: 'The invitation email could not be sent. Send this link another way.',
  linkLabel: 'Invitation link',
  copy: 'Copy link',
  worksOnce: (date: string): string => `The link works once and expires on ${date}.`,
  resend: 'Send the email again and show the link',
});
