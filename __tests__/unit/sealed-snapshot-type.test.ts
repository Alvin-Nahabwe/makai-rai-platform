import { describe, expect, it } from 'vitest';
import type { DocumentSnapshot, SealedSnapshot } from '@/lib/documents/resolve';

/**
 * Anti-goal 5 at the type level: the issue path (`lib/data/documents.ts` `build`, `issueDocument`) takes a `SealedSnapshot`, and a
 * snapshot whose provenance is a draft cannot be passed to it. The real assertion of this file is `npx tsc --noEmit`: if a draft
 * became assignable, the `@ts-expect-error` below would be unused and tsc would fail. The run-time expectation only keeps vitest
 * from reporting an empty case.
 */
describe('SealedSnapshot', () => {
  it('a draft snapshot is not a SealedSnapshot (anti-goal 5, type level)', () => {
    const draft = { provenance: { kind: 'draft', takenAt: '2026-11-19T14:05:09.000Z' } } as unknown as DocumentSnapshot & { provenance: { kind: 'draft' } };
    // @ts-expect-error a draft cannot reach the issue path
    const issued: SealedSnapshot = draft;
    expect(issued.provenance.kind).toBe('draft');
  });
});
