'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AcceptancesForm, SendStatus, acceptancePairs, handleFailure, recordOutcome, textsKey, type SendState } from '@/components/legal/AcceptancesForm';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import type { LegalTextVersion } from '@/types/legal';

/*
 * S-05's body, in a module of its own so that S-04, which shows the form but never records acceptances on their own,
 * does not download it (NFR-PERF-02: S-04's first visit counts every module of AcceptancesForm.tsx, used or not).
 */

/**
 * S-05's body: posts the ticked kinds, each with the version shown, to route 30
 * (`/api/acceptances`) and, on 204, opens the home page (S-07), whose gate now lets the account
 * through. A send with no reply (fetch rejects) and a server fault each say that the choice was
 * not saved, with **Try again**, which re-sends the same body; any other refusal is acted on by
 * `failureOutcome` (sign in and back here, S-29, M-39 with a reload, the wait, or its words).
 */
export function RecordAcceptances({ texts, mode, userId }: { texts: LegalTextVersion[]; mode: 'required' | 'offer'; userId: string }) {
  const router = useRouter();
  const [send, setSend] = useState<SendState>({ state: 'idle' });
  const sent = useRef<string | null>(null);

  async function record(body: string): Promise<void> {
    sent.current = body;
    setSend({ state: 'sending' });
    let res: Response;
    try {
      res = await fetch('/api/acceptances', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch {
      // fetch rejects only when no reply arrived: the person is told and can send again.
      setSend({ state: 'lost' });
      return;
    }
    const outcome = recordOutcome(res.status, await res.json().catch(() => null));
    if (outcome.kind === 'recorded') {
      router.push('/');
      // Offer mode: the shared (authenticated) layout, which renders the M-39 notice, does not re-render on a client-side
      // navigation, so it would keep the offer just accepted. A refresh re-reads it. Required mode has no notice to clear.
      if (mode === 'offer') router.refresh();
    }
    else handleFailure(outcome, { push: (h) => router.push(h), refresh: () => router.refresh(), setSend, signInReturn: '/acceptances' });
  }

  return (
    <>
      <AcceptancesForm key={textsKey(texts)} texts={texts} mode={mode} userId={userId} submitLabel={ACCEPTANCES_COPY.submit} busy={send.state === 'sending'}
        onAccepted={(kinds) => record(JSON.stringify({ acceptances: acceptancePairs(texts, kinds) }))} />
      <SendStatus send={send} what="choice" sendingText={ACCEPTANCES_COPY.saving} onRetry={() => { if (sent.current !== null) void record(sent.current); }} />
    </>
  );
}
