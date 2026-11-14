/**
 * The messages the project routes answer for a descriptive field's value (audit B rows 357 to 362), read by
 * lib/projects/metadataValues.ts. Server only: no file with 'use client' imports it (ruling X-2).
 */
export const PROJECT_FIELD_MESSAGES = Object.freeze({
  developmentStage: 'Choose a development status from the list.',
  datasetSize: 'Choose a dataset size from the list.',
  processesPersonalData: 'Choose Yes or No.',
  teamSize: 'Enter a whole number, 0 or more.',
  date: 'Enter a date.',
  textMax: (max: number) => `Use ${max} characters or fewer.`,
});
