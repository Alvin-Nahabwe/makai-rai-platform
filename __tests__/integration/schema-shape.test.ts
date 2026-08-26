import { describe, it, expect } from 'vitest';
import { testDb } from '../helpers/db';

describe('assessments schema', () => {
  it('has no mode column', async () => {
    const rows = await testDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'assessments' AND column_name = 'mode'`;
    expect(rows).toEqual([]);
  });

  it('has no AssessmentMode type', async () => {
    const rows = await testDb.$queryRaw<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname = 'AssessmentMode'`;
    expect(rows).toEqual([]);
  });
});
