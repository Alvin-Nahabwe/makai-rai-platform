/**
 * The words of the MAK-AI administrator's forms (plan 1A Task 19, part 19a; copy audit D rows AD34 to AD126, with the
 * coordinator's answers Q2 to Q7 of 14 November 2026 and the owner's sentence for the create form). Loaded by the five
 * files of `components/admin/` (`CreateOrganisationForm.tsx`, `OwnerInvitationBox.tsx`, `CorrectNameForm.tsx` and
 * `CorrectLegalNameForm.tsx` are client files; `AgreementRecords.tsx` keeps its two history strings inline, ruling Q5)
 * and by the organisations list page (`app/(authenticated)/admin/organisations/page.tsx`, a server page) for the
 * invitation state words, so it holds the administrator's form words and nothing else (ruling X-2: a copy module ships
 * whole to every page whose client code imports it). It imports nothing: a length limit comes in as a number, and the
 * email-failed sentences are the copy-link box's (`COPY_LINK_COPY.emailFailed` with the link on the screen,
 * `emailFailedNoLink` without it; answer Q21), which the components put after the outcome words here.
 */

/** The four invitation states (W-10), as the list and the organisations table show them. */
export const INVITATION_STATE_WORDS = Object.freeze({
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Cancelled',
});

/** The create screen's link to the organisation it created, whose words its refusals of a resend read (answer Q22). */
const OPEN_ORGANISATION = 'Open the organisation';

