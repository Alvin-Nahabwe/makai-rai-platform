import { describe, it, expect } from 'vitest';
import PrivacyPage from '../../app/(public)/privacy/page';
import { extractText } from '../helpers/extractText';

/**
 * Task 15 (G2-14 (b), UX-09). The privacy page told readers that an
 * "optional research use" existed, that they could export their data or delete
 * their account "from your account settings", and that data was visible only to
 * "platform administrators of your institution". None of that was true: the
 * research tick box is withdrawn, the interface has no self-service export or
 * deletion, and everything entered in an organization is readable by every
 * member of it (and by the platform operators).
 *
 * `PrivacyPage` is hook-free, so it is called directly and its element tree
 * walked with `extractText` (D-169: vitest runs under `environment: 'node'`).
 */

const text = (): string => extractText(PrivacyPage());

describe('PrivacyPage', () => {
  it('says truthfully who can read data', () => {
    const out = text();
    expect(out).not.toContain('Research use');
    expect(out).not.toContain('account settings');
    expect(out).not.toContain('platform administrators of your institution');
    expect(out).toContain('every member of that organization');
  });

  it('describes how data is used, with no research use', () => {
    expect(text()).toContain(
      'To provide the assessment service to you: saving and resuming assessments, generating ' +
        'reports, and showing your history. Everything entered in an organization can be read by ' +
        'every member of that organization.',
    );
  });

  it('states that there is no self-service export or deletion yet', () => {
    expect(text()).toContain(
      'There is no self-service export or account deletion in the interface yet. Consent ' +
        'records are stored with a timestamp for audit purposes.',
    );
  });

  it('states who can read data in the security section', () => {
    expect(text()).toContain(
      'Passwords are stored hashed. Data entered in an organization can be read by every member ' +
        'of that organization and by the platform operators. See the Terms of Service for ' +
        'acceptable use.',
    );
  });
});
