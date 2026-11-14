'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { signOutClearingDrafts } from '@/lib/client/signOutClearingDrafts';
import { LEGAL_KIND_NAMES, acceptanceError, type AcceptancePair } from '@/lib/legal/kinds';
import { ACCEPT_LABEL, ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { formatDay } from '@/lib/format/dates';
import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextVersion } from '@/types/legal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { StatusRegion } from '@/components/ui/StatusRegion';

/**
 * S-05's form (FR-ACC-03, UX-22; W-11 notes 2 and 3, SRS lines 2229-2250): one unticked box per
 * text, each with its version, publication date and a link that opens the text (S-06) in a new
 * tab and says so. A press of the submit button with a box unticked sends nothing: each unticked
 * box gets its own error ("Tick this box to continue."), the kit's error summary at the top lists
 * them as M-25 ("Tick the box for the <name>."), and focus moves to the first unticked box. Used by S-05 (modes `required` and `offer`) and by S-04's
 * second step (mode `invitation`).
 */

interface AcceptancesFormBase {
  texts: LegalTextVersion[];
  submitLabel: string;
  /** Sends the accepted kinds and shows its own outcome; it should not reject. */
  onAccepted: (kinds: AcceptedKind[]) => Promise<void>;
  busy?: boolean;
}

/**
 * The signed-in account's id is what the **sign out** link of mode `required` clears from this device (NFR-PRIV-06), so
 * that mode cannot be rendered without it; the other modes show no sign out.
 */
type AcceptancesFormMode =
  | { mode: 'required'; userId: string }
  | { mode: 'offer' | 'invitation'; userId?: string };

export type AcceptancesFormProps = AcceptancesFormBase & AcceptancesFormMode;

/** The sentence each box carries as its label (W-11 note 2): signed with the legal texts, kept in the acceptances copy module. */
export { ACCEPT_LABEL };

function acceptedKindOf(text: LegalTextVersion): AcceptedKind {
  const kind = ACCEPTED_KINDS.find((k) => k === text.kind);
  // A programming error, not a state a person can reach: the organisation agreement is retired
  // and is not one of the accepted texts, so it is never offered here.
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

/** A refusal by route 30, 31 or 32, as S-04 and S-05 act on it. */
export type SendFailure =
  | { kind: 'signin' }
  | { kind: 'change-password' }
  | { kind: 'reload'; text: string }
  | { kind: 'message'; text: string; link?: { href: string; label: string } }
  | { kind: 'refused' };

/** The 429's `retryAfterSeconds` (contract error codes, rate_limited) in whole minutes rounded up, at least one. */
function retryAfterMinutes(retryAfterSeconds: unknown): number {
  return typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds / 60) : 1;
}

/**
 * Any answer the caller's own success cases did not take (C4 CR-5 / SFH-9): a 401 goes to sign in;
 * a 403 `must_change_password` (gate 2) to S-29; a 409 `legal_text_changed` reloads with M-39; a
 * 429 says how long to wait; any other 4xx with an `error` text shows that text; only a 5xx (or a
 * 4xx with no text) says the server had a problem. A lost connection never reaches here.
 */
export function failureOutcome(status: number, body: unknown): SendFailure {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; error?: unknown; retryAfterSeconds?: unknown };
  if (status === 401) return { kind: 'signin' };
  if (status === 403 && b.code === 'must_change_password') return { kind: 'change-password' };
  const changed = legalTextChanged(status, body);
  if (changed !== null) return { kind: 'reload', text: changed };
  if (status === 429) return { kind: 'message', text: ACCEPTANCES_COPY.rateLimited(retryAfterMinutes(b.retryAfterSeconds)) };
  if (status >= 400 && status < 500 && typeof b.error === 'string') return { kind: 'message', text: b.error };
  return { kind: 'refused' };
}

