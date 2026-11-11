import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { claimMatches } from '@/lib/claims/pattern';
import { ACCEPTED_KINDS } from '@/types/legal';
import { RETIRED_KINDS } from '@/lib/legal/kinds';
import { ACCEPT_LABEL } from '@/components/legal/AcceptancesForm';
import { releaseWaiver } from '../helpers/releaseWaivers';

/**
 * The words of the version-1 legal texts as shipped (FR-ACC-02; ACC-a Task 13). The actual registry
 * (vi.importActual), not the stub __tests__/setup/legal.ts installs. The sentences pinned here moved
 * from the deleted page tests of /terms and /privacy (__tests__/unit/terms-page.test.tsx and
 * privacy-page.test.tsx), whose pages now redirect to S-06; the text is the registry's, each
 * paragraph on one line, so a sentence is never split by a line break.
 */
const { currentLegalText, legalTextVersion, legalTextHistory } = await vi.importActual<typeof import('@/lib/legal/registry')>('@/lib/legal/registry');

/** The words of version 1, as published: a published file is never edited, so these pins hold whatever version is current. */
const v1 = (kind: 'terms' | 'privacy'): string => {
  const found = legalTextVersion(kind, '1');
  if (found === null) throw new Error(`no version 1 of ${kind}`);
  return found.text;
};

describe('FR-ACC-02: version 1 stays as published', () => {
  it('FR-ACC-02: the terms text no longer says research use rests on consent given at registration', () => {
    const out = v1('terms');
    for (const gone of ['governed by the separate consent', 'provide at registration', 'is optional']) expect(out).not.toContain(gone);
  });

  it('FR-ACC-02: the terms text says the platform does not use data for research and earlier consent is void', () => {
    const out = v1('terms');
    for (const s of ['The platform does not use your data for research.', 'The registration form no longer asks for research consent',
      'consent given earlier has been voided']) expect(out).toContain(s);
  });

  it('FR-ACC-02: the terms text points the reader at the privacy text', () => {
    expect(v1('terms')).toContain('Handling of your data is described in the Privacy Policy.');
  });

  it('FR-ACC-02 FR-PUB-01: the terms text is PUB\'s reworded page: no certification, no scores', () => {
    const out = v1('terms');
    expect(out).toContain('It is an assessment and guidance tool. It does not give legal advice or assurance.');
    expect(out).toContain('What it records and suggests is guidance to support human judgement, not a substitute for it.');
  });

  it('FR-ACC-02: the privacy text says truthfully who can read data and how data is used, with no research use', () => {
    const out = v1('privacy');
    for (const gone of ['Research use', 'account settings', 'platform administrators of your institution']) expect(out).not.toContain(gone);
    expect(out).toContain('every member of that organization');
    expect(out).toContain('To provide the assessment service to you: saving and resuming assessments, generating reports, and showing your history. Everything entered in an organization can be read by every member of that organization.');
    expect(out).toContain('Passwords are stored hashed. Data entered in an organization can be read by every member of that organization and by the platform operators. See the Terms of Service for acceptable use.');
  });

  it('FR-ACC-02: the privacy text states that there is no self-service export or deletion yet', () => {
    // Pins today's sentence. The owner input (owner-questions.md, "Inputs needed during the build") says v0.6.0 makes it untrue;
    // legal replaces it (A4). When it changes, change this case, the file and published.json in ONE commit. "for audit purposes"
    // became "so that what was accepted, and when, can be shown later": PUB's word list bans "audit" (lib/claims/pattern.ts).
    expect(v1('privacy')).toContain('There is no self-service export or account deletion in the interface yet. Consent records are stored with a timestamp, so that what was accepted, and when, can be shown later.');
  });

  it('FR-ACC-02 (WCAG 1.3.1): the terms and privacy texts keep the old pages\' section headings', () => {
    const headings = (k: 'terms' | 'privacy') => [...legalTextVersion(k, '1')!.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings('terms')).toEqual(['1. Purpose', '2. Accounts', '3. Acceptable use', '4. Data', '5. No warranty']);
    expect(headings('privacy')).toEqual(['What we collect', 'How we use it', 'Your controls', 'Security', 'Where personal data goes outside the host']);
  });

  it('NFR-PRIV-10 FR-ACC-02: version 1 of the privacy notice names its three recipients, with what each receives and where', () => {
    // The three lines of data/legal/privacy/1.md as published, written out here: a published file is never edited, so this
    // pin does not follow data/privacy-recipients.json, which version 2 replaces. The live file is checked against the
    // current text by the release case below.
    const text = v1('privacy');
    expect(text).toContain('Where personal data goes outside the host');
    for (const line of [
      "Cloudflare: Web traffic to and from the platform. Cloudflare terminates TLS and so sees traffic in clear at its edge. Where: Cloudflare's edge network.",
      "Resend: The email messages the platform sends, with the recipient's address. Where: United States.",
      "Off-site backup store: Copies of the database backups. Where: The backup provider's storage, named by the owner.",
    ]) expect(text).toContain(line);
  });

  it('FR-ACC-02: the retired organisation agreement stays as published', () => {
    // Its history is version 1 and nothing else, and the hash the registry holds is the one published.json lists and the
    // one of the file's bytes. The agreement is no longer asked for; its text is history and is never replaced.
    expect(legalTextHistory('organisation-agreement').map((t) => t.version)).toEqual(['1']);
    const listed = (JSON.parse(readFileSync('data/legal/published.json', 'utf8')) as Array<{ kind: string; version: string; sha256: string }>)
      .filter((e) => e.kind === 'organisation-agreement');
    expect(listed.map((e) => e.version)).toEqual(['1']);
    const held = legalTextVersion('organisation-agreement', '1');
    expect(held?.sha256).toBe(listed[0].sha256);
    expect(createHash('sha256').update(readFileSync('data/legal/organisation-agreement/1.md')).digest('hex')).toBe(listed[0].sha256);
  });
});

