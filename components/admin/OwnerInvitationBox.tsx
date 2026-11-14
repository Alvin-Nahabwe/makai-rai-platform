'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { FieldError, TextInput } from '@/components/ui/TextInput';
import { EMAIL_FAILED, emailFailedWords, invitationRefusal, resentWords } from '@/components/admin/CreateOrganisationForm';
import { MAX_REQUEST_REFERENCE } from '@/lib/admin/limits';
import { ADMIN_FORMS_COPY, INVITATION_STATE_WORDS } from '@/lib/admin/forms/copy';
import { useHydrated } from '@/lib/client/useHydrated';
import { formatDay } from '@/lib/format/dates';
import type { InvitationView, InviteMemberResponse } from '@/types/api';
import type { InvitationState } from '@/types/record';
import './AdminForms.css';

const I = ADMIN_FORMS_COPY.invitation;

/** W-10's four invitation states (SRS lines 2166-2210), in the words of the copy module (one map, read by S-23 too). */
export const STATE_WORDS: Readonly<Record<InvitationState, string>> = INVITATION_STATE_WORDS;

/** The sentence after a resend went through: 201 is a new invitation, 200 a replay of one already resent (C4 CR-1). */
export function resendWords(out: Extract<SendOutcome<InviteMemberResponse | undefined>, { kind: 'saved' }>): string {
  if (out.body === undefined) return `${I.resentPrefix} ${EMAIL_FAILED}`;
  return resentWords(out.body, out.status);
}
/** The sentence after "Send invitation" went through: sent, or the email-failed sentence true of the screen (answer Q21). */
export function issuedWords(r: InviteMemberResponse | undefined): string {
  return r && r.emailSent ? I.sent(r.invitation.email) : `${I.createdPrefix} ${r ? emailFailedWords(r.acceptUrl) : EMAIL_FAILED}`;
}
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Write = (url: string, body: Record<string, unknown> | null) => Promise<SendOutcome<InviteMemberResponse | undefined>>;

export type IssueInvitationFormViewProps = {
  formId: string; draft: { email: string; requestReference: string; showLink: boolean };
  errors: { email?: string; requestReference?: string }; busy: boolean;
  /** True while another of the box's requests is in flight: the submit is disabled, not busy (ruling L5-25). */
  unavailable?: boolean;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onDraft: (patch: Partial<{ email: string; requestReference: string; showLink: boolean }>) => void;
  onSubmit: () => void; onCancel: () => void;
  /** The email field, which takes focus when the form opens (ruling L5-14). */
  emailRef?: Ref<HTMLInputElement>;
};

/** The form that sends a new owner invitation (FR-ORG-01 recovery). */
export function IssueInvitationFormView({ emailRef, ...p }: IssueInvitationFormViewProps): ReactElement {
  return (
    <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <TextInput ref={emailRef} id={`${p.formId}-email`} name="email" type="email" label={I.emailLabel} error={p.errors.email} required
        autoComplete="off" spellCheck={false} value={p.draft.email} onChange={(e) => p.onDraft({ email: e.target.value })} />
      <TextInput id={`${p.formId}-requestReference`} name="requestReference" label={I.referenceLabel} error={p.errors.requestReference} required
        maxLength={MAX_REQUEST_REFERENCE} autoComplete="off" value={p.draft.requestReference} onChange={(e) => p.onDraft({ requestReference: e.target.value })} />
      <div className="admin-form__check">
        <Checkbox id={`${p.formId}-issue-show`} name="showLink" label={I.showLink} checked={p.draft.showLink} onChange={(e) => p.onDraft({ showLink: e.target.checked })} />
      </div>
      <div className="admin-form__actions">
        <Button variant="primary" type="submit" disabled={p.hydrated === false || p.unavailable === true} busy={p.busy}>{I.submit}</Button>
        <Button variant="secondary" onClick={p.onCancel}>{I.cancel}</Button>
      </div>
      {Object.keys(p.errors).length > 0 ? <FieldError id={`${p.formId}-check`} message={I.checkAbove} /> : null}
    </form>
  );
}

/**
 * S-24's owner invitation box (FR-ORG-02, FR-ACC-10; W-10 note 3). Every owner invitation with its state, and for a
 * pending one when its link expires; Resend (a new link, the old one stops working) and Cancel for the pending one;
 * "Send a new owner invitation" only when the organisation has no active Owner and none pending, with the reference of
 * the organisation's written request. The status region is mounted from the first render and the email-failure
 * sentence goes there, so it is announced; the link box is keyed by the invitation and told the sentence is shown
 * elsewhere (MEM's CopyLinkFallback).
 *
 * Focus (rulings X-4 and L5-14): it is never dropped to the page body. The cancel confirmation opens on its "Keep
 * invitation" button (it has no field) and "Keep invitation" gives focus back to "Cancel invitation"; the send form
 * opens on its email field and its Cancel gives focus back to "Send a new owner invitation". A pressed button stays,
 * busy, while its own request is in flight, and every other control that would start a write is disabled meanwhile
 * (ruling L5-25); when the answer arrives focus goes to the status line.
 */
