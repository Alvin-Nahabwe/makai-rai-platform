'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, signOut } from 'next-auth/react';
import type { OrgRole } from '@prisma/client';
import {
  AcceptancesForm, SendStatus, acceptancePairs, failureOutcome, handleFailure, recordOutcome, textsKey, type SendFailure, type SendState,
} from '@/components/legal/AcceptancesForm';
import { PASSWORD_MIN_LENGTH, validatePassword, validateString } from '@/lib/validate';
import type { AcceptedKind, LegalTextVersion } from '@/types/legal';
import { useHydrated } from '@/lib/client/useHydrated';

interface Props {
  token: string;
  invitedEmail: string;
  orgName: string;
  role: OrgRole;
  /** The inviting account's name (FR-MEM-01: shown on S-04, never in E-01). */
  inviterName: string;
  /** The signed-in visitor's email, fresh from the database (the page's module doc); null when signed out. */
  viewerEmail: string | null;
  /** The signed-in visitor's id, so the sign-out on the acceptances step clears this account's drafts (NFR-PRIV-06); null when signed out. */
  viewerUserId: string | null;
  /** The invitation's expiry day, `YYYY-MM-DD`. */
  expiresOn: string;
  /** The current version of each of the three texts (their words stay on the server; the form links S-06). */
  texts: LegalTextVersion[];
}