export const ADMIN_FORMS_COPY = Object.freeze({
  /** S-24 create mode. */
  create: Object.freeze({
    nameLabel: 'Organisation name',
    nameHint: "Create one organisation for each team whose members may read each other's records. An institution with several teams gets one organisation for each.",
    legalNameLabel: "Institution's legal name",
    legalNameHint: 'The registered name of the university, hospital or institute the team belongs to.',
    ownerEmailLabel: "First Owner's email",
    showLink: 'Also show the invitation link, so I can send it myself if the email does not arrive',
    note: "Creating the organisation also creates the first Owner's invitation and emails it. If the email cannot be sent, the organisation is still created and you can send the link yourself.",
    submit: 'Create organisation and send invitation',
    retry: 'Retry',
    open: OPEN_ORGANISATION,
    nameMissing: 'Enter the organisation name.',
    legalNameMissing: "Enter the institution's legal name.",
    ownerEmailMissing: "Enter the first Owner's email address.",
    tooLong: (max: number): string => `Use ${max} characters or fewer.`,
    creating: 'Creating the organisation...',
    sending: 'Sending...',
    sent: (email: string): string => `Created. Invitation sent to ${email}.`,
    /** Followed by the copy-link box's email-failed sentence for the screen (answer Q21). */
    createdPrefix: 'Created.',
    alreadyCreated: 'This organisation was already created. Open it to resend the invitation if the email did not arrive.',
    notCreated: 'Not created yet. We did not get a reply, so the organisation may already be created. Select Retry. It will not be created twice.',
    signedOut: 'Not created. You have been signed out. Sign in again.',
    serverProblem: 'Not created. The server had a problem. Select Retry.',
    checkFields: 'Not created. Check the fields marked below.',
    slugTaken: 'Another organisation has a name that is too similar. Change the name a little and try again.',
    notAdmin: 'Not created. This account is not the MAK-AI administrator.',
    other: 'Not created. Reload the page and try again.',
    /**
     * The link box's resend refused on this screen (answer Q22): a reload shows an empty form here, so where the
     * organisation page says "Reload the page", this screen points at its link to the organisation.
     */
    resendRefusals: Object.freeze({
      lostReply: `The connection was lost, so we do not know if this worked. ${OPEN_ORGANISATION} to check before you try again.`,
      serverProblem: `Not done. The server had a problem. ${OPEN_ORGANISATION} and try again.`,
      notPending: `That invitation was already accepted, cancelled or expired. ${OPEN_ORGANISATION} to see its state.`,
      notFound: `That invitation no longer exists. ${OPEN_ORGANISATION}.`,
      other: `Not done. ${OPEN_ORGANISATION} and try again.`,
    }),
  }),
  /** The owner invitation box on S-24 detail, and the refusals of an owner invitation write. */
  invitation: Object.freeze({
    heading: 'Owner invitation',
    none: 'No owner invitation has been sent.',
    line: (email: string, state: string): string => `${email} · ${state}`,
    expires: (date: string): string => ` · link expires ${date}`,
    copiedLink: ' · account created from a copied link',
    archived: 'This organisation is archived, so it cannot receive new invitations.',
    showLink: 'Also show the invitation link',
    resend: 'Resend invitation',
    resendHint: 'Makes a new link. The old link stops working.',
    cancelTrigger: 'Cancel invitation',
    confirmObject: (email: string): string => `Invitation to ${email}`,
    confirmConsequence: 'Its link stops working now. You can send a new owner invitation afterwards.',
    confirmAction: 'Cancel invitation',
    keep: 'Keep invitation',
    cancelled: (email: string): string => `Cancelled. The invitation to ${email} no longer works.`,
    sendNew: 'Send a new owner invitation',
    emailLabel: "New Owner's email",
    referenceLabel: "Reference of the organisation's written request",
    submit: 'Send invitation',
    cancel: 'Cancel',
    checkAbove: 'Check the fields marked above.',
    emailMissing: "Enter the new Owner's email address.",
    referenceMissing: "Enter the reference of the organisation's written request.",
    tooLong: (max: number): string => `Use ${max} characters or fewer.`,
    sending: 'Sending...',
    sent: (email: string): string => `Sent to ${email}.`,
    /** Followed by the copy-link box's email-failed sentence, after "Send invitation". */
    createdPrefix: 'Invitation created.',
    /** Followed by "Invitation sent to …" or the copy-link box's email-failed sentence. */
    resentPrefix: 'Resent: the old link no longer works.',
    sentTo: (email: string): string => `Invitation sent to ${email}.`,
    alreadyResent: 'This invitation was already resent. If the email did not arrive, send it again.',
    lostReply: 'The connection was lost, so we do not know if this worked. Reload the page to check before you try again.',
    signedOut: 'Not done. You have been signed out. Sign in again.',
    serverProblem: 'Not done. The server had a problem. Reload the page and try again.',
    notPending: 'That invitation was already accepted, cancelled or expired. Reload the page to see its state.',
    activeOwner: 'This organisation has an active Owner. An owner invitation is not needed.',
    pendingExists: 'An owner invitation is already pending. Resend or cancel it instead.',
    notFound: 'That invitation no longer exists. Reload the page.',
    checkFields: 'Not done. Check the fields marked below.',
    other: 'Not done. Reload the page and try again.',
  }),
  /** The organisation's name on S-24 detail. */
  name: Object.freeze({
    change: 'Change the name',
    label: 'Organisation name',
    save: 'Save name',
    cancel: 'Cancel',
    saving: 'Saving...',
    missing: 'Enter the new name.',
    tooLong: (max: number): string => `Use ${max} characters or fewer.`,
    unchanged: "This is already the organisation's name.",
    saved: (next: string, old: string): string => `Saved. The name is now ${next}. It was ${old}. Documents made before this change still show the old name.`,
    lostReply: 'The connection was lost, so we do not know if the new name was saved. Reload the page to check before you try again.',
    signedOut: 'Not saved. You have been signed out. Sign in again.',
    other: 'Not saved. Reload the page and try again.',
  }),
  /** The institution's legal name on S-24 detail. */
  legalName: Object.freeze({
    change: 'Change the legal name',
    label: "Institution's legal name",
    hint: 'The registered name of the university, hospital or institute the team belongs to.',
    save: 'Save legal name',
    cancel: 'Cancel',
    saving: 'Saving...',
    missing: "Enter the institution's legal name.",
    tooLong: (max: number): string => `Use ${max} characters or fewer.`,
    unchanged: "This is already the institution's legal name.",
    fieldMarked: 'Not saved. Check the field marked below.',
    saved: (next: string, old: string): string => `Saved. The legal name is now ${next}. It was ${old}.`,
    savedFirst: (next: string): string => `Saved. The legal name is now ${next}. None was recorded before.`,
    lostReply: 'The connection was lost, so we do not know if the new legal name was saved. Reload the page to check before you try again.',
    signedOut: 'Not saved. You have been signed out. Sign in again.',
    other: 'Not saved. Reload the page and try again.',
  }),
});
