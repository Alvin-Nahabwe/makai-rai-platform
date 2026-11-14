import { describe, expect, it } from 'vitest';
import { decisionFormNote } from '../../lib/authz/permissionNotes';
import { AUTHZ_COPY } from '../../lib/authz/copy';

/**
 * UX-14 (SRS lines 2319-2320): for a reviewer or viewer, S-12 shows no answer form and says in one line who records
 * decisions and what this person can do instead (audit D row OR87: a reviewer can read them and raise a finding, a viewer
 * can read them); an archived project's line is ArchivedBanner's (SRS line 2368), so this note is null there.
 */
describe('decisionFormNote (UX-14)', () => {
  it('UX-14: decisionFormNote names the roles and is null when archived or allowed', () => {
    expect(decisionFormNote('reviewer', false)).toBe(AUTHZ_COPY.decisionFormNote.reviewer);
    expect(decisionFormNote('viewer', false)).toBe(AUTHZ_COPY.decisionFormNote.viewer);
    for (const role of ['owner', 'admin', 'assessor'] as const) expect(decisionFormNote(role, false)).toBeNull();
    expect(decisionFormNote('viewer', true)).toBeNull();
    expect(decisionFormNote('owner', true)).toBeNull();
  });
});
