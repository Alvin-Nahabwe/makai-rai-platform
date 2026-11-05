import { PROJECT_METADATA_FIELDS } from '@/lib/validate';

/** The values of the Prisma enums `DevelopmentStage` and `DatasetSize` (prisma/schema.prisma). */
const DEVELOPMENT_STAGES: readonly string[] = ['concept', 'development', 'testing', 'deployed', 'retired'];
const DATASET_SIZES: readonly string[] = ['small_lt1k', 'medium_1k_100k', 'large_100k_1m', 'very_large_gt1m', 'unknown'];

const TEXT_MAX = 200;
const DESCRIPTION_MAX = 2000;

function isCalendarDate(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The message for one field's value, or null when it is acceptable. `null` clears a field, as it did before. */
function problem(field: string, value: unknown): string | null {
  if (value === null) return null;
  switch (field) {
    case 'developmentStage':
      return typeof value === 'string' && DEVELOPMENT_STAGES.includes(value) ? null : `${field} must be one of ${DEVELOPMENT_STAGES.join(', ')}`;
    case 'datasetSize':
      return typeof value === 'string' && DATASET_SIZES.includes(value) ? null : `${field} must be one of ${DATASET_SIZES.join(', ')}`;
    case 'processesPersonalData':
      return typeof value === 'boolean' ? null : `${field} must be true or false`;
    case 'teamSize':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? null : `${field} must be a whole number of at least 0`;
    case 'projectStart':
    case 'projectEnd':
      return isCalendarDate(value) ? null : `${field} must be a date written YYYY-MM-DD`;
    default: {
      const max = field === 'datasetDescription' ? DESCRIPTION_MAX : TEXT_MAX;
      return typeof value === 'string' && value.length <= max ? null : `${field} must be text of at most ${max} characters`;
    }
  }
}

/**
 * Checks each value of the descriptive fields against the `ProjectMetadata` column type before it reaches Prisma
 * (a wrong type would answer 500). It runs after `validateMetadataFields`, which checks the keys. Returns the first
 * field at fault, or null.
 */
export function validateProjectMetadataValues(fields: Record<string, unknown>): { field: string; message: string } | null {
  for (const field of PROJECT_METADATA_FIELDS) {
    if (!Object.hasOwn(fields, field)) continue;
    const message = problem(field, fields[field]);
    if (message !== null) return { field, message };
  }
  return null;
}

/**
 * The values as Prisma takes them: the two `YYYY-MM-DD` dates become UTC dates (Prisma refuses a bare date string
 * for a `DateTime` column). Call it on values `validateProjectMetadataValues` accepted.
 */
export function metadataColumnValues(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  for (const key of ['projectStart', 'projectEnd']) {
    const v = out[key];
    if (typeof v === 'string') out[key] = new Date(`${v}T00:00:00Z`);
  }
  return out;
}
