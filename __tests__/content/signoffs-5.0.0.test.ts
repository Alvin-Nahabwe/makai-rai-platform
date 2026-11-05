/**
 * The owner's sign-off records of content 5.0.0 (CW-04, FR-CNT-02; units/C-TXT.md Task 10). The hash match itself is
 * CNT's check (`__tests__/unit/content-signoffs.test.ts`, `__tests__/unit/content-release.test.ts`); this file checks
 * what that one does not: every record has an approver and a time inside the sittings.
 *
 * The window is the controller's ruling of 5 Nov 2026, which replaces the brief's 30 Oct to 1 Nov window after the
 * sittings moved: Thu 5 Nov 12:00 EAT to Sat 7 Nov 00:00 EAT (2026-11-05T09:00:00Z to 2026-11-06T21:00:00Z).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { SIGN_OFF_BATCHES } from '@/lib/content/signoffs';
import type { SignOffsFile } from '@/types/content';

vi.unmock('@/lib/content/root');

const FROM = Date.parse('2026-11-05T09:00:00Z');
const TO = Date.parse('2026-11-06T21:00:00Z');

const file = JSON.parse(readFileSync('data/content/5.0.0/signoffs.json', 'utf8')) as SignOffsFile;

describe('content 5.0.0 sign-off records', () => {
  it('FR-CNT-02: every record has an approver and a time inside the sittings', () => {
    // Seven batches: three stages, help-and-reason-codes, three question-set batches; one record each.
    expect([...SIGN_OFF_BATCHES].sort()).toHaveLength(7);
    expect(file.records.map((r) => r.batch).sort()).toEqual([...SIGN_OFF_BATCHES].sort());
    for (const r of file.records) {
      expect(r.approver.trim(), `${r.batch}: approver`).not.toBe('');
      const at = Date.parse(r.at);
      expect(Number.isNaN(at), `${r.batch}: at ${r.at} parses`).toBe(false);
      expect(at >= FROM && at <= TO, `${r.batch}: at ${r.at} is inside 2026-11-05T09:00:00Z..2026-11-06T21:00:00Z`).toBe(true);
    }
  });
});
