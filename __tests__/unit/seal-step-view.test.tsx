import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REVIEW_COPY } from '@/lib/review/copy';
import { sealRequestRefusal } from '@/components/review/reviewText';
import type { SealStepState } from '@/lib/review/sealStep';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { SealStep } = await import('@/components/review/SealStep');

/** The seal step's markup per state (design G2): a control only where the state is one, a status line otherwise. */
const html = (state: SealStepState) => renderToStaticMarkup(<SealStep orgSlug="acme" projectId="p1" stage="pre-processing" state={state} />);
const C = REVIEW_COPY.sealStep;

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
    expect(seal).not.toContain('<button');
  });

  it('waiting and sealed are status lines with no control', () => {
    for (const [state, words] of [[{ kind: 'waiting', reviewId: 'r1' }, C.waiting], [{ kind: 'sealed' }, C.sealed]] as const) {
      const h = html(state);
      expect(h).toContain(words);
      expect(h).not.toMatch(/<button|<a /);
    }
  });

  it('a refused request says what happened and names the button pressed; only a server problem is worth pressing again', () => {
    const r = (status: number, code: string, retryAfterSeconds?: number) => sealRequestRefusal({ status, body: { code, retryAfterSeconds } }, C.ask);
    expect(r(401, 'unauthenticated')).toEqual({ message: REVIEW_COPY.open.signedOut, retry: false, refresh: false });
    expect(r(429, 'rate_limited', 120)).toEqual({ message: REVIEW_COPY.open.rateLimited(REVIEW_COPY.waitMany(2)), retry: false, refresh: false });
    expect(r(409, 'project_archived')).toEqual({ message: REVIEW_COPY.open.archived, retry: false, refresh: false });
    expect(r(403, 'forbidden')).toEqual({ message: REVIEW_COPY.open.roleChanged, retry: false, refresh: false });
    expect(r(500, 'internal')).toEqual({ message: C.server(C.ask), retry: true, refresh: false });
    // A number another open took twice in a row: a review of the stage is open, so the page reloads and shows it.
    expect(r(409, 'number_taken')).toEqual({ message: '', retry: false, refresh: true });
    expect(C.lost(C.openAndSeal)).toContain(`Select ${C.openAndSeal} again.`);
  });
});
