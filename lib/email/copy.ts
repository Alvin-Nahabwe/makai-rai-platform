/**
 * The words of the emails the platform sends to people (audit A 220 to 238, block 16d of the lane lead's additions).
 * Server code only: no client file may import this module. It imports nothing, so a template file passes in
 * what varies: the organisation, the role with its article (`roleWithArticle(role)` in `lib/org/copy.ts`), a date
 * written by `formatDay`. A raw role value is never written into an email.
 *
 * Every sentence here holds none of the characters `HTML` escapes, so the same sentence is the text part's and the
 * HTML part's. What varies is escaped, or wrapped in `<strong>`, by the template before it arrives. A text part is
 * paragraphs separated by one empty line; a link stands alone on its own line under the sentence that ends with a colon.
 * (`signInAlert.ts` goes to the operator and has no words here.)
 */
export const EMAIL_COPY = Object.freeze({
  /** E-01, the invitation (A 220 to 222). `organisation` and `roleSentence` are bold in the HTML part. */
  invitation: Object.freeze({
    subject: (organisation: string): string => `You are invited to ${organisation} on the MAK-AI RAI Platform`,
    intro: (organisation: string, roleSentence: string): string =>
      `You are invited to join ${organisation} on the MAK-AI RAI Platform. Research teams use the platform to record decisions about their AI systems. You will join as ${roleSentence}.`,
    linkLead: 'To accept, open this link:',
    closing: (date: string): string =>
      `The link works once. It stops working on ${date}. If you did not expect this email, you can ignore it.`,
  }),
  /** E-06, an account was created from an invitation (A 223, 224). */
  accountCreated: Object.freeze({
    subject: 'An account was created for you on the MAK-AI RAI Platform',
    intro: (organisation: string, date: string): string =>
      `An account for this email address was created on the MAK-AI RAI Platform on ${date}. It is a member of ${organisation}. If you did not create it, reset the password now:`,
    closing: (organisation: string): string => `Then tell the Owner of ${organisation}.`,
  }),
  /** E-03, the reset link (A 225 keeps the subject, A 226). */
  passwordReset: Object.freeze({
    subject: 'Reset your MAK-AI RAI Platform password',
    linkLead: 'To set a new password, open this link:',
    closing:
      'The link works once. It stops working after 30 minutes. If you did not ask for this, ignore this email. Your password will not change.',
  }),
  /** E-02, the password was changed (A 227 keeps the subject, A 228). */
  passwordChanged: Object.freeze({
    subject: 'Your MAK-AI RAI Platform password was changed',
    intro: (date: string, time: string): string =>
      `The password for your MAK-AI RAI Platform account was changed on ${date} at ${time} UTC. If you did not change it, reset your password now:`,
    closing: 'Then tell the Owner of your organisation.',
  }),
  /** E-04 and E-05, the mitigation reminders (subjects keep today's words). */
  reminder: Object.freeze({
    dueSubject: (organisation: string): string => `A mitigation is due today in ${organisation}`,
    overdueSubject: (organisation: string): string => `A mitigation is 7 days overdue in ${organisation}`,
    dueIntro: (organisation: string, date: string): string =>
      `A mitigation assigned to you in ${organisation} is due today, ${date}.`,
    overdueIntro: (organisation: string, date: string): string =>
      `A mitigation assigned to you in ${organisation} was due on ${date}. It is now 7 days overdue.`,
    linkLead: 'Open Home to see it:',
    closing:
      'You get this email because this mitigation is assigned to you. You can turn these emails off in My account.',
  }),
});
