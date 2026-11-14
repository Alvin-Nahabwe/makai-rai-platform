/**
 * The words of the newer-text notice (M-39). `NewerLegalTextOffers` is a client file inside the signed-in layout, so this
 * module rides on every signed-in page: it holds these three texts and nothing else (plan 1A Task 16b).
 */
export const NOTICE_COPY = Object.freeze({
  /** `name` is the text's name as running text ("privacy notice"). */
  published: (name: string, date: string): string => `A new version of the ${name} was published on ${date}.`,
  readAndAccept: 'Read and accept',
  notNow: 'Not now',
});
