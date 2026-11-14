/**
 * The display words of the derived project fields, in one module so the issued document and the project form
 * cannot differ (owner default B37, FR-DOC-02). Constants only and no imports, so a client component can import
 * it. The dataset size keys are the `DatasetSize` enum's values, in the enum's order (prisma/schema.prisma:58-64).
 */
export const DATASET_SIZE_WORDS: Readonly<Record<'small_lt1k' | 'medium_1k_100k' | 'large_100k_1m' | 'very_large_gt1m' | 'unknown', string>> = {
  small_lt1k: 'Under 1,000 records',
  medium_1k_100k: '1,000 to 100,000 records',
  large_100k_1m: '100,000 to 1 million records',
  very_large_gt1m: 'Over 1 million records',
  unknown: 'Not known',
};

/**
 * The words of the development status choices (the `DevelopmentStage` enum, in its order), for the form and for the
 * descriptive line. Here rather than in lib/projects/metadataValues.ts, so the client form does not ship the server's
 * field messages with them.
 */
export const LIFECYCLE_STAGE_WORDS: Readonly<Record<string, string>> = {
  concept: 'Concept', development: 'Development', testing: 'Testing', deployed: 'Deployed', retired: 'Retired',
};

/** Whether the project holds personal data, keyed by the boolean written as text: `PERSONAL_DATA_WORDS[`${flag}`]`. */
export const PERSONAL_DATA_WORDS: Readonly<Record<'true' | 'false', string>> = { true: 'Yes', false: 'No' };