/** Where S-04 lands after an account is created or an invitation accepted (gap G033): S-08 with the welcome. */
export function welcomePath(orgSlug: string): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/dashboard?welcome=1`;
}

export type FieldErrors = { name?: string; password?: string };

/**
 * After route 31's 201: the welcome landing when the automatic sign-in worked; otherwise S-04 says the account exists,
 * with a link to sign in and land on the welcome. Pushing silently to /login would leave the person unsure whether the
 * account was made, and the used link now shows M-23.
 */
export function afterCreated(signedIn: boolean, orgSlug: string): { push: string } | { send: SendState } {
  if (signedIn) return { push: welcomePath(orgSlug) };
  return { send: { state: 'message', text: 'Your account was created. Sign in to continue.',
    link: { href: `/login?callbackUrl=${encodeURIComponent(welcomePath(orgSlug))}`, label: 'Sign in' } } };
}

/** Step 1's checks (7.4.2 row S-04: "Name required; password rules"), the same as route 31's. */
export function signUpErrors(name: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const n = validateString(name, 'Name', 100);
  if (n.error !== null || n.value.length === 0) errors.name = n.error?.message ?? 'Name is required';
  const p = validatePassword(password);
  if (p !== null) errors.password = p.message;
  return errors;
}

export type RegisterOutcome =
  | { kind: 'created'; orgSlug: string }
  | { kind: 'fields'; errors: FieldErrors }
  | SendFailure;

/** What S-04 does with route 31's answer. */
export function registerOutcome(status: number, body: unknown): RegisterOutcome {
  const b = (typeof body === 'object' && body !== null ? body : {}) as {
    orgSlug?: unknown; error?: unknown; code?: unknown; fields?: unknown; missing?: unknown;
  };
  if (status === 201 && typeof b.orgSlug === 'string') return { kind: 'created', orgSlug: b.orgSlug };
  if (status === 422 && Array.isArray(b.fields) && !Array.isArray(b.missing)) {
    const errors: FieldErrors = {};
    for (const f of b.fields as Array<{ field?: unknown; message?: unknown }>) {
      if ((f.field === 'name' || f.field === 'password') && typeof f.message === 'string') errors[f.field] = f.message;
    }
    if (Object.keys(errors).length > 0) return { kind: 'fields', errors };
  }
  return failureOutcome(status, body);
}

export type JoinOutcome =
  | { kind: 'joined'; orgSlug: string }
  | { kind: 'accept-first'; missing: AcceptedKind[] }
  | SendFailure;

/**
 * What S-04's signed-in branch does with route 32's answer. A 403 `acceptances_required` (a kind
 * missing, or a current version only offered, FR-ACC-03) shows the form for those kinds first.
 */
export function joinOutcome(status: number, body: unknown): JoinOutcome {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { orgSlug?: unknown; code?: unknown; missing?: unknown; error?: unknown };
  if (status === 200 && typeof b.orgSlug === 'string') return { kind: 'joined', orgSlug: b.orgSlug };
  if (status === 403 && b.code === 'acceptances_required' && Array.isArray(b.missing)) return { kind: 'accept-first', missing: b.missing as AcceptedKind[] };
  return failureOutcome(status, body);
}

export type { SendState };

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const FIELD_ERROR: CSSProperties = { margin: 'var(--space-1) 0 0', color: 'var(--color-risk-critical)', fontSize: 'var(--font-size-sm)' };
const HINT: CSSProperties = { margin: 'var(--space-1) 0 0', fontSize: 'var(--font-size-sm)' };

/**
 * Three branches by who is viewing (W-11): signed in as the invited email (one Accept invitation
 * action, which may first need the acceptances); signed in as another email (M-24 and Sign out);
 * signed out (create the account in two steps: details, then the three acceptances).
 */
export default function AcceptInvitationClient(p: Props) {
  if (p.viewerEmail !== null && p.viewerEmail.toLowerCase() === p.invitedEmail.toLowerCase()) {
    return <AcceptAsSignedIn token={p.token} texts={p.texts} userId={p.viewerUserId} />;
  }
  const returnTo = `/invitations/${p.token}`;
  if (p.viewerEmail !== null) {
    return (
      <div>
        <p className="auth-error" role="alert">
          You are signed in as {p.viewerEmail}, but this invitation is for {p.invitedEmail}. Sign out, then open the link again.
        </p>
        <button type="button" className="btn-primary" style={TARGET}
          onClick={() => signOut({ callbackUrl: returnTo })}>
          Sign out
        </button>
      </div>
    );
  }
  return <NewAccount {...p} />;
}

/** Signed in as the invited email: route 32; a 403 acceptances_required shows the missing texts first. */
function AcceptAsSignedIn({ token, texts, userId }: { token: string; texts: LegalTextVersion[]; userId: string | null }) {
  const router = useRouter();
  const [missing, setMissing] = useState<AcceptedKind[] | null>(null);
  const [send, setSend] = useState<SendState>({ state: 'idle' });
  const formStep = useRef<HTMLDivElement | null>(null);
  // What Try again repeats (C4 CR-4): the last send, route 30's body or the join, as NewAccount keeps lastBody.
  const lastAction = useRef<{ kind: 'record'; body: string } | { kind: 'join' }>({ kind: 'join' });
  // The button that was pressed is gone: move focus to what replaced it (WCAG 2.4.3).
  useEffect(() => { if (missing !== null) formStep.current?.focus(); }, [missing]);

  async function accept(): Promise<void> {
    lastAction.current = { kind: 'join' };
    setSend({ state: 'sending' });
    let res: Response;
    try {
      res = await fetch(`/api/v1/invitations/${encodeURIComponent(token)}`, { method: 'POST' });
    } catch {
      setSend({ state: 'lost' });   // no reply arrived
      return;
    }
    const outcome = joinOutcome(res.status, await res.json().catch(() => null));
    if (outcome.kind === 'joined') {
      router.push(welcomePath(outcome.orgSlug));
      return;
    }
    if (outcome.kind === 'accept-first') {
      setMissing(outcome.missing);
      setSend({ state: 'idle' });
      return;
    }
    handleFailure(outcome, { push: (h) => router.push(h), refresh: () => router.refresh(), setSend, signInReturn: `/invitations/${token}` });
  }

  async function acceptThenJoin(body: string): Promise<void> {
    lastAction.current = { kind: 'record', body };
    setSend({ state: 'sending' });
    let res: Response;
    try {
      res = await fetch('/api/acceptances', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch {
      setSend({ state: 'lost' });
      return;
    }
    const outcome = recordOutcome(res.status, await res.json().catch(() => null));
    if (outcome.kind !== 'recorded') {
      handleFailure(outcome, { push: (h) => router.push(h), refresh: () => router.refresh(), setSend, signInReturn: `/invitations/${token}` });
      return;
    }
    setMissing(null);
    await accept();
  }

  return (
    <div>
      {missing === null ? (
        <button type="button" className="btn-primary" style={TARGET} disabled={send.state === 'sending'} onClick={() => void accept()}>
          Accept invitation
        </button>
      ) : (
        <div id="acceptances-step" tabIndex={-1} ref={formStep}>
          <AcceptancesForm key={textsKey(texts)} texts={texts.filter((t) => missing.includes(t.kind as AcceptedKind))} mode="required" userId={userId ?? undefined}
            submitLabel="Accept and continue" busy={send.state === 'sending'}
            onAccepted={(kinds) => acceptThenJoin(JSON.stringify({ acceptances: acceptancePairs(texts, kinds) }))} />
        </div>
      )}
      <SendStatus send={send} sendingText="Saving..." onRetry={() => {
        const last = lastAction.current;
        void (last.kind === 'record' ? acceptThenJoin(last.body) : accept());
      }} />
    </div>
  );
}

export interface NewAccountViewProps extends Omit<Props, 'viewerUserId'> {
  step: 'details' | 'acceptances';
  name: string;
  password: string;
  showPassword: boolean;
  errors: FieldErrors;
  send: SendState;
  /** False until React has hydrated; the Continue button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onName: (v: string) => void;
  onPassword: (v: string) => void;
  onToggleShow: () => void;
  onContinue: (e: FormEvent<HTMLFormElement>) => void;
  onAccepted: (kinds: AcceptedKind[]) => Promise<void>;
  onRetry: () => void;
  /** Called with each input element, so the client can move focus to a field with an error. */
  nameInput?: (el: HTMLInputElement | null) => void;
  passwordInput?: (el: HTMLInputElement | null) => void;
  /** Called with step 2's region, so the client can move focus to it when it replaces step 1. */
  acceptancesStep?: (el: HTMLDivElement | null) => void;
}

/** The markup of the signed-out branch for a given state; `NewAccount` holds the state. */
export function NewAccountView(v: NewAccountViewProps) {
  const describedBy = (hint: string | null, error: string | null) => [hint, error].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      {v.step === 'details' ? (
        <form method="post" noValidate onSubmit={v.onContinue}>
          <h2>Create your account</h2>
          <label htmlFor="email">Email <span style={{ fontWeight: 'var(--font-weight-regular)' }}>(from the invitation; cannot be changed)</span></label>
          <input type="email" id="email" name="email" autoComplete="username" spellCheck={false} readOnly value={v.invitedEmail} />
          <label htmlFor="name">Your name</label>
          <input type="text" id="name" name="name" autoComplete="name" required value={v.name}
            onChange={(e) => v.onName(e.currentTarget.value)} aria-invalid={v.errors.name ? true : undefined}
            aria-describedby={describedBy(null, v.errors.name ? 'name-error' : null)} ref={(el) => v.nameInput?.(el)} />
          {v.errors.name && <p id="name-error" style={FIELD_ERROR}>{v.errors.name}</p>}
          <label htmlFor="new-password">Password</label>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input type={v.showPassword ? 'text' : 'password'} id="new-password" name="new-password" autoComplete="new-password" required
              value={v.password} onChange={(e) => v.onPassword(e.currentTarget.value)} aria-invalid={v.errors.password ? true : undefined}
              aria-describedby={describedBy('password-hint', v.errors.password ? 'password-error' : null)} ref={(el) => v.passwordInput?.(el)} />
            <button type="button" aria-pressed={v.showPassword} aria-controls="new-password" onClick={v.onToggleShow}
              style={{ ...TARGET, padding: '0 var(--space-2)' }}>
              Show
            </button>
          </div>
          <p id="password-hint" style={HINT}>{`At least ${PASSWORD_MIN_LENGTH} characters.`}</p>
          {v.errors.password && <p id="password-error" style={FIELD_ERROR}>{v.errors.password}</p>}
          <button type="submit" className="btn-primary" disabled={v.hydrated === false} style={TARGET}>Continue</button>
        </form>
      ) : (
        <div id="acceptances-step" tabIndex={-1} ref={(el) => v.acceptancesStep?.(el)}>
          <AcceptancesForm key={textsKey(v.texts)} texts={v.texts} mode="invitation" submitLabel="Create account" onAccepted={v.onAccepted}
            busy={v.send.state === 'sending'} />
        </div>
      )}
      <SendStatus send={v.send} sendingText="Creating your account..." onRetry={v.onRetry} />
      <p className="auth-footer">
        Already have an account with this email? <a href={`/login?callbackUrl=${encodeURIComponent(`/invitations/${v.token}`)}`}
          style={{ display: 'inline-block', minHeight: '24px' }}>Sign in to accept</a>
      </p>
    </div>
  );
}

/**
 * Signed out: step 1 takes the name and one password (the email is the invitation's, shown and
 * read-only); step 2 is the three acceptances, whose Create account posts route 31. On 201 the
 * person is signed in and lands on S-08 with the welcome. A lost reply says nothing was created
 * and Try again resends the same body.
 */
function NewAccount(p: Props) {
  const router = useRouter();
  const [step, setStep] = useState<'details' | 'acceptances'>('details');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [send, setSend] = useState<SendState>({ state: 'idle' });
  const hydrated = useHydrated();
  const lastBody = useRef<string | null>(null);
  const nameEl = useRef<HTMLInputElement | null>(null);
  const passwordEl = useRef<HTMLInputElement | null>(null);
  const stepEl = useRef<HTMLDivElement | null>(null);
  // Continue removes the step-1 form and its button: move focus to step 2 (WCAG 2.4.3). A 422 on a
  // field brings step 1 back: move focus to the field it names.
  useEffect(() => {
    if (step === 'acceptances') stepEl.current?.focus();
    else if (errors.name) nameEl.current?.focus();
    else if (errors.password) passwordEl.current?.focus();
  }, [step, errors]);

  function onContinue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const found = signUpErrors(name, password);
    setErrors(found);
    if (found.name) { nameEl.current?.focus(); return; }
    if (found.password) { passwordEl.current?.focus(); return; }
    setStep('acceptances');
  }

  async function post(body: string): Promise<void> {
    lastBody.current = body;
    setSend({ state: 'sending' });
    let res: Response;
    try {
      res = await fetch(`/api/v1/invitations/${encodeURIComponent(p.token)}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
    } catch {
      setSend({ state: 'lost' });   // no reply arrived
      return;
    }
    const outcome = registerOutcome(res.status, await res.json().catch(() => null));
    if (outcome.kind === 'created') {
      const signedIn = await signIn('credentials', { email: p.invitedEmail, password, redirect: false })
        .then((r) => r?.ok === true, () => false);
      const next = afterCreated(signedIn, outcome.orgSlug);
      if ('push' in next) router.push(next.push);
      else setSend(next.send);
      return;
    }
    if (outcome.kind === 'fields') {
      setErrors(outcome.errors);
      setStep('details');
      setSend({ state: 'idle' });
      return;
    }
    // A reload renders the newer text and the form starts unticked (its key changes).
    handleFailure(outcome, { push: (h) => router.push(h), refresh: () => router.refresh(), setSend, signInReturn: `/invitations/${p.token}` });
  }

  return (
    <NewAccountView {...p} step={step} name={name} password={password} showPassword={showPassword} errors={errors} send={send} hydrated={hydrated}
      onName={setName} onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onContinue={onContinue}
      onAccepted={(kinds) => post(JSON.stringify({ name, password, acceptances: acceptancePairs(p.texts, kinds) }))}
      onRetry={() => { if (lastBody.current !== null) void post(lastBody.current); }}
      nameInput={(el) => { nameEl.current = el; }} passwordInput={(el) => { passwordEl.current = el; }}
      acceptancesStep={(el) => { stepEl.current = el; }} />
  );
}
