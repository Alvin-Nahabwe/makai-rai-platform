import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ACCEPTED_KINDS } from '@/types/legal';

// The shipped registry, not the setup file's version-1 stubs: the summaries answer the texts actually published.
vi.mock('@/lib/legal/registry', async (importOriginal) => importOriginal());

const { legalTextHistory } = await import('@/lib/legal/registry');
const { LEGAL_CHANGE_SUMMARIES } = await import('@/lib/legal/copy');

/**
 * Plan 1B Task 7 (ruling L5-16; owner's approval O7): the plain summary of what changed in each published version after
 * version 1, shown on S-05 to an account asked to accept it. Copied exactly from the approved pack
 * (records/plans/2026-11-11-ux-redesign/legal-v2/change-summaries.md, one paragraph per text); the pin below is the
 * sha256 of the object's JSON, so a reworded summary fails here.
 */
const APPROVED_SUMMARIES_SHA256 = '9364fb2758cba1dc4bc9ff0ec0e74640030583c4ef740ca82074866c71269081';

describe('LEGAL_CHANGE_SUMMARIES', () => {
  it('Review Focus 5: every published version after 1 of an accepted kind has an approved summary', () => {
    for (const k of ACCEPTED_KINDS) {
      expect(legalTextHistory(k).length, k).toBeGreaterThan(1);   // version 2 is published: the check is not empty
      for (const t of legalTextHistory(k).slice(1)) expect(LEGAL_CHANGE_SUMMARIES[k][t.version]?.trim(), `${k} ${t.version}`).toBeTruthy();
    }
  });

  it('summaries equal the approved pack', () => {
    expect(createHash('sha256').update(JSON.stringify(LEGAL_CHANGE_SUMMARIES)).digest('hex')).toBe(APPROVED_SUMMARIES_SHA256);
  });

  it('keys are the three accepted kinds, each summary one paragraph of plain text', () => {
    expect(Object.keys(LEGAL_CHANGE_SUMMARIES)).toEqual([...ACCEPTED_KINDS]);
    for (const k of ACCEPTED_KINDS) for (const s of Object.values(LEGAL_CHANGE_SUMMARIES[k])) expect(s).not.toMatch(/\n|<|\*|#/);
  });
});
