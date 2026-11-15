'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { HOME_UNSAVED_COPY } from '@/lib/home/unsaved/copy';

/**
 * The sentence for this account's unsaved changes in this organisation, or null when there is nothing to say: no store
 * (storage absent or blocked; `openDraftStore` returns null and catches nothing more here) or no live draft. Never "0"
 * (defect 23: a blocked store must not read as "nothing unsaved"; it says nothing at all).
 */
export function unsavedSentence(store: DraftStore | null, userId: string, orgId: string, now: Date): string | null {
  if (store === null) return null;
  const n = store.count(userId, now, { orgId });
  return n === 0 ? null : HOME_UNSAVED_COPY.unsaved(n);
}

/**
 * Home's unsaved-changes line (spec 9.7 line 459; plan 1B Task 10): how many items this account has unsaved changes on in
 * this browser, for this organisation. Read once after mount, as the account page's drafts list reads it (the server and
 * the hydration pass render nothing, so the two agree; opening the store probes storage with a write, so it is not done
 * on every render). Storage is read through the draft store, which catches each storage call itself. Renders nothing
 * when the store is null or the count is 0. Words only: the drafts list with links is the account page's.
 */
export function HomeUnsavedLine({ userId, orgId }: { userId: string; orgId: string }): ReactElement | null {
  const [sentence, setSentence] = useState<string | null>(null);
  useEffect(() => {
    // localStorage exists only in the browser, after hydration: a one-shot read on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSentence(unsavedSentence(openDraftStore(), userId, orgId, new Date()));
  }, [userId, orgId]);
  return sentence === null ? null : <p className="home-unsaved">{sentence}</p>;
}
