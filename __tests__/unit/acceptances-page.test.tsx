import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AcceptedKind, LegalTextVersion } from '@/types/legal';

/**
 * S-05's server component (app/(gate)/acceptances/page.tsx). The registry is the stub of
 * __tests__/setup/legal.ts, whose texts are not empty, so a page that passed them on would show it.
 * The form links to the words on S-06 and posts only each text's kind and version, so the words must
 * stay out of the props that become the client payload (S-04 does the same: invitations/[token]/page.tsx).
 */
const identity = vi.hoisted(() => ({ userId: 'user-1' }));
const acceptances = vi.hoisted(() => ({ changes: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => identity }));
// Since plan 1B Task 7 the page reads acceptanceChanges (the texts not current, with the version accepted before).
vi.mock('@/lib/data/acceptances', () => ({ acceptanceChanges: acceptances.changes }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));

const Page = (await import('@/app/(gate)/acceptances/page')).default;
const { currentLegalText } = await import('@/lib/legal/registry');

type Change = { kind: AcceptedKind; current: LegalTextVersion; lastAccepted: string | null; state: 'missing' | 'offered' };
type ViewProps = { items: Change[]; mode: 'required' | 'offer'; userId: string };
const change = (kind: AcceptedKind, state: Change['state'], lastAccepted: string | null = null): Change =>
  ({ kind, current: currentLegalText(kind), lastAccepted, state });

/** The props the page gives AcceptancesView, the one element below its wrapper, with each text as `texts`. */
async function formProps(): Promise<ViewProps & { texts: LegalTextVersion[] }> {
  const wrapper = (await Page()) as ReactElement<{ children: ReactElement<ViewProps> }>;
  const props = wrapper.props.children.props;
  return { ...props, texts: props.items.map((i) => i.current) };
}

describe('acceptances page passes no legal words to the client (FR-ACC-03, NFR-PERF-02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mode required: every text keeps its kind and version and has empty words', async () => {
    acceptances.changes.mockResolvedValue([change('terms', 'missing'), change('privacy', 'missing'), change('cross-border-consent', 'offered', '1')]);
    expect(currentLegalText('terms').text).not.toBe('');   // the stub does hold words, so an empty one below is the page's doing
    const props = await formProps();
    expect(props.mode).toBe('required');
    expect(props.texts.map((t) => [t.kind, t.version])).toEqual([['terms', '1'], ['privacy', '1']]);
    for (const t of props.texts) expect(t.text).toBe('');
  });

  it('nothing to accept or to be offered: the page sends the person home (S-07)', async () => {
    acceptances.changes.mockResolvedValue([]);
    await expect(Page()).rejects.toThrow('REDIRECT /');
  });

  it('mode offer: the texts offered also carry no words', async () => {
    acceptances.changes.mockResolvedValue([change('cross-border-consent', 'offered', '1')]);
    const props = await formProps();
    expect(props.mode).toBe('offer');
    expect(props.texts).toHaveLength(1);
    for (const t of props.texts) expect(t.text).toBe('');
  });
});