/** Acts on a refusal: a navigation, M-39 with a reload, a worded message, or the server-fault copy with Try again. */
export function handleFailure(f: SendFailure, a: {
  push: (href: string) => void; refresh: () => void; setSend: (s: SendState) => void; signInReturn: string;
}): void {
  switch (f.kind) {
    case 'signin': a.push(`/login?callbackUrl=${encodeURIComponent(a.signInReturn)}`); return;
    case 'change-password': a.push('/change-password'); return;
    case 'reload': a.setSend({ state: 'message', text: f.text }); a.refresh(); return;
    case 'message': a.setSend(f.link === undefined ? { state: 'message', text: f.text } : { state: 'message', text: f.text, link: f.link }); return;
    case 'refused': a.setSend({ state: 'refused' });
  }
}

export type RecordOutcome = { kind: 'recorded' } | SendFailure;

/** What S-05 (and S-04's signed-in branch) does with route 30's answer. */
export function recordOutcome(status: number, body: unknown): RecordOutcome {
  return status === 204 ? { kind: 'recorded' } : failureOutcome(status, body);
}

/** A key that changes with the versions shown, so a reload with a newer text starts the form unticked. */
export function textsKey(texts: readonly LegalTextVersion[]): string {
  return texts.map((t) => `${t.kind}@${t.version}`).join(',');
}

/** The texts whose box is unticked, in the order shown. */
export function untickedKinds(texts: readonly LegalTextVersion[], ticked: ReadonlySet<AcceptedKind>): AcceptedKind[] {
  return texts.map(acceptedKindOf).filter((k) => !ticked.has(k));
}

const HEADING: CSSProperties = { margin: 0 };
const FIELDSET: CSSProperties = { border: 0, padding: 0, margin: 0 };
const LEGEND: CSSProperties = { marginBottom: 'var(--space-2)', padding: 0 };
// Full width by layout: the button stretches in the flex column that holds it, so no width is written.
const FULL_WIDTH: CSSProperties = { display: 'flex', flexDirection: 'column' };
const LINK_TARGET: CSSProperties = { display: 'inline-block', minHeight: '24px' };
// "sign out" sits inside a sentence, so it stays a link-styled native button (it takes the colour the shell gives every link).
const LINK_AS_BUTTON: CSSProperties = {
  minWidth: '24px', minHeight: '24px', background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--color-link)',
  textDecoration: 'underline', cursor: 'pointer',
};

/** A send in flight or a failed one, on S-04 and S-05 alike (SRS 7.4.1 Saving; 7.4.2 row S-04 / S-05). */
export type SendState = { state: 'idle' } | { state: 'sending' } | { state: 'lost' } | { state: 'refused' }
  | { state: 'message'; text: string; link?: { href: string; label: string } };

/**
 * What S-04 and S-05 say about a send: the in-flight text in a status line; a send with no reply
 * (`lost`) or a server fault (`refused`) says nothing was created, with Try again; a refusal the
 * server worded (`message`) shows its words.
 */
export function SendStatus({ send, what, sendingText, onRetry }: { send: SendState; what: 'account' | 'choice'; sendingText: string; onRetry: () => void }) {
  const failure = send.state === 'lost' || send.state === 'refused' ? ACCEPTANCES_COPY.send[what][send.state]
    : send.state === 'message' ? send.text : null;
  return (
    <>
      <StatusRegion message={send.state === 'sending' ? sendingText : null} />
      <StatusRegion message={failure} politeness="assertive" tone="error" />
      {(send.state === 'lost' || send.state === 'refused') && <Button variant="secondary" onClick={onRetry}>{ACCEPTANCES_COPY.tryAgain}</Button>}
      {send.state === 'message' && send.link !== undefined && (
        <p style={{ margin: 'var(--space-2) 0 0' }}><a href={send.link.href} style={LINK_TARGET}>{send.link.label}</a></p>
      )}
    </>
  );
}

export type AcceptancesFormViewProps = Omit<AcceptancesFormBase, 'onAccepted'> & AcceptancesFormMode & {
  ticked: ReadonlySet<AcceptedKind>;
  errors: readonly AcceptedKind[];
  onToggle: (kind: AcceptedKind, checked: boolean) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
};

