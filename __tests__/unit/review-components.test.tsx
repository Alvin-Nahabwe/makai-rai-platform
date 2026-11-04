import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SealMarker } from '@/components/review/SealMarker';
import { SealNote } from '@/components/review/SealNote';
import { StageReviewsSummary } from '@/components/review/StageReviewsSummary';
import { StageSealBanner } from '@/components/review/StageSealBanner';
import type { SealView, StageReviewView } from '@/types/api';
import type { SealRef } from '@/types/seal';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { countStageDrafts, isDraftStorageEvent } from '@/components/review/SealConfirm';
import { DeviceDateTime, ReviewStateLine } from '@/components/review/DeviceTime';
import { DRAFT_PREFIX, draftKey, openDraftStore } from '@/lib/client/drafts';

/** The review slots of S-10, S-11, S-12 and S-15 (UX-31, FR-REV-05, FR-REV-01; contract "Screens and slots"). */

const ref = (sealNumber: number, reviewId: string, reviewName: string): SealRef => ({ sealId: `s-${reviewId}-${sealNumber}`, sealNumber, reviewId, reviewName });
const SEAL: SealView = {
  id: 's1', reviewId: 'r', sealNumber: 1, fingerprint: 'a'.repeat(64), sealedBy: { userId: 'u1', name: 'Grace A.', formerMember: false },
  sealedByRole: 'reviewer', sealedAt: '2026-11-02T07:42:00.000Z', contentSemver: '0.0.1-fixture', bytesMatch: true,
};
const VIEW_CHANGED: StageReviewView = {
  id: 'r', projectId: 'p', stage: 'pre-processing', numberInStage: 1, name: 'Pre-processing review 1', preparedFor: 'ethics submission',
  openedBy: { userId: 'u2', name: 'Amina N.', formerMember: false }, openedAt: '2026-10-30T08:00:00.000Z', latestSeal: SEAL,
  changedSinceLatestSeal: true, changed: { sealNumber: 1, changedQuestions: ['Q-PP-12', 'Q-PP-14'], changedFindings: [] }, preparedForErased: null,
  latestSealUnreadable: false,
};

