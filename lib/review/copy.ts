/** The words of stage reviews and seals. Titles only for now; later tasks add the rest. */
export const REVIEW_COPY = Object.freeze({
  titles: Object.freeze({
    openReview: 'Open a stage review',
    /** The seal confirmation's own heading: the review's name and the number the seal will take. */
    seal: (reviewName: string, sealNumber: number): string => `Seal "${reviewName}" as seal ${sealNumber}`,
  }),
});
