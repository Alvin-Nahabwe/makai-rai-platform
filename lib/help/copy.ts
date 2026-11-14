import { TERM_PRODUCT } from '@/lib/vocabulary/terms';

/**
 * The words of Help, `/help` (plan 1A Task 12, ruling L2-69; the coordinator's answers on wording). Only the server Help
 * page and the review page import it: no client component does (ruling X-2), so none of it reaches a browser bundle. The
 * vocabulary's terms and definitions are not copy: lib/help/vocabulary.ts reads them from data/vocabulary.json.
 */
export const HELP_COPY = Object.freeze({
  titles: Object.freeze({ help: 'Help' }),
  words: Object.freeze({ heading: 'Words used on the platform' }),
  sealing: Object.freeze({
    heading: 'What sealing means',
    paragraphs: Object.freeze([
      'When your team seals a stage review, the platform saves the decisions and evidence in it at that moment. After that, nobody can change what was sealed. If a file must be deleted later (for example for privacy), the platform shows that it was deleted.',
      "A seal does not show that the decisions are correct or that the evidence supports them. It is your team's record, not a check by MAK-AI.",
    ]),
  }),
  legal: Object.freeze({ heading: 'Terms and privacy' }),
  contact: Object.freeze({
    heading: 'Contact',
    /** "Write to <address>.": the words before the address link and the full stop after it. */
    writeTo: 'Write to ',
    writeToEnd: '.',
    askOwner: 'For help, ask the Owner of your organisation.',
  }),
  about: `About the ${TERM_PRODUCT.term}`,
});
