import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REVIEW_COPY } from '@/lib/review/copy';
import { sealRequestRefusal } from '@/components/review/reviewText';
import { sealStepTexts, type SealStepState } from '@/lib/review/sealStep';
import { TERM_SEAL } from '@/lib/vocabulary/terms';
import { termPattern } from '@/lib/vocabulary/firstUse';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { SealStep } = await import('@/components/review/SealStep');

/** The seal step's markup per state (design G2): a control only where the state is one, a status line otherwise. */
const html = (state: SealStepState) => renderToStaticMarkup(<SealStep orgSlug="acme" projectId="p1" stage="pre-processing" state={state} />);
const C = REVIEW_COPY.sealStep;
/** Text as renderToStaticMarkup escapes it. */
const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('SealStep (design G2)', () => {
  it('hidden renders nothing', () => {
    expect(html({ kind: 'hidden' })).toBe('');
  });

  it('ask and open_and_seal are buttons with the design\'s words; seal is a link to the review\'s seal page', () => {
    expect(html({ kind: 'ask' })).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>(?:(?!</button>).)*${C.ask}`));
    expect(html({ kind: 'open_and_seal' })).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>(?:(?!</button>).)*${C.openAndSeal}`));
    const seal = html({ kind: 'seal', reviewId: 'r 1' });
    expect(seal).toContain('href="/orgs/acme/projects/p1/reviews/r%201/seal"');
    expect(seal).toContain(C.seal);
    expect(seal).not.toMatch(/<button(?![^>]*ui-term-tip__button)/);   // the (i) toggletip is the only button
  });

  it('waiting and sealed are status lines with no control', () => {
    for (const [state, words] of [[{ kind: 'waiting', reviewId: 'r1' }, C.waiting], [{ kind: 'sealed' }, C.sealed]] as const) {
      const h = html(state);
      expect(h).toContain(words);
      expect(h).not.toMatch(/<a |<button(?![^>]*ui-term-tip__button)/);   // the (i) toggletip is a button, not a control of the step
    }
  });

  it('a refused request says what happened and names the button pressed; only a server problem is worth pressing again', () => {
    const r = (status: number, code: string, retryAfterSeconds?: number, error = '') => sealRequestRefusal({ status, body: { code, error, retryAfterSeconds } }, C.ask);
    expect(r(401, 'unauthenticated')).toEqual({ message: REVIEW_COPY.open.signedOut, retry: false, refresh: false });
    expect(r(429, 'rate_limited', 120)).toEqual({ message: REVIEW_COPY.open.rateLimited(REVIEW_COPY.waitMany(2)), retry: false, refresh: false });
    expect(r(409, 'project_archived')).toEqual({ message: REVIEW_COPY.open.archived, retry: false, refresh: false });
    expect(r(403, 'forbidden')).toEqual({ message: REVIEW_COPY.open.roleChanged, retry: false, refresh: false });
    expect(r(500, 'internal')).toEqual({ message: C.server(C.ask), retry: true, refresh: false });
    expect(C.lost(C.openAndSeal)).toContain(`Select ${C.openAndSeal} again.`);
  });

  it('fix round 1 (Minor 3): a refusal that is not a fault says its own message, as the decision form does; with none, the server line', () => {
    const r = (status: number, code: string, error: string) => sealRequestRefusal({ status, body: { code, error } }, C.ask);
    expect(r(422, 'invalid', 'Choose a stage.')).toEqual({ message: 'Choose a stage.', retry: false, refresh: false });
    expect(r(409, 'request_id_reused', 'This request id was used for a different request.')).toEqual({ message: 'This request id was used for a different request.', retry: false, refresh: false });
    expect(r(404, 'not_found', 'Not found.')).toEqual({ message: 'Not found.', retry: false, refresh: false });
    expect(r(403, 'something_else', 'You cannot do that here.').message).toBe('You cannot do that here.');
    expect(r(409, 'conflict', '')).toEqual({ message: C.server(C.ask), retry: false, refresh: false });
    // A fault keeps the server line, whatever its message says.
    expect(r(500, 'internal', 'stack trace')).toEqual({ message: C.server(C.ask), retry: true, refresh: false });
  });

  it('fix round 1 (Minor 4): a number another open took twice in a row is said, with the button to press again, and the page is not reloaded silently', () => {
    const r = sealRequestRefusal({ status: 409, body: { code: 'number_taken', error: '' } }, C.openAndSeal);
    expect(r).toEqual({ message: C.numberTaken(C.openAndSeal), retry: false, refresh: false });
    expect(r.message).toContain(`Select ${C.openAndSeal} again.`);
  });

  it('fix round 1 (Important 2): the first use of "seal" in each state is marked as the term and has its definition beside it, outside any button or link', () => {
    for (const state of [{ kind: 'ask' }, { kind: 'open_and_seal' }, { kind: 'seal', reviewId: 'r1' }, { kind: 'waiting', reviewId: 'r1' },
      { kind: 'damaged', action: 'seal', reviewId: 'r1' }, { kind: 'damaged', action: 'ask', reviewId: 'r1' }, { kind: 'damaged', action: 'none', reviewId: 'r1' }] as SealStepState[]) {
      const h = html(state);
      // Every state here uses the word (the unit's own matcher, case-insensitive), so it must carry the term and one tip.
      expect({ state, uses: sealStepTexts(state).some((t) => termPattern(TERM_SEAL.term).test(t)) }).toEqual({ state, uses: true });
      expect({ state, terms: h.match(/data-term="seal"/g)?.length ?? 0 }).toEqual({ state, terms: 1 });
      expect({ state, tips: h.match(/class="ui-term-tip"/g)?.length ?? 0 }).toEqual({ state, tips: 1 });
      expect(h).toContain(escape(TERM_SEAL.definition));
      expect(h).toContain(`aria-label="${escape(C.whatMeans(TERM_SEAL.term))}"`);
      // The tip is not inside the control, and both sit in one block (the vocabulary rule's "beside").
      expect(h).not.toMatch(/<(button|a)\b[^>]*>(?:(?!<\/(button|a)>)[\s\S])*class="ui-term-tip"/);
      expect(h).toMatch(/<p class="seal-step__line">(?:(?!<\/p>)[\s\S])*data-term="seal"(?:(?!<\/p>)[\s\S])*ui-term-tip/);
    }
    // "This stage is sealed." does not use the word "seal" (whole words): no term, no tip.
    expect(html({ kind: 'sealed' })).not.toMatch(/data-term|ui-term-tip/);
  });

  it('fix round 1 (Important 3): a damaged seal says the existing damage line first, never the waiting line; the control follows for a role that has one', () => {
    const damage = REVIEW_COPY.state.damaged;
    const seal = html({ kind: 'damaged', action: 'seal', reviewId: 'r 1' });
    expect(seal.indexOf(damage)).toBeGreaterThan(-1);
    expect(seal.indexOf(damage)).toBeLessThan(seal.indexOf(C.seal));
    expect(seal).toContain('href="/orgs/acme/projects/p1/reviews/r%201/seal"');
    const ask = html({ kind: 'damaged', action: 'ask', reviewId: 'r1' });
    expect(ask.indexOf(damage)).toBeGreaterThan(-1);
    expect(ask).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>(?:(?!</button>).)*${C.ask}`));
    expect(ask.indexOf(damage)).toBeLessThan(ask.indexOf(C.ask));
    const none = html({ kind: 'damaged', action: 'none', reviewId: 'r1' });
    expect(none).toContain(damage);
    expect(none).not.toMatch(/<a |<button(?![^>]*ui-term-tip__button)/);
    for (const h of [seal, ask, none]) expect(h).not.toContain(C.waiting);
  });
});
