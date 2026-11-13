/** The words of the legal-text screens. Titles only for now; later tasks add the rest. */
export const LEGAL_COPY = Object.freeze({
  titles: Object.freeze({
    acceptances: 'Read and accept',
    /** One version of a text: its heading (`legalTextHeading`), then the version. */
    version: (heading: string, version: string): string => `${heading}, version ${version}`,
  }),
});