export function OwnerInvitationBox({ orgId, hasActiveOwner, invitations, archived = false, write }: {
  orgId: string; hasActiveOwner: boolean; invitations: InvitationView[]; archived?: boolean; write?: Write;
}): ReactElement {
  const router = useRouter();
  const formId = useId();
  const hydrated = useHydrated();
  const [status, setStatus] = useState('');
  /** The request in flight, so only the button that sent it shows busy. */
  const [pressed, setPressed] = useState<'resend' | 'cancel' | 'send' | null>(null);
  const busy = pressed !== null;
  const [issued, setIssued] = useState<InviteMemberResponse | null>(null);
  // A replayed resend (200) keeps no link and may have had its email sent: it opens no link box (C4 CR-1).
  const [issuedReplayed, setIssuedReplayed] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [resendShowLink, setResendShowLink] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [draft, setDraft] = useState({ email: '', requestReference: '', showLink: false });
  const [errors, setErrors] = useState<{ email?: string; requestReference?: string }>({});
  const retry = useRef(new Map<string, RetryState>());
  const statusRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const sendTrigger = useRef<HTMLButtonElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  /** Where focus goes after the next render, once: the control a closed form or confirmation hands focus back to. */
  const focusNext = useRef<'cancel-trigger' | 'send-trigger' | null>(null);

  // SC 2.4.11: the refresh after a resend or an issue adds the new invitation's row some hundreds of milliseconds later,
  // above the buttons. By then focus may already be on a button near the bottom of the window (the revoke
  // confirmation's), which the browser left where it was because it was wholly in view; the row pushes it half below
  // the fold and nothing scrolls it back. So when the list changes while focus is inside the box, the focused element
  // is brought wholly into view, instantly, as DecisionForm.tsx does for its fields (the page's smooth scroll would
  // still be moving while the next key is pressed).
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && boxRef.current?.contains(focused)) focused.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [invitations]);

  // X-4: the confirmation has no field, so focus goes to its first button, "Keep invitation".
  useEffect(() => {
    if (confirmRevoke) confirmRef.current?.querySelector<HTMLButtonElement>('.ui-confirm__actions button')?.focus();
  }, [confirmRevoke]);

  // L5-14: the send form opens on its email field.
  useEffect(() => {
    if (issuing) emailField.current?.focus();
  }, [issuing]);

  // After the render that closed a form or a confirmation, focus goes back to the control that opened it.
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target === 'cancel-trigger' ? cancelTrigger : sendTrigger).current?.focus();
  });

  const base = `/api/admin/organisations/${encodeURIComponent(orgId)}/owner-invitations`;
  const doWrite: Write = write ?? ((url, body) => sendWrite<InviteMemberResponse | undefined>(url, 'POST', body ?? {}, { onSlow: () => setStatus(I.sending) }));
  // The page's list arrives with the next refresh; until then the box knows better what it has just done: an invitation
  // it resent or revoked is no longer pending, and the one it just issued or resent is.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const justIssued = issued !== null && issued.invitation.state === 'pending' && !gone.has(issued.invitation.id) ? issued.invitation : null;
  const pending = justIssued ?? invitations.find((i) => i.state === 'pending' && !gone.has(i.id)) ?? null;
  const mayIssue = !archived && !hasActiveOwner && pending === null;

  async function act(
    which: 'resend' | 'cancel' | 'send', url: string, body: Record<string, unknown> | null,
    done: (out: Extract<SendOutcome<InviteMemberResponse | undefined>, { kind: 'saved' }>) => string,
  ): Promise<boolean> {
    if (busy) return false;
    setPressed(which);
    setStatus(I.sending);
    try {
      const out = await doWrite(url, body);
      if (out.kind !== 'saved') {
        setStatus(invitationRefusal(out));
        return false;
      }
      setIssued(out.body ?? null);
      setIssuedReplayed(out.status === 200);
      setStatus(done(out));
      router.refresh();
      return true;
    } finally {
      setPressed(null);
      setTimeout(() => statusRef.current?.focus(), 0);
    }
  }

  async function resend(inv: InvitationView, showLink: boolean = resendShowLink): Promise<void> {
    const key = `resend:${inv.id}`;
    const body = { showLink };
    const { requestId, state } = requestIdFor(retry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    retry.current.set(key, state);
    if (await act('resend', `${base}/${encodeURIComponent(inv.id)}/resend`, { ...body, requestId }, resendWords)) {
      retry.current.delete(key);
      setGone((g) => new Set(g).add(inv.id));
    }
  }

  /** "Resend and show link" in the link box, for the invitation just issued or resent when its email failed with no link shown. */
  function resendIssuedWithLink(): void {
    if (issued !== null) void resend(issued.invitation, true);
  }

  async function revoke(inv: InvitationView): Promise<void> {
    // `issued` is cleared only once the revoke went through: a failed one keeps the box on the invitation it was
    // tracking, so it does not offer a new one beside a pending one (C4 CR-2).
    if (await act('cancel', `${base}/${encodeURIComponent(inv.id)}/revoke`, null, () => I.cancelled(inv.email))) {
      setIssued(null);
      setConfirmRevoke(false);
      setGone((g) => new Set(g).add(inv.id));
    }
  }

  async function issue(): Promise<void> {
    const e: typeof errors = {};
    if (!EMAIL_SHAPE.test(draft.email.trim())) e.email = I.emailMissing;
    if (draft.requestReference.trim() === '') e.requestReference = I.referenceMissing;
    else if (draft.requestReference.trim().length > MAX_REQUEST_REFERENCE) e.requestReference = I.tooLong(MAX_REQUEST_REFERENCE);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      document.getElementById(`${formId}-${Object.keys(e)[0]}`)?.focus();
      return;
    }
    const ok = await act('send', base, { email: draft.email.trim(), requestReference: draft.requestReference.trim(), showLink: draft.showLink }, (out) => issuedWords(out.body));
    if (ok) { setIssuing(false); setDraft({ email: '', requestReference: '', showLink: false }); }
  }

  return (
    <section ref={boxRef} aria-labelledby={`${formId}-heading`} className="admin-block">
      <h2 id={`${formId}-heading`}>{I.heading}</h2>
      <div role="status" tabIndex={-1} ref={statusRef} className="ui-status">{status}</div>
      {issued !== null && !issuedReplayed && (issued.acceptUrl !== null || !issued.emailSent) ? (
        <CopyLinkFallback key={issued.invitation.id} noticeShownElsewhere onResendWithLink={resendIssuedWithLink} acceptUrl={issued.acceptUrl} expiresAt={issued.invitation.expiresAt} emailSent={issued.emailSent} />
      ) : null}
      {invitations.length === 0 ? <p>{I.none}</p> : (
        <ul className="admin-invitations">
          {invitations.map((i) => (
            <li key={i.id}>
              {I.line(i.email, STATE_WORDS[i.state])}
              {i.state === 'pending' ? I.expires(formatDay(i.expiresAt, 'Africa/Kampala')) : null}
              {i.state === 'accepted' && i.createdFromShownLink ? <span>{I.copiedLink}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {archived ? <p>{I.archived}</p> : null}
      {pending !== null && !archived ? (
        <div className="admin-invitation__resend">
          <Checkbox id={`${formId}-resend-show`} name="showLink" label={I.showLink} checked={resendShowLink} onChange={(e) => setResendShowLink(e.target.checked)} />
          <div className="admin-form__actions">
            <Button variant="secondary" busy={pressed === 'resend'} disabled={busy && pressed !== 'resend'} aria-describedby={`${formId}-resend-hint`}
              onClick={() => { void resend(pending); }}>{I.resend}</Button>
            <span id={`${formId}-resend-hint`} className="admin-invitation__hint">{I.resendHint}</span>
            <Button ref={cancelTrigger} variant="secondary" disabled={busy && pressed !== 'cancel'} onClick={() => setConfirmRevoke(true)}>{I.cancelTrigger}</Button>
          </div>
          {confirmRevoke ? (
            <div ref={confirmRef}>
              <InlineConfirm objectName={I.confirmObject(pending.email)} consequence={I.confirmConsequence} destructive cancelLabel={I.keep}
                actionLabel={I.confirmAction} busy={pressed === 'cancel'} onConfirm={() => revoke(pending)}
                onCancel={() => { setConfirmRevoke(false); focusNext.current = 'cancel-trigger'; }} />
            </div>
          ) : null}
        </div>
      ) : null}
      {mayIssue && !issuing ? (
        <Button ref={sendTrigger} variant="primary" disabled={busy} onClick={() => setIssuing(true)}>{I.sendNew}</Button>
      ) : null}
      {mayIssue && issuing ? (
        <IssueInvitationFormView formId={formId} draft={draft} errors={errors} busy={pressed === 'send'} unavailable={busy && pressed !== 'send'}
          hydrated={hydrated} emailRef={emailField}
          onDraft={(patch) => setDraft((d) => ({ ...d, ...patch }))} onSubmit={() => { void issue(); }}
          onCancel={() => { setIssuing(false); setErrors({}); focusNext.current = 'send-trigger'; }} />
      ) : null}
    </section>
  );
}
