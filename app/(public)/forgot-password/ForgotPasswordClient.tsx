'use client';

import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import Link from 'next/link';
import { AUTH_COPY, AUTH_MESSAGE_COPY, FORGOT_COPY } from '@/lib/auth/copy';
import { useHydrated } from '@/lib/client/useHydrated';
import { AuthCard } from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

export type ForgotState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * Asks route 33 for a reset link. Its answer is the same 202 for every address, so any 202 is "sent"; a lost connection
 * or another answer is an error the person can retry, with the address kept, each said as what it is.
 */
export async function requestResetLink(fetchImpl: typeof fetch, email: string): Promise<ForgotState> {
  try {
    const res = await fetchImpl('/api/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.status === 202 ? { kind: 'sent' } : { kind: 'error', message: FORGOT_COPY.serverProblem };
  } catch {
    // fetch rejects only when no answer came back (offline, a dropped connection).
    return { kind: 'error', message: FORGOT_COPY.notReached };
  }
}

export interface ForgotPasswordViewProps {
  email: string;
  state: ForgotState;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  /** The card's heading, which the client focuses when the sent answer replaces the form (given, it takes focus by script only). */
  headingRef?: Ref<HTMLHeadingElement>;
  onEmail: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/**
 * S-02's markup for a given state, in the gate frame's card (plan 1B Task 2): the heading and lead, the form with its error
 * line beside the button (spec 9.7), then the way back to S-01. Once sent, M-21 in its status region takes the form's
 * place (design review I-5).
 */
export function ForgotPasswordView(v: ForgotPasswordViewProps) {
  return (
    <AuthCard title={AUTH_COPY.resetHeading} titleRef={v.state.kind === 'sent' ? (v.headingRef ?? null) : undefined} lead={<p>{AUTH_COPY.forgotLead}</p>}
      footer={<p><Link href="/login">{AUTH_COPY.backToSignIn}</Link></p>}>
      <StatusRegion message={v.state.kind === 'sent' ? AUTH_MESSAGE_COPY.resetLinkSent : null} />
      {/* Once sent, M-21 replaces the form (design review I-5): no field to fill again, no button to press again. */}
      {v.state.kind === 'sent' ? null : (
      <form method="post" onSubmit={v.onSubmit}>
        <TextInput id="email" name="email" label={FORGOT_COPY.email} type="email" required autoComplete="username" spellCheck={false}
          value={v.email} onChange={(e) => v.onEmail(e.currentTarget.value)} />
        <Button variant="primary" type="submit" disabled={v.state.kind === 'sending' || v.hydrated === false}>{FORGOT_COPY.submit}</Button>
        <StatusRegion message={v.state.kind === 'error' ? v.state.message : null} politeness="assertive" tone="error" />
      </form>
      )}
    </AuthCard>
  );
}

/** S-02: one email field and **Send reset link**, then M-21. */
export function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<ForgotState>({ kind: 'idle' });
  const hydrated = useHydrated();
  const headingEl = useRef<HTMLHeadingElement>(null);
  // The Send reset link button leaves with the form: move focus to the card's heading, above the sent answer, instead of letting it fall to the body (WCAG 2.4.3); the status region is not the target, so a screen reader does not read M-21 twice.
  useEffect(() => { if (state.kind === 'sent') headingEl.current?.focus(); }, [state.kind]);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'sending' });
    setState(await requestResetLink(fetch, email));
  }
  return <ForgotPasswordView email={email} state={state} hydrated={hydrated} headingRef={headingEl} onEmail={setEmail} onSubmit={onSubmit} />;
}
