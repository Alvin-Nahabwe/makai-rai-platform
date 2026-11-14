/** The words of S-20, Download records: the two pages and their panel (plan 1A Task 18, part 18d). */
export const EXPORT_COPY = Object.freeze({
  titles: Object.freeze({ downloadRecords: 'Download records' }),
  intro: Object.freeze({
    organisation: 'Everything your organisation recorded, with its history, every evidence file and every issued document.',
    project: "This project's records, with their history, its evidence files and its issued documents.",
  }),
  panel: Object.freeze({
    download: 'Download records',
    preparing: 'Preparing the export. Large projects can take a few minutes.',
    refused: Object.freeze({
      export_busy: 'Two exports are already being prepared. Try again when one has finished.',
      rate_limited: 'You can start 3 exports an hour. Try again later.',
    }),
  }),
});

/** The panel's sentence (M-37): what will be downloaded and about how big, `size` already written ("2.4 MB"). */
export const recordsOf = (scopeName: string, size: string): string => `Records of ${scopeName}: about ${size}, as one ZIP file.`;
