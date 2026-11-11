import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextVersion } from '@/types/legal';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * S-05's form (UX-22, FR-ACC-03, M-25; W-11 notes 2 and 3, SRS lines 2229-2250).
 *
 * vitest runs in the `node` environment and @testing-library/react, user-event and jsdom are not
 * installed (an install is a download, G-23; the approach of reviews/fix-r12.md R12-15): this file
 * reads the markup from react-dom/server and the pure rules the form applies on submit. What a
 * click and a focus move do is driven in a browser by e2e/acceptances.spec.ts.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { ACCEPT_LABEL, AcceptancesForm, AcceptancesFormView, untickedKinds, acceptanceError, acceptancePairs, recordOutcome, failureOutcome, handleFailure } =
  await import('@/components/legal/AcceptancesForm');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEXTS: LegalTextVersion[] = STUB_LEGAL_TEXTS.slice();
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
type ViewProps = Parameters<typeof AcceptancesFormView>[0];
// Mode `required` needs the signed-in account's id (SFH-10), so the default carries one.
const view = (over: Partial<ViewProps> = {}) => html(
  <AcceptancesFormView {...({ texts: TEXTS, mode: 'required', userId: 'u-1', submitLabel: 'Accept and continue', ticked: new Set(), errors: [],
    onToggle: vi.fn(), onSubmit: vi.fn(), ...over } as ViewProps)} />);
/** The opening tag of the element with this id. */
const tagOf = (markup: string, id: string) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';