/** The markup of the form for a given state; `AcceptancesForm` holds the state. */
export function AcceptancesFormView(p: AcceptancesFormViewProps) {
  const names = p.texts.map((t) => LEGAL_KIND_NAMES[acceptedKindOf(t)]);
  const legend = p.mode === 'offer' ? ACCEPTANCES_COPY.offerLegend(names) : ACCEPTANCES_COPY.legend;
  return (
    <form method="post" noValidate onSubmit={p.onSubmit}>
      <ErrorSummary title={ACCEPTANCES_COPY.summaryTitle} errors={p.errors.map((kind) => ({ fieldId: `accept-${kind}`, message: acceptanceError(kind) }))} />
      <fieldset style={FIELDSET}>
        {/* On S-05 the legend is the page's heading (W-11); in S-04's second step the page already has one. */}
        <legend style={LEGEND}>
          {p.mode === 'invitation' ? <h2 style={HEADING}>{legend}</h2> : <h1 style={HEADING}>{legend}</h1>}
        </legend>
        <p>{ACCEPTANCES_COPY.lead}</p>
        <div className="consent-group">
          {p.texts.map((text) => {
            const kind = acceptedKindOf(text);
            const name = LEGAL_KIND_NAMES[kind];
            return (
              <Checkbox key={kind} id={`accept-${kind}`} name="acceptances" value={kind} label={ACCEPT_LABEL[kind]}
                checked={p.ticked.has(kind)} onChange={(e) => p.onToggle(kind, e.currentTarget.checked)}
                error={p.errors.includes(kind) ? ACCEPTANCES_COPY.tickThis : undefined}
                hint={(
                  <>
                    <span>{ACCEPTANCES_COPY.version(text.version, formatDay(text.publishedOn))}</span>{' '}
                    <a href={`/legal/${kind}/${text.version}`} target="_blank" rel="noopener" style={LINK_TARGET}>
                      {ACCEPTANCES_COPY.readLink(name)}<span>{' '}{ACCEPTANCES_COPY.opensInNewTab}</span>
                    </a>
                  </>
                )} />
            );
          })}
        </div>
      </fieldset>
      <div style={{ marginTop: 'var(--space-6)' }}>
        <Button variant="primary" type="submit" disabled={p.busy}>{p.submitLabel}</Button>
      </div>
      {p.mode === 'required' && (
        <p style={{ marginTop: 'var(--space-4)' }}>
          {ACCEPTANCES_COPY.alternativesBefore}<a href="/account" style={LINK_TARGET}>{ACCEPTANCES_COPY.deleteAccount}</a>{ACCEPTANCES_COPY.alternativesOr}
          <button type="button" style={LINK_AS_BUTTON} onClick={() => void signOutClearingDrafts(p.userId, '/login')}>{ACCEPTANCES_COPY.signOut}</button>.
        </p>
      )}
      {p.mode === 'invitation' && (
        <p style={{ marginTop: 'var(--space-4)' }}>{ACCEPTANCES_COPY.closePage}</p>
      )}
      {p.mode === 'offer' && (
        <div style={FULL_WIDTH}>
          <Button variant="secondary" onClick={() => window.history.back()}>{ACCEPTANCES_COPY.notNow}</Button>
        </div>
      )}
    </form>
  );
}

/** S-05's form with its state: which boxes are ticked, and which were unticked at the last press. */
export function AcceptancesForm(p: AcceptancesFormProps) {
  const [ticked, setTicked] = useState<ReadonlySet<AcceptedKind>>(() => new Set());
  const [errors, setErrors] = useState<readonly AcceptedKind[]>([]);

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
      // The kit's Checkbox holds its input; the box is found by its id (`accept-{kind}`, a fixed kind), and focus goes to the first unticked one as ever.
      e.currentTarget.querySelector<HTMLInputElement>(`#accept-${unticked[0]}`)?.focus();
      return;
    }
    // onAccepted shows its own failures (RecordAcceptances, S-04); a rejection reaching here is a bug, so it is logged.
    p.onAccepted(p.texts.map(acceptedKindOf)).catch((err: unknown) => console.error('acceptances: onAccepted rejected', err));
  }

  return (
    <AcceptancesFormView {...p} ticked={ticked} errors={errors} onToggle={onToggle} onSubmit={onSubmit} />
  );
}
