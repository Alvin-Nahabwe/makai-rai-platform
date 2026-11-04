import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { claimMatches } from '@/lib/claims/pattern';

/**
 * The words of the version-1 legal texts as shipped (FR-ACC-02; ACC-a Task 13). The actual registry
 * (vi.importActual), not the stub __tests__/setup/legal.ts installs. The sentences pinned here moved
 * from the deleted page tests of /terms and /privacy (__tests__/unit/terms-page.test.tsx and
 * privacy-page.test.tsx), whose pages now redirect to S-06; the text is the registry's, each
 * paragraph on one line, so a sentence is never split by a line break.
 */
const { currentLegalText, LEGAL_KINDS } = await vi.importActual<typeof import('@/lib/legal/registry')>('@/lib/legal/registry');

describe('the version-1 terms and privacy texts (FR-ACC-02)', () => {
  it('FR-ACC-02: the terms text no longer says research use rests on consent given at registration', () => {
    const out = currentLegalText('terms').text;
    for (const gone of ['governed by the separate consent', 'provide at registration', 'is optional']) expect(out).not.toContain(gone);
  });

  it('FR-ACC-02: the terms text says the platform does not use data for research and earlier consent is void', () => {
    const out = currentLegalText('terms').text;
    for (const s of ['The platform does not use your data for research.', 'The registration form no longer asks for research consent',
      'consent given earlier has been voided']) expect(out).toContain(s);
  });

  it('FR-ACC-02: the terms text points the reader at the privacy text', () => {
    expect(currentLegalText('terms').text).toContain('Handling of your data is described in the Privacy Policy.');
  });

  it('FR-ACC-02 FR-PUB-01: the terms text is PUB\'s reworded page: no certification, no scores', () => {
    const out = currentLegalText('terms').text;
    expect(out).toContain('It is an assessment and guidance tool. It does not give legal advice or assurance.');
    expect(out).toContain('What it records and suggests is guidance to support human judgement, not a substitute for it.');
  });

  it('FR-ACC-02: the privacy text says truthfully who can read data and how data is used, with no research use', () => {
    const out = currentLegalText('privacy').text;
    for (const gone of ['Research use', 'account settings', 'platform administrators of your institution']) expect(out).not.toContain(gone);
    expect(out).toContain('every member of that organization');
    expect(out).toContain('To provide the assessment service to you: saving and resuming assessments, generating reports, and showing your history. Everything entered in an organization can be read by every member of that organization.');
    expect(out).toContain('Passwords are stored hashed. Data entered in an organization can be read by every member of that organization and by the platform operators. See the Terms of Service for acceptable use.');
  });

  it('FR-ACC-02: the privacy text states that there is no self-service export or deletion yet', () => {
    // Pins today's sentence. The owner input (owner-questions.md, "Inputs needed during the build") says v0.6.0 makes it untrue;
    // legal replaces it (A4). When it changes, change this case, the file and published.json in ONE commit. "for audit purposes"
    // became "so that what was accepted, and when, can be shown later": PUB's word list bans "audit" (lib/claims/pattern.ts).
    expect(currentLegalText('privacy').text).toContain('There is no self-service export or account deletion in the interface yet. Consent records are stored with a timestamp, so that what was accepted, and when, can be shown later.');
  });

  it('NFR-PRIV-10 FR-ACC-02: the privacy notice names every recipient of data/privacy-recipients.json, with what it receives and where', () => {
    const recipients: Array<{ name: string; receives: string; where: string }> = JSON.parse(readFileSync('data/privacy-recipients.json', 'utf8'));
    expect(recipients.length).toBeGreaterThan(0);
    const text = currentLegalText('privacy').text;
    expect(text).toContain('Where personal data goes outside the host');
    for (const r of recipients) expect(text).toContain(`${r.name}: ${r.receives} Where: ${r.where}.`);
  });

  it('FR-PUB-01 FR-ACC-02: no version-1 legal text holds a word of PUB\'s list (lib/claims/pattern.ts)', () => {
    for (const k of LEGAL_KINDS) expect(claimMatches(currentLegalText(k).text).map((m) => m.text), k).toEqual([]);
  });

  // An unset run reports this case as skipped, not passed: a release candidate runs it with RELEASE_CANDIDATE=1. The boot
  // check (instrumentation.ts) stays blind to the words; this is the release gate on the placeholder (owner question A4).
  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('FR-ACC-02 (release): no shipped legal text still holds the placeholder legal supplies', () => {
    const placeholder = 'supplied by legal before the deploy day';
    const holding = LEGAL_KINDS.flatMap((k) => readdirSync(`data/legal/${k}`).filter((f) => f.endsWith('.md')).map((f) => `data/legal/${k}/${f}`))
      .filter((f) => readFileSync(f, 'utf8').includes(placeholder));
    expect(holding, 'version files still holding the placeholder').toEqual([]);
  });
});
