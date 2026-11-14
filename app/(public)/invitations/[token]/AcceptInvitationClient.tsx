'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { OrgRole } from '@prisma/client';
import {
  AcceptancesForm, SendStatus, acceptancePairs, failureOutcome, handleFailure, recordOutcome, textsKey, useSignOutPress, type SendFailure,
  type SendState,
} from '@/components/legal/AcceptancesForm';
import { PASSWORD_MIN_LENGTH, validatePassword, validateString } from '@/lib/validate';
import type { AcceptedKind, LegalTextVersion } from '@/types/legal';
import { useHydrated } from '@/lib/client/useHydrated';
import { INVITATION_COPY } from '@/lib/invitations/copy';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

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
  return { send: { state: 'message', text: INVITATION_COPY.accountCreated,
    link: { href: `/login?callbackUrl=${encodeURIComponent(welcomePath(orgSlug))}`, label: INVITATION_COPY.signIn } } };
}

/** The sign-in library, loaded after route 31's 201 (ruling T16-Q11); a test passes its own. */
export type LoadSignIn = () => Promise<Pick<typeof import('next-auth/react'), 'signIn'>>;

/**
 * Only `signIn` is taken from the awaited import, so the bundler keeps the rest of next-auth/react out of the pages
 * that share it (a whole-module import() put SessionProvider and the rest into /login and /acceptances).
 */
async function loadSignIn(): ReturnType<LoadSignIn> {
  const { signIn } = await import('next-auth/react');
  return { signIn };
}

/**
 * The automatic sign-in after an account is created. next-auth/react is not in S-04's first visit (NFR-PERF-02): it is
 * loaded here, at the point of use. True only when the sign-in worked; a library that does not load, a sign-in that
 * rejects and one that is refused are all false, which `afterCreated` words as "Your account was created. Sign in to
 * continue." with its link, so no rejection escapes the send.
 */
export async function signInAfterCreated(email: string, password: string, load: LoadSignIn = loadSignIn): Promise<boolean> {
  return load()
    .then(({ signIn }) => signIn('credentials', { email, password, redirect: false }))
    .then((r) => r?.ok === true, () => false);
}

/** Step 1's checks (7.4.2 row S-04: "Name required; password rules"), the same as route 31's. */
export function signUpErrors(name: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const n = validateString(name, 'Name', 100, true, 'name');
  // An empty or blank name says "Enter your name." here and in route 31 (audit A 165, 272).
  if (n.value.length === 0) errors.name = INVITATION_COPY.nameRequired;
  else if (n.error !== null) errors.name = n.error.message;
  const p = validatePassword(password);
  if (p !== null) errors.password = p.message;
  return errors;
}

export type RegisterOutcome =
  | { kind: 'created'; orgSlug: string }
  | { kind: 'fields'; errors: FieldErrors }
  | SendFailure;

