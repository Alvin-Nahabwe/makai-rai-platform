import { describe, expect, it } from 'vitest';
import { decisionFormNote } from '../../lib/authz/permissionNotes';

/**
 * UX-14 (SRS lines 2319-2320): for a reviewer or viewer, S-12 shows no answer form and says why in one line,
 * "Only owners, admins and assessors record decisions."; an archived project's line is ArchivedBanner's (SRS
 * line 2368), so this note is null there.
 */
describe('decisionFormNote (UX-14)', () => {
  it('UX-14: decisionFormNote names the roles and is null when archived or allowed', () => {
    for (const role of ['reviewer', 'viewer'] as const)
      expect(decisionFormNote(role, false)).toBe('Only owners, admins and assessors record decisions.');
    for (const role of ['owner', 'admin', 'assessor'] as const) expect(decisionFormNote(role, false)).toBeNull();
    expect(decisionFormNote('viewer', true)).toBeNull();
    expect(decisionFormNote('owner', true)).toBeNull();
  });
});
