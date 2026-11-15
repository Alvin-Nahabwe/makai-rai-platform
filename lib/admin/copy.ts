/**
 * The words of the MAK-AI administrator's four pages (plan 1A Task 19, part 19a; copy audit D rows AD1 to AD33): the
 * titles, the refusal line, Accounts, the Organisations list and the organisation page's own lines. Server pages only
 * import it; the forms' words are `lib/admin/forms/copy.ts`.
 */
export const ADMIN_COPY = Object.freeze({
  titles: Object.freeze({
    accounts: 'Accounts',
    organisations: 'Organisations',
    newOrganisation: 'Create an organisation',
    organisation: 'Organisation',
  }),
  /** What a signed-in account without the platform role gets on every administrator page. */
  refusal: Object.freeze({
    line: 'Only the MAK-AI administrator can open this page.',
    link: 'Go to your organisations',
  }),
  /** S-25. */
  accounts: Object.freeze({
    caption: 'Every account on the platform, oldest first',
    columns: Object.freeze({
      name: 'Name', email: 'Email', type: 'Account type', status: 'Status', created: 'Created', actions: 'Actions',
    }),
    you: ' (you)',
    typeAdmin: 'MAK-AI administrator',
    typeMember: 'Team member',
    active: 'Active',
    deactivated: 'Deactivated',
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
    /** The button's accessible name: its verb and the account's name. */
    actionName: (verb: string, name: string): string => `${verb} ${name}`,
    /** "A", "A and B", "A, B and C". */
    listOf: (names: readonly string[]): string =>
      (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`),
    onlyOwner: (name: string, orgs: string): string =>
      `${name} is the only active Owner of ${orgs}. If you deactivate this account, ${orgs} will have no active Owner. Enter the reference of the organisation's written request first.`,
    referenceLabel: "Reference of the organisation's written request",
    showMore: 'Show more' as const,
    /** Route 47's refusal codes (app/api/admin/users/[id]/role/route.ts), each with the sentence S-25 shows. */
    refusals: Object.freeze({
      self: 'You cannot deactivate your own account.',
      request_reference_required: 'Enter the reference of the written request from the organisation (for example the letter number or email date). You need it to deactivate the only active Owner.',
      has_membership: 'This account belongs to an organisation, so it cannot be a MAK-AI administrator.',
      invalid_request: 'That change could not be made. Reload the page and try again.',
      single_admin: 'There can be only one MAK-AI administrator. This account was not changed.',
    }),
  }),
  /** S-23. */
  organisations: Object.freeze({
    create: 'Create organisation',
    empty: 'No organisations yet.',
    caption: 'Every organisation on the platform, by name',
    columns: Object.freeze({
      organisation: 'Organisation', created: 'Created', legalName: 'Legal name', members: 'Members', invitation: 'Owner invitation',
    }),
    archived: ' (archived)',
    noActiveOwner: 'No active Owner',
    legalNameMissing: 'Legal name not recorded',
    noInvitation: 'None',
    showMore: 'Show more' as const,
  }),
  /** S-24 detail: the lines under the organisation's name. */
  organisation: Object.freeze({
    summary: (date: string, members: number): string => `Created ${date} · ${members} ${members === 1 ? 'member' : 'members'}`,
    /** Its own label under the summary line (R1 S2), as "No active Owner" is (S1). */
    archived: 'Archived',
    legalName: (value: string): string => `Legal name: ${value}`,
  }),
});