describe('S-05 acceptances form (UX-22, FR-ACC-03)', () => {
  it('FR-ACC-03 (threat A5): the page posts each ticked kind with the version it rendered', () => {
    const shown: LegalTextVersion[] = [{ ...TEXTS[0], version: '3' }, TEXTS[1]];
    expect(acceptancePairs(shown, ['privacy', 'terms'])).toEqual([{ kind: 'privacy', version: '1' }, { kind: 'terms', version: '3' }]);
  });

  it('7.4.2 S-04 / S-05: a refusal shows what it is; only a server fault or a lost connection says the server had a problem', () => {
    // CR-5 / SFH-9: a 429 waits retryAfterSeconds, a flagged account goes to S-29, a worded 4xx shows its words.
    expect(failureOutcome(429, { error: 'Too many requests. Please try again later.', code: 'rate_limited', retryAfterSeconds: 120 }))
      .toEqual({ kind: 'message', text: 'Not created: too many attempts. Nothing was created. Wait 2 minutes, then try again.' });
    expect(failureOutcome(429, { error: 'Too many requests. Please try again later.', code: 'rate_limited', retryAfterSeconds: 30 }))
      .toEqual({ kind: 'message', text: 'Not created: too many attempts. Nothing was created. Wait 1 minute, then try again.' });
    expect(failureOutcome(403, { error: 'Password change required', code: 'must_change_password' })).toEqual({ kind: 'change-password' });
    expect(failureOutcome(403, { error: 'This request came from another site.', code: 'cross_origin' }))
      .toEqual({ kind: 'message', text: 'This request came from another site.' });
    expect(failureOutcome(410, { error: 'Gone for good.', code: 'invitation_unusable' })).toEqual({ kind: 'message', text: 'Gone for good.' });
    expect(failureOutcome(401, { error: 'Unauthorized', code: 'unauthenticated' })).toEqual({ kind: 'signin' });
    expect(failureOutcome(503, { error: 'Service unavailable', code: 'database_unavailable', reference: 'abcd1234' })).toEqual({ kind: 'refused' });
    expect(failureOutcome(500, null)).toEqual({ kind: 'refused' });
    expect(failureOutcome(404, null)).toEqual({ kind: 'refused' });
    expect(recordOutcome(429, { error: 'x', code: 'rate_limited', retryAfterSeconds: 600 })).toEqual({ kind: 'message',
      text: 'Not created: too many attempts. Nothing was created. Wait 10 minutes, then try again.' });
  });

  it('7.4.2 S-04 / S-05: each refusal is shown or followed as its kind says', () => {
    const calls: string[] = [];
    const a = { push: (h: string) => calls.push(`push ${h}`), refresh: () => calls.push('refresh'),
      setSend: (s: unknown) => calls.push(`send ${JSON.stringify(s)}`), signInReturn: '/invitations/abc' };
    handleFailure({ kind: 'signin' }, a);
    handleFailure({ kind: 'change-password' }, a);
    handleFailure({ kind: 'reload', text: 'M39' }, a);
    handleFailure({ kind: 'message', text: 'Worded' }, a);
    handleFailure({ kind: 'refused' }, a);
    expect(calls).toEqual(['push /login?callbackUrl=%2Finvitations%2Fabc', 'push /change-password', 'send {"state":"message","text":"M39"}', 'refresh',
      'send {"state":"message","text":"Worded"}', 'send {"state":"refused"}']);
  });

  it('FR-ACC-03 (threat A5): a 409 legal_text_changed reloads the page with the new text and shows M-39', () => {
    const m39 = 'A new version of the terms of service was published on 2 Dec 2026.';
    expect(recordOutcome(409, { error: m39, code: 'legal_text_changed', missing: ['terms'] })).toEqual({ kind: 'reload', text: m39 });
    expect(recordOutcome(204, null)).toEqual({ kind: 'recorded' });
  });

  it('UX-22 FR-ACC-03: three separate unticked boxes, each with version, date and a new-tab link that says so', () => {
    const markup = html(<AcceptancesForm texts={TEXTS} mode="required" userId="u-1" submitLabel="Accept and continue" onAccepted={vi.fn()} />);
    const boxes = markup.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(3);
    expect(boxes.filter((b) => /\bchecked\b/.test(b))).toEqual([]);
    for (const kind of ACCEPTED_KINDS) {
      const name = LEGAL_KIND_NAMES[kind];
      expect(markup).toMatch(new RegExp(`<a[^>]*href="/legal/${kind}/1"[^>]*target="_blank"[^>]*rel="noopener"[^>]*>Read the ${name}<span[^>]*> \\(opens in a new tab\\)</span></a>`));
    }
    expect(markup.match(/>Version 1, published 30 Oct 2026\.</g)).toHaveLength(3);
    expect(markup).toMatch(/<fieldset[^>]*><legend[^>]*><h1[^>]*>Before you continue<\/h1><\/legend><p[^>]*>Please read and accept each of these\. Each is separate; none is ticked for you\.<\/p>/);
  });

  it('UX-22 (W-11 note 2): each box carries its own sentence as its label', () => {
    const markup = view();
    for (const kind of ACCEPTED_KINDS) {
      // The label as React writes it into markup: the apostrophe is escaped, and no character of the label is a pattern.
      const label = ACCEPT_LABEL[kind].replace(/'/g, '&#x27;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(markup).toContain(`<label for="accept-${kind}"`);
      expect(markup).toMatch(new RegExp(`<label for="accept-${kind}"[^>]*>${label}</label>`));
    }
  });

  it('UX-22 M-25: a missing tick names the text, and the submit rule sends nothing until all are ticked', () => {
    expect(untickedKinds(TEXTS, new Set<AcceptedKind>(['terms']))).toEqual(['privacy', 'cross-border-consent']);
    expect(untickedKinds(TEXTS, new Set<AcceptedKind>(['terms', 'privacy', 'cross-border-consent']))).toEqual([]);
    // M-25's wording, "To continue, accept the <name>.", with each text's name from the names map.
    for (const kind of ACCEPTED_KINDS) expect(acceptanceError(kind)).toBe(`To continue, accept the ${LEGAL_KIND_NAMES[kind]}.`);
  });

  it('UX-22 M-25 NFR-A11Y-04: each missing box shows M-25 tied by aria-describedby and aria-invalid, under a role=alert summary', () => {
    const markup = view({ ticked: new Set<AcceptedKind>(['terms']), errors: ['privacy', 'cross-border-consent'] });
    expect(markup).toMatch(new RegExp(`<div[^>]*role="alert"[^>]*>.*${escapeRe(acceptanceError('privacy'))}.*${escapeRe(acceptanceError('cross-border-consent'))}.*</div>`));
    for (const kind of ['privacy', 'cross-border-consent']) {
      const box = tagOf(markup, `accept-${kind}`);
      expect(box).toContain('aria-invalid="true"');
      expect(box).toMatch(new RegExp(`aria-describedby="[^"]*\\baccept-${kind}-error\\b[^"]*"`));
      expect(tagOf(markup, `accept-${kind}-error`)).not.toBe('');
    }
    expect(tagOf(markup, 'accept-terms')).not.toContain('aria-invalid="true"');
    expect(tagOf(markup, 'accept-terms')).toMatch(/\bchecked\b/);
    expect(markup).not.toContain('accept-terms-error');
  });

  it('UX-22: with nothing missing there is no alert and no box is invalid', () => {
    const markup = view();
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it('FR-ACC-04 (W-11 note 3): required mode offers deletion or sign-out; invitation mode says nothing was created; offer mode has Not now', () => {
    expect(view({ mode: 'required' })).toMatch(/If you do not want to accept, you can <a[^>]*href="\/account"[^>]*>delete your account<\/a> or <button[^>]*type="button"[^>]*>sign out<\/button>\./);
    expect(view({ mode: 'invitation', submitLabel: 'Create account' })).toContain('If you do not want to accept, close this page. Nothing has been created.');
    const offer = view({ mode: 'offer', texts: [{ ...TEXTS[1], version: '2', publishedOn: '2026-12-01', acceptance: 'offered' }] });
    expect(offer).toMatch(/<legend[^>]*><h1[^>]*>A new version of the privacy notice<\/h1><\/legend>/);
    // In the second step of S-04 the page has its own h1, so the legend is a level 2 heading.
    expect(view({ mode: 'invitation' })).toMatch(/<legend[^>]*><h2[^>]*>Before you continue<\/h2><\/legend>/);
    expect(offer).toMatch(/<button[^>]*type="button"[^>]*>Not now<\/button>/);
    // Full width by layout, with no number in the style (no workaround for PUB's percentage rule): a flex column stretches it.
    const notNow = offer.match(/<button[^>]*>Not now<\/button>/)?.[0] ?? '';
    expect(notNow).toMatch(/align-self:\s*stretch/);
    expect(notNow).not.toMatch(/(?<!-)width:/);   // min-width is the 24-pixel target, not a width
    expect(offer).toMatch(/<div[^>]*style="[^"]*display:\s*flex;[^"]*flex-direction:\s*column[^"]*"[^>]*><button[^>]*>Not now<\/button><\/div>/);
    expect(offer).toContain('Version 2, published 1 Dec 2026.');
  });

  it('NFR-A11Y-04 (SC 2.5.8, 3.3.8): every box and button is at least 24 by 24 CSS pixels, and nothing blocks pasting or autofill', () => {
    const markup = view({ mode: 'offer' });
    for (const tag of markup.match(/<(input|button)[^>]*>/g) ?? []) {
      expect(tag, tag).toMatch(/min-(height|block-size):\s*24px|height:\s*24px/);
      expect(tag, tag).toMatch(/min-(width|inline-size):\s*24px|width:\s*24px/);
    }
    expect(markup).not.toMatch(/onpaste|oncopy|autocomplete="off"/i);
  });

  it('UX-22: a busy form disables its submit button and keeps its label', () => {
    expect(view({ busy: true })).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Accept and continue<\/button>/);
  });
});
