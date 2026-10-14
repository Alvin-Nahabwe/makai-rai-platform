import { describe, it, expect } from 'vitest';
import TermsPage from '../../app/(public)/terms/page';
import { extractText } from '../helpers/extractText';

/**
 * Task 15 (G2-14 (b)). The Terms said research use of anonymized data "is optional and
 * governed by the separate consent you provide at registration". That consent no longer
 * exists: the registration forms do not ask for it, nothing stores it, and values
 * given earlier are voided. A page that still pointed at it would describe a control
 * that is not there.
 *
 * `TermsPage` is hook-free, so it is called directly and walked with `extractText`
 * (D-169: vitest runs under `environment: 'node'`).
 */

const text = (): string => extractText(TermsPage());

describe('TermsPage', () => {
  it('no longer says research use is governed by consent given at registration', () => {
    const out = text();
    expect(out).not.toContain('governed by the separate consent');
    expect(out).not.toContain('provide at registration');
    expect(out).not.toContain('is optional');
  });

  it('states that the platform does not use data for research and earlier consent is void', () => {
    const out = text();
    expect(out).toContain('The platform does not use your data for research.');
    expect(out).toContain('The registration form no longer asks for research consent');
    expect(out).toContain('consent given earlier has been voided');
  });

  it('still points the reader at the Privacy Policy for how data is handled', () => {
    expect(text()).toContain('Handling of your data is described in the Privacy Policy.');
  });
});