describe('FR-PUB-01 FR-ACC-02: the texts a person is asked to accept now (current versions)', () => {
  it('FR-ACC-02: the consent labels read exactly as approved', () => {
    // The map pin: every other test takes the sentences from ACCEPT_LABEL, so this is the one place that says what a person
    // consents to. A change of wording changes this case, the label and the version it belongs to in one commit.
    expect(ACCEPT_LABEL).toEqual({
      terms: 'I accept the terms of service.',
      privacy: 'I have read the privacy notice.',
      'cross-border-consent': "I agree that my account and my team's records are stored and processed outside my country, as the cross-border storage consent describes.",
    });
  });

  it('FR-ACC-02: no kind is both retired and accepted', () => {
    expect(RETIRED_KINDS.filter((k) => (ACCEPTED_KINDS as readonly string[]).includes(k))).toEqual([]);
  });

  it('FR-PUB-01 (owner ruling R1, 11 Nov 2026): legal texts are exempt from the claim-word list; the consent labels are not', () => {
    // The words of a legal text are not checked here: the owner ruled they may use words such as "comply". The sentence
    // that sits beside a tick box is interface copy and is checked.
    const labels = Object.values(ACCEPT_LABEL);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(claimMatches(label).map((m) => m.text), label).toEqual([]);
  });

  // An unset run reports this case as skipped, not passed: a release candidate runs it with RELEASE_CANDIDATE=1. The boot
  // check (instrumentation.ts) stays blind to the words; this is the release gate on the placeholder (owner question A4).
  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('FR-ACC-02 (release): no current legal text still holds the placeholder legal supplies', () => {
    const placeholder = 'supplied by legal before the deploy day';
    // Current versions of the accepted kinds only: a version-1 placeholder file can never be edited, so only the file a person is
    // asked to accept now can pass; the retired agreement is history, not a text a person is asked to accept.
    const holding = ACCEPTED_KINDS.map((k) => `data/legal/${k}/${currentLegalText(k).version}.md`)
      .filter((f) => readFileSync(f, 'utf8').includes(placeholder));
    // The owner shipped two of them as placeholders (A4, "Ship placeholders"): a complete waiver covers exactly those
    // files (docs/releases/release-waivers.json); any other file holding the placeholder still fails.
    const waiver = releaseWaiver('FR-ACC-02 legal-placeholder');
    expect(holding.filter((f) => !waiver?.covers.includes(f)), 'current version files still holding the placeholder, with no owner waiver').toEqual([]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('FR-ACC-02 (release): no current legal text holds an unresolved field', () => {
    // A field the author left open in braces or square brackets, or the words that mark a gap for the owner to fill, in the text a person is asked
    // to accept now. Version files that are no longer current are not scanned: they can never change, so once a later version is
    // current their open fields no longer reach anyone who is asked to accept.
    const found = ACCEPTED_KINDS.flatMap((k) => {
      const { version, text } = currentLegalText(k);
      // None of the version 2 drafts or the version 1 texts uses square brackets, TBD, TODO or "(to be confirmed)" in its words.
      // "to be confirmed" counts only in brackets: "your address has to be confirmed" is a proper sentence.
      const gaps = [/\{[^}\n]+\}/g, /\[[^\]\n]*\]/g, /named by the owner/gi, /\b(?:TBD|TODO)\b/g, /\(to be confirmed\)/gi];
      return gaps.flatMap((re) => text.match(re) ?? []).map((m) => `${k}/${version}.md: ${m}`);
    });
    expect(found, 'an open field in the current version of an accepted legal text').toEqual([]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('FR-ACC-02 (release): no current legal text says it was written or reviewed by a lawyer', () => {
    // The stand-in texts were not written by a lawyer, and nothing a person is shown may say they were. The other words for the
    // profession are refused too; none of the version 2 drafts or the version 1 texts uses them.
    const found = ACCEPTED_KINDS.flatMap((k) => (currentLegalText(k).text.match(/\b(?:lawyers?|reviewed by|advocates?|attorneys?|solicitors?|counsel)\b/gi) ?? []).map((m) => `${k}: ${m}`));
    expect(found, 'a claim of legal authorship or review in the current version of an accepted legal text').toEqual([]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-PRIV-10 FR-ACC-02 (release): the current privacy notice names every recipient of data/privacy-recipients.json, with what it receives and where', () => {
    const recipients: Array<{ name: string; receives: string; where: string }> = JSON.parse(readFileSync('data/privacy-recipients.json', 'utf8'));
    expect(recipients.length).toBeGreaterThan(0);
    const { text } = currentLegalText('privacy');
    const missing = recipients.map((r) => `${r.name}: ${r.receives} Where: ${r.where}.`).filter((line) => !text.includes(line));
    expect(missing, 'recipient lines of the live file that the current privacy notice does not hold').toEqual([]);
  });
});