/** What S-04 does with route 31's answer; `token` is the invitation's, for the sign-in link a 409 `account_exists` carries. */
export function registerOutcome(status: number, body: unknown, token: string): RegisterOutcome {
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
  // An account for this email exists (audit A 270): the words are fixed here, matched on the status and the route's code, never on its text.
  if (status === 409 && b.code === 'account_exists') {
    return { kind: 'message', text: INVITATION_COPY.accountExists,
      link: { href: `/login?callbackUrl=${encodeURIComponent(`/invitations/${token}`)}`, label: INVITATION_COPY.signIn } };
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

/**
 * Three branches by who is viewing (W-11): signed in as the invited email (one Accept invitation
 * action, which may first need the acceptances); signed in as another email (M-24 and Sign out);
 * signed out (create the account in two steps: details, then the three acceptances).
 */
export default function AcceptInvitationClient(p: Props) {
  // The page resolves both from one identity, so they are null together.
  const viewer = p.viewerEmail !== null && p.viewerUserId !== null ? { email: p.viewerEmail, userId: p.viewerUserId } : null;
  if (viewer !== null && viewer.email.toLowerCase() === p.invitedEmail.toLowerCase()) {
    return <AcceptAsSignedIn token={p.token} texts={p.texts} userId={viewer.userId} />;
  }
  if (viewer !== null) {
    return <WrongAccount viewerEmail={viewer.email} viewerUserId={viewer.userId} invitedEmail={p.invitedEmail} returnTo={`/invitations/${p.token}`} />;
  }
  return <NewAccount {...p} />;
}

/**
 * Signed in as another email: M-24 and Sign out, which returns here signed out. The sign-out's code loads at the press
 * (ruling T16-Q11): the kit's busy state while it is carried out, and the failure line in an alert region directly under
 * the button. Its own component, because the branch above returns early and a hook cannot be called conditionally.
 */
function WrongAccount({ viewerEmail, viewerUserId, invitedEmail, returnTo }: { viewerEmail: string; viewerUserId: string; invitedEmail: string; returnTo: string }) {
  const signOut = useSignOutPress(viewerUserId, returnTo);
  return (
    <div>
      <StatusRegion politeness="assertive" tone="error" message={INVITATION_COPY.wrongAccount(viewerEmail, invitedEmail)} />
      <Button variant="primary" busy={signOut.busy} onClick={signOut.press}>
        {INVITATION_COPY.signOut}
      </Button>
      <StatusRegion politeness="assertive" tone="error" message={signOut.message} />
    </div>
  );
}

/** Signed in as the invited email: route 32; a 403 acceptances_required shows the missing texts first. */
function AcceptAsSignedIn({ token, texts, userId }: { token: string; texts: LegalTextVersion[]; userId: string }) {
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
        <Button variant="primary" disabled={send.state === 'sending'} onClick={() => void accept()}>
          {INVITATION_COPY.accept}
        </Button>
      ) : (
        <div id="acceptances-step" tabIndex={-1} ref={formStep}>
          <AcceptancesForm key={textsKey(texts)} texts={texts.filter((t) => missing.includes(t.kind as AcceptedKind))} mode="required" userId={userId}
            submitLabel={INVITATION_COPY.acceptAndContinue} busy={send.state === 'sending'}
            onAccepted={(kinds) => acceptThenJoin(JSON.stringify({ acceptances: acceptancePairs(texts, kinds) }))} />
        </div>
      )}
      <SendStatus send={send} what="choice" sendingText={INVITATION_COPY.saving} onRetry={() => {
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
  return (
    <div>
      {v.step === 'details' ? (
        <form method="post" noValidate onSubmit={v.onContinue}>
          <h2 style={{ margin: 'var(--space-6) 0 var(--space-4)' }}>{INVITATION_COPY.createHeading}</h2>
          <TextInput id="email" name="email" label={INVITATION_COPY.email} hint={INVITATION_COPY.emailHint} type="email" autoComplete="username"
            spellCheck={false} readOnly value={v.invitedEmail} />
          <TextInput id="name" name="name" label={INVITATION_COPY.name} hint={INVITATION_COPY.nameHint} required autoComplete="name"
            value={v.name} onChange={(e) => v.onName(e.currentTarget.value)} error={v.errors.name} ref={(el) => v.nameInput?.(el)} />
          <TextInput id="new-password" name="new-password" label={INVITATION_COPY.password} hint={INVITATION_COPY.passwordHint(PASSWORD_MIN_LENGTH)}
            type={v.showPassword ? 'text' : 'password'} required autoComplete="new-password" value={v.password}
            onChange={(e) => v.onPassword(e.currentTarget.value)} error={v.errors.password} ref={(el) => v.passwordInput?.(el)} />
          {/* The kit's Button cannot carry aria-pressed or aria-controls (ruling T16-5), so this is a native button in the kit's classes. */}
          <p style={{ margin: 'calc(-1 * var(--space-4)) 0 var(--space-6)' }}>
            <button type="button" className="ui-button ui-button--quiet ui-button--compact" aria-controls="new-password"
              aria-pressed={v.showPassword} onClick={v.onToggleShow}>{INVITATION_COPY.showPassword}</button>
          </p>
          <Button variant="primary" type="submit" disabled={v.hydrated === false}>{INVITATION_COPY.continue}</Button>
        </form>
      ) : (
        <div id="acceptances-step" tabIndex={-1} ref={(el) => v.acceptancesStep?.(el)}>
          <AcceptancesForm key={textsKey(v.texts)} texts={v.texts} mode="invitation" submitLabel={INVITATION_COPY.createAccount} onAccepted={v.onAccepted}
            busy={v.send.state === 'sending'} />
        </div>
      )}
      <SendStatus send={v.send} what="account" sendingText={INVITATION_COPY.creating} onRetry={v.onRetry} />
      <p className="auth-footer">
        {INVITATION_COPY.alreadyHave}{' '}<a href={`/login?callbackUrl=${encodeURIComponent(`/invitations/${v.token}`)}`}
          style={{ display: 'inline-block', minHeight: '24px' }}>{INVITATION_COPY.signInToAccept}</a>
      </p>
    </div>
  );
}

/**
 * Signed out: step 1 takes the name and one password (the email is the invitation's, shown and
 * read-only); step 2 is the three acceptances, whose Create account posts route 31. On 201 the
 * person is signed in and lands on S-08 with the welcome. A lost reply says the account may
 * already be created and Try again resends the same body.
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
    const outcome = registerOutcome(res.status, await res.json().catch(() => null), p.token);
    if (outcome.kind === 'created') {
      const signedIn = await signInAfterCreated(p.invitedEmail, password);
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