describe('review slots', () => {
  it('UX-31: SealNote says before saving what saving will do, once per review, for the highest seal', () => {
    const html = renderToStaticMarkup(<SealNote seals={[ref(1, 'r1', 'Pre-processing review 1'), ref(2, 'r1', 'Pre-processing review 1')]} nextVersionNumber={3} />);
    expect(html).toContain('This decision is in seal 2. Saving makes version 3; seal 2 keeps version 2, and the review will show &quot;changed since seal 2&quot;.');
    expect(html.match(/This decision is in seal/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<SealNote seals={[]} nextVersionNumber={1} />)).toBe('');
  });

  it('UX-31: SealMarker marks each seal as In seal N of <review>', () => {
    const html = renderToStaticMarkup(<SealMarker seals={[ref(1, 'r1', 'Pre-processing review 1'), ref(1, 'r2', 'Pre-processing review 2')]} />);
    expect(html).toContain('In seal 1 of Pre-processing review 1'); expect(html).toContain('In seal 1 of Pre-processing review 2');
    expect(renderToStaticMarkup(<SealMarker seals={[]} />)).toBe('');
  });

  it('FR-REV-05 NFR-A11Y-05: StageSealBanner names the review, the seal and the changed count in text', () => {
    const html = renderToStaticMarkup(<StageSealBanner changed={{ sealNumber: 1, changedQuestions: ['Q-PP-12', 'Q-PP-14'], changedFindings: [] }} reviewHref="/orgs/o/projects/p/reviews/r" />);
    expect(html).toMatch(/changed since seal 1 in 2 questions\./); expect(html).toMatch(/<a [^>]*href="\/orgs\/o\/projects\/p\/reviews\/r"[^>]*>Open review<\/a>/);
    expect(renderToStaticMarkup(<StageSealBanner changed={{ sealNumber: 2, changedQuestions: ['Q-PP-12'], changedFindings: ['f1'] }} reviewHref={null} />))
      .toMatch(/changed since seal 2 in 1 question and 1 finding\./);
    expect(renderToStaticMarkup(<StageSealBanner changed={null} reviewHref={null} />)).toBe('');
  });

  it('FR-REV-01 FR-REV-05: StageReviewsSummary lists each review with its note and state, and offers Open a stage review only when allowed', () => {
    const html = renderToStaticMarkup(<StageReviewsSummary orgSlug="o" projectId="p" stage="pre-processing" reviews={[VIEW_CHANGED]} canOpen={true} />);
    expect(html).toContain('Pre-processing review 1'); expect(html).toContain('(ethics submission)'); expect(html).toContain('Changed since seal 1 (2).');
    expect(html).toMatch(/<a [^>]*href="\/orgs\/o\/projects\/p\/reviews\/r"[^>]*>Open review<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/orgs\/o\/projects\/p\/reviews\/new\?stage=pre-processing"[^>]*>Open a stage review<\/a>/);
    const erased = renderToStaticMarkup(<StageReviewsSummary orgSlug="o" projectId="p" stage="pre-processing" reviews={[{ ...VIEW_CHANGED, preparedFor: null, preparedForErased: { erasedOn: '2026-11-03' } }]} canOpen={false} />);
    expect(erased).toContain('(Prepared for: erased on 3 Nov 2026)');
  });

  it('FR-REV-01 (7.4.2 S-10): StageReviewsSummary says No stage review yet. for a stage with none', () => {
    const html = renderToStaticMarkup(<StageReviewsSummary orgSlug="o" projectId="p" stage="in-processing" reviews={[]} canOpen={false} />);
    expect(html).toContain('No stage review yet.'); expect(html).not.toContain('None yet.'); expect(html).not.toMatch(/>Open a stage review</);
  });

  it('NFR-SEC-11: hostile notes and titles render as text in every review component', () => {
    for (const h of HOSTILE_STRINGS) {
      const summary = renderToStaticMarkup(<StageReviewsSummary orgSlug="o" projectId="p" stage="pre-processing" reviews={[{ ...VIEW_CHANGED, preparedFor: h, name: h }]} canOpen={false} />);
      const marker = renderToStaticMarkup(<SealMarker seals={[ref(1, 'r1', h)]} />);
      for (const html of [summary, marker]) expect(html).not.toMatch(/<script|<img|href="javascript:/i);
    }
  });

  it('UX-18 (C4 SF-2): the S-17 draft count opens storage once, ignores the probe key, and two tabs cannot feed each other', () => {
    // A storage shared by two tabs: every write by one tab is delivered to the other's listener, as the browser does.
    const data = new Map<string, string>();
    let writes = 0;
    const tabs: Array<(key: string | null) => void> = [];
    const storageFor = (me: number): Storage => ({
      get length() { return data.size; },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { writes += 1; data.set(k, v); tabs.forEach((t, i) => { if (i !== me) t(k); }); },
      removeItem: (k: string) => { writes += 1; data.delete(k); tabs.forEach((t, i) => { if (i !== me) t(k); }); },
      clear: () => { data.clear(); },
    });
    const filter = { userId: 'u1', orgId: 'o1', projectId: 'p1', questionIds: ['Q-PP-01'] };
    let reads = 0;
    const stores = [0, 1].map((i) => openDraftStore(storageFor(i)));
    for (const [i, store] of stores.entries()) tabs[i] = (key) => { if (isDraftStorageEvent(key)) { reads += 1; countStageDrafts(store, new Date(), filter); } };
    const writesAfterOpen = writes;
    expect(isDraftStorageEvent(`${DRAFT_PREFIX}probe`)).toBe(false);
    expect(isDraftStorageEvent('theme')).toBe(false);
    expect(isDraftStorageEvent(null)).toBe(true);
    const key = draftKey({ userId: 'u1', orgId: 'o1', projectId: 'p1', target: { kind: 'question', questionId: 'Q-PP-01' } });
    expect(isDraftStorageEvent(key)).toBe(true);
    for (let i = 0; i < 5; i++) expect(countStageDrafts(stores[0], new Date(), filter)).toBe(0);
    expect(writes).toBe(writesAfterOpen);   // counting never writes
    storageFor(1).setItem(key, JSON.stringify({ baseVersionNumber: null, value: {}, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } }));
    expect(reads).toBe(1);                  // the other tab read once, and its read wrote nothing back
    expect(countStageDrafts(stores[0], new Date(), filter)).toBe(1);
    expect(countStageDrafts(null, new Date(), filter)).toBe(0);
  });

  it('7.5.8 (C4 CR-3): a seal time is a <time> element that the browser rewrites in the device zone, with the server text until then', () => {
    const at = '2026-11-02T07:42:00.000Z';
    const html = renderToStaticMarkup(<DeviceDateTime iso={at} form="dayTime" serverText="2 Nov 2026 07:42 UTC" />);
    expect(html).toBe('<time dateTime="2026-11-02T07:42:00.000Z">2 Nov 2026 07:42 UTC</time>');
    expect(renderToStaticMarkup(<ReviewStateLine view={VIEW_CHANGED} serverText="Changed since seal 1 (2)." />)).toBe('Changed since seal 1 (2).');
    expect(renderToStaticMarkup(<StageReviewsSummary orgSlug="o" projectId="p" stage="pre-processing" reviews={[VIEW_CHANGED]} canOpen={false} />)).toContain('Changed since seal 1 (2).');
  });
});
