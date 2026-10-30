'use client';

import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { LEGAL_KIND_NAMES, acceptanceError, type AcceptancePair } from '@/lib/legal/kinds';
import { formatDay } from '@/lib/format/dates';
import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextVersion } from '@/types/legal';

/**
 * S-05's form (FR-ACC-03, UX-22; W-11 notes 2 and 3, SRS lines 2229-2250): one unticked box per
 * text, each with its version, publication date and a link that opens the text (S-06) in a new
 * tab and says so. A press of the submit button with a box unticked sends nothing: each unticked
 * box gets M-25 ("To continue, accept the <name>."), a summary with role="alert" lists them, and
 * focus moves to the first unticked box. Used by S-05 (modes `required` and `offer`) and by S-04's
 * second step (mode `invitation`).
 */

export interface AcceptancesFormProps {
  texts: LegalTextVersion[];
  mode: 'required' | 'offer' | 'invitation';
  submitLabel: string;
  /** Sends the accepted kinds and shows its own outcome; it should not reject. */
  onAccepted: (kinds: AcceptedKind[]) => Promise<void>;
  busy?: boolean;
}

/** The sentence each box carries as its label (W-11 note 2). */
const ACCEPT_LABEL: Record<AcceptedKind, string> = {
  terms: 'I accept the terms of service.',
  privacy: 'I have read the privacy notice.',
  'cross-border-consent': 'I agree that my account and my team\'s records are stored and processed outside my country, as the cross-border storage consent describes.',
};

function acceptedKindOf(text: LegalTextVersion): AcceptedKind {
  const kind = ACCEPTED_KINDS.find((k) => k === text.kind);
  // A programming error, not a state a person can reach: the organisation agreement is recorded by
  // the administrator (FR-ORG-05) and is never offered here.
  if (kind === undefined) throw new TypeError(`not an accepted kind: ${text.kind}`);
  return kind;
}

/** M-25 for one text (SRS 7.5.7); written once, in lib/legal/kinds.ts. */
export { acceptanceError };

/**
 * What S-04 and S-05 post for the ticked kinds: each with the version the page rendered, so an
 * acceptance records the text the person was shown (threat A5; routes 30 and 31 refuse any other).
 */
export function acceptancePairs(texts: readonly LegalTextVersion[], kinds: readonly AcceptedKind[]): AcceptancePair[] {
  return kinds.map((kind) => {
    const shown = texts.find((t) => t.kind === kind);
    // A programming error: the form offers a box only for a text it shows.
    if (shown === undefined) throw new TypeError(`no text shown for ${kind}`);
    return { kind, version: shown.version };
  });
}

/** M-39's sentence when routes 30 or 31 refuse a version that is no longer current (409 `legal_text_changed`); else null. */
export function legalTextChanged(status: number, body: unknown): string | null {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; error?: unknown };
  return status === 409 && b.code === 'legal_text_changed' && typeof b.error === 'string' ? b.error : null;
}

export type RecordOutcome = { kind: 'recorded' } | { kind: 'signin' } | { kind: 'reload'; text: string } | { kind: 'refused' };

/** What S-05 (and S-04's signed-in branch) does with route 30's answer. */
export function recordOutcome(status: number, body: unknown): RecordOutcome {
  if (status === 204) return { kind: 'recorded' };
  if (status === 401) return { kind: 'signin' };
  const changed = legalTextChanged(status, body);
  if (changed !== null) return { kind: 'reload', text: changed };
  return { kind: 'refused' };
}

/** A key that changes with the versions shown, so a reload with a newer text starts the form unticked. */
export function textsKey(texts: readonly LegalTextVersion[]): string {
  return texts.map((t) => `${t.kind}@${t.version}`).join(',');
}

/** The texts whose box is unticked, in the order shown. */
export function untickedKinds(texts: readonly LegalTextVersion[], ticked: ReadonlySet<AcceptedKind>): AcceptedKind[] {
  return texts.map(acceptedKindOf).filter((k) => !ticked.has(k));
}

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** At least 24 by 24 CSS pixels (NFR-A11Y-04, SC 2.5.8). */
const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const BOX: CSSProperties = { ...TARGET, width: '24px', height: '24px', margin: 0, flexShrink: 0, accentColor: 'var(--color-primary)' };
const HEADING: CSSProperties = { margin: 0, fontSize: 'var(--font-size-xl)' };
const ROW: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' };
const SECONDARY: CSSProperties = {
  ...TARGET, width: '100%', marginTop: 'var(--space-3)', padding: 'var(--space-3) var(--space-6)', background: 'transparent',
  border: '2px solid var(--color-primary)', color: 'var(--color-primary)', font: 'inherit', fontWeight: 'var(--font-weight-semibold)', cursor: 'pointer',
};
const LINK_AS_BUTTON: CSSProperties = {
  ...TARGET, background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--color-primary)',
  textDecoration: 'underline', cursor: 'pointer',
};

