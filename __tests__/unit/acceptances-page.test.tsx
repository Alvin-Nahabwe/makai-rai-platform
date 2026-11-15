import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { LegalTextVersion } from '@/types/legal';

/**
 * S-05's server component (app/(gate)/acceptances/page.tsx). The registry is the stub of
 * __tests__/setup/legal.ts, whose texts are not empty, so a page that passed them on would show it.
 * The form links to the words on S-06 and posts only each text's kind and version, so the words must
 * stay out of the props that become the client payload (S-04 does the same: invitations/[token]/page.tsx).
 */
const identity = vi.hoisted(() => ({ userId: 'user-1' }));
const acceptances = vi.hoisted(() => ({ missing: vi.fn(), offered: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => identity }));
vi.mock('@/lib/data/acceptances', () => ({ missingAcceptances: acceptances.missing, offeredAcceptances: acceptances.offered }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));

const Page = (await import('@/app/(gate)/acceptances/page')).default;
const { currentLegalText } = await import('@/lib/legal/registry');

type FormProps = { texts: LegalTextVersion[]; mode: 'required' | 'offer'; userId: string };

/** The props the page gives RecordAcceptances: the one element below its wrapper. */
async function formProps(): Promise<FormProps> {
  const wrapper = (await Page()) as ReactElement<{ children: ReactElement<FormProps> }>;
  return wrapper.props.children.props;
}

describe('acceptances page passes no legal words to the client (FR-ACC-03, NFR-PERF-02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mode required: every text keeps its kind and version and has empty words', async () => {
    acceptances.missing.mockResolvedValue(['terms', 'privacy']);
    expect(currentLegalText('terms').text).not.toBe('');   // the stub does hold words, so an empty one below is the page's doing
    const props = await formProps();
    expect(props.mode).toBe('required');
    expect(props.texts.map((t) => [t.kind, t.version])).toEqual([['terms', '1'], ['privacy', '1']]);
    for (const t of props.texts) expect(t.text).toBe('');
  });

  it('mode offer: the texts offered also carry no words', async () => {
    acceptances.missing.mockResolvedValue([]);
    acceptances.offered.mockResolvedValue([currentLegalText('cross-border-consent')]);
    const props = await formProps();
    expect(props.mode).toBe('offer');
    expect(props.texts).toHaveLength(1);
    for (const t of props.texts) expect(t.text).toBe('');
  });
});