/** A send in flight or a failed one, on S-04 and S-05 alike (SRS 7.4.1 Saving; 7.4.2 row S-04 / S-05). */
export type SendState = { state: 'idle' } | { state: 'sending' } | { state: 'lost' } | { state: 'refused' } | { state: 'message'; text: string };

/**
 * What S-04 and S-05 say about a send: the in-flight text in a status line; a send with no reply
 * (`lost`) or a server fault (`refused`) says nothing was created, with Try again; a refusal the
 * server worded (`message`) shows its words.
 */
export function SendStatus({ send, sendingText, onRetry }: { send: SendState; sendingText: string; onRetry: () => void }) {
  return (
    <>
      <p role="status" style={{ marginTop: 'var(--space-3)' }}>{send.state === 'sending' ? sendingText : ''}</p>
      {(send.state === 'lost' || send.state === 'refused') && (
        <div role="alert" className="auth-error">
          {send.state === 'lost' ? 'Not created: connection lost. Nothing was created. ' : 'Not created: the server had a problem. Nothing was created. '}
          <button type="button" style={{ ...LINK_AS_BUTTON, color: 'inherit' }} onClick={onRetry}>Try again</button>
        </div>
      )}
      {send.state === 'message' && <div role="alert" className="auth-error">{send.text}</div>}
    </>
  );
}

export interface AcceptancesFormViewProps extends Omit<AcceptancesFormProps, 'onAccepted'> {
  ticked: ReadonlySet<AcceptedKind>;
  errors: readonly AcceptedKind[];
  onToggle: (kind: AcceptedKind, checked: boolean) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  boxRef?: (kind: AcceptedKind, el: HTMLInputElement | null) => void;
}

/** The markup of the form for a given state; `AcceptancesForm` holds the state. */
export function AcceptancesFormView(p: AcceptancesFormViewProps) {
  const names = p.texts.map((t) => LEGAL_KIND_NAMES[acceptedKindOf(t)]);
  const legend = p.mode === 'offer' ? `A new version of the ${listOf(names)}` : 'Before you continue';
  return (
    <form noValidate onSubmit={p.onSubmit} aria-describedby={p.errors.length > 0 ? 'acceptances-errors' : undefined}>
      {p.errors.length > 0 && (
        <div id="acceptances-errors" role="alert" className="auth-error">
          <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            {p.errors.map((kind) => (
              <li key={kind}><a href={`#accept-${kind}`} style={{ color: 'inherit' }}>{acceptanceError(kind)}</a></li>
            ))}
          </ul>
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        {/* On S-05 the legend is the page's heading (W-11); in S-04's second step the page already has one. */}
        <legend style={{ marginBottom: 'var(--space-2)' }}>
          {p.mode === 'invitation' ? <h2 style={HEADING}>{legend}</h2> : <h1 style={HEADING}>{legend}</h1>}
        </legend>
        <p>Please read and accept each of these. Each is separate; none is ticked for you.</p>
        <div className="consent-group">
          {p.texts.map((text) => {
            const kind = acceptedKindOf(text);
            const name = LEGAL_KIND_NAMES[kind];
            const invalid = p.errors.includes(kind);
            const describedBy = [`accept-${kind}-meta`, invalid ? `accept-${kind}-error` : null].filter(Boolean).join(' ');
            return (
              <div key={kind}>
                <div style={ROW}>
                  <input type="checkbox" id={`accept-${kind}`} name="acceptances" value={kind} style={BOX}
                    checked={p.ticked.has(kind)} onChange={(e) => p.onToggle(kind, e.currentTarget.checked)}
                    aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
                    ref={p.boxRef === undefined ? undefined : (el) => p.boxRef?.(kind, el)} />
                  <label htmlFor={`accept-${kind}`} style={{ margin: 0, fontWeight: 'var(--font-weight-regular)' }}>{ACCEPT_LABEL[kind]}</label>
                </div>
                <p id={`accept-${kind}-meta`} style={{ margin: 'var(--space-1) 0 0 calc(24px + var(--space-3))', fontSize: 'var(--font-size-sm)' }}>
                  <span>{`Version ${text.version}, published ${formatDay(text.publishedOn)}.`}</span>{' '}
                  <a href={`/legal/${kind}/${text.version}`} target="_blank" rel="noopener" style={{ display: 'inline-block', minHeight: '24px' }}>
                    Read the {name}<span> (opens in a new tab)</span>
                  </a>
                </p>
                {invalid && (
                  <p id={`accept-${kind}-error`} className="field-error" style={{ margin: 'var(--space-1) 0 0 calc(24px + var(--space-3))', color: 'var(--color-risk-critical)', fontSize: 'var(--font-size-sm)' }}>
                    {acceptanceError(kind)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>
      <button type="submit" className="btn-primary" disabled={p.busy} style={{ ...TARGET, marginTop: 'var(--space-6)' }}>{p.submitLabel}</button>
      {p.mode === 'required' && (
        <p style={{ marginTop: 'var(--space-4)' }}>
          If you do not want to accept, you can <a href="/account" style={{ display: 'inline-block', minHeight: '24px' }}>delete your account</a> or{' '}
          <button type="button" style={LINK_AS_BUTTON} onClick={() => signOut({ callbackUrl: '/login' })}>sign out</button>.
        </p>
      )}
      {p.mode === 'invitation' && (
        <p style={{ marginTop: 'var(--space-4)' }}>If you do not want to accept, close this page. Nothing has been created.</p>
      )}
      {p.mode === 'offer' && (
        <button type="button" style={SECONDARY} onClick={() => window.history.back()}>Not now</button>
      )}
    </form>
  );
}

/** S-05's form with its state: which boxes are ticked, and which were unticked at the last press. */
export function AcceptancesForm(p: AcceptancesFormProps) {
  const [ticked, setTicked] = useState<ReadonlySet<AcceptedKind>>(() => new Set());
  const [errors, setErrors] = useState<readonly AcceptedKind[]>([]);
  const boxes = useRef(new Map<AcceptedKind, HTMLInputElement>());

  function onToggle(kind: AcceptedKind, checked: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(kind); else next.delete(kind);
      return next;
    });
    if (checked) setErrors((prev) => prev.filter((k) => k !== kind));
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (p.busy) return;
    const unticked = untickedKinds(p.texts, ticked);
    setErrors(unticked);
    if (unticked.length > 0) {
      boxes.current.get(unticked[0])?.focus();
      return;
    }
    // onAccepted shows its own failures (RecordAcceptances, S-04); a rejection reaching here is a bug, so it is logged.
    p.onAccepted(p.texts.map(acceptedKindOf)).catch((err: unknown) => console.error('acceptances: onAccepted rejected', err));
  }

  return (
    <AcceptancesFormView {...p} ticked={ticked} errors={errors} onToggle={onToggle} onSubmit={onSubmit}
      boxRef={(kind, el) => { if (el === null) boxes.current.delete(kind); else boxes.current.set(kind, el); }} />
  );
}

/**
 * S-05's body: posts the ticked kinds, each with the version shown, to route 30
 * (`/api/acceptances`) and, on 204, opens the home page (S-07), whose gate now lets the account
 * through. A send with no reply (fetch rejects) and a refusal each say that nothing was created,
 * with **Try again**, which re-sends the same body; a 401 (the session ended) goes to sign in and
 * back here; a 409 `legal_text_changed` shows M-39 and reloads the page with the newer text.
 */
export function RecordAcceptances({ texts, mode }: { texts: LegalTextVersion[]; mode: 'required' | 'offer' }) {
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
    } else if (outcome.kind === 'signin') {
      router.push('/login?callbackUrl=%2Facceptances');
    } else if (outcome.kind === 'reload') {
      setSend({ state: 'message', text: outcome.text });
      router.refresh();
    } else {
      setSend({ state: 'refused' });
    }
  }

  return (
    <>
      <AcceptancesForm key={textsKey(texts)} texts={texts} mode={mode} submitLabel="Accept and continue" busy={send.state === 'sending'}
        onAccepted={(kinds) => record(JSON.stringify({ acceptances: acceptancePairs(texts, kinds) }))} />
      <SendStatus send={send} sendingText="Saving..." onRetry={() => { if (sent.current !== null) void record(sent.current); }} />
    </>
  );
}
