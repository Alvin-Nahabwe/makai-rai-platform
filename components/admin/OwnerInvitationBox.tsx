'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { EMAIL_FAILED, ERROR_STYLE, Field, HINT_STYLE, invitationRefusal } from '@/components/admin/CreateOrganisationForm';
import { formatDay } from '@/lib/format/dates';
import type { InvitationView, InviteMemberResponse } from '@/types/api';
import type { InvitationState } from '@/types/record';

/** W-10's four invitation states (SRS lines 2166-2210). */
export const STATE_WORDS: Readonly<Record<InvitationState, string>> = { pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked' };
const SENDING = 'Sending...';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Write = (url: string, body: Record<string, unknown> | null) => Promise<SendOutcome<InviteMemberResponse | undefined>>;

/**
 * S-24's first-owner invitation box (FR-ORG-02, FR-ACC-10; W-10 note 3). Every first-owner invitation with its state;
 * Resend (a new link, the old one stops working) and Revoke for the pending one; "Issue a new first-owner invitation"
 * only when the organisation has no active owner and none pending, with the reference of the controller's written
 * request. The status region is mounted from the first render and the email-failure sentence goes there, so it is
 * announced; the link box is keyed by the invitation and told the sentence is shown elsewhere (MEM's CopyLinkFallback).
 */
export function OwnerInvitationBox({ orgId, hasActiveOwner, invitations, write }: {
  orgId: string; hasActiveOwner: boolean; invitations: InvitationView[]; write?: Write;
}): ReactElement {
  const router = useRouter();
  const formId = useId();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<InviteMemberResponse | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [resendShowLink, setResendShowLink] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [draft, setDraft] = useState({ email: '', requestReference: '', showLink: false });
  const [errors, setErrors] = useState<{ email?: string; requestReference?: string }>({});
  const retry = useRef(new Map<string, RetryState>());
  const statusRef = useRef<HTMLDivElement>(null);

  const base = `/api/admin/organisations/${encodeURIComponent(orgId)}/owner-invitations`;
  const doWrite: Write = write ?? ((url, body) => sendWrite<InviteMemberResponse | undefined>(url, 'POST', body ?? {}, { onSlow: () => setStatus(SENDING) }));
  // The page's list arrives with the next refresh; until then the box knows better what it has just done: an invitation
  // it resent or revoked is no longer pending, and the one it just issued or resent is.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const justIssued = issued !== null && issued.invitation.state === 'pending' && !gone.has(issued.invitation.id) ? issued.invitation : null;
  const pending = justIssued ?? invitations.find((i) => i.state === 'pending' && !gone.has(i.id)) ?? null;
  const mayIssue = !hasActiveOwner && pending === null;

  async function act(url: string, body: Record<string, unknown> | null, done: (r: InviteMemberResponse | undefined) => string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setStatus(SENDING);
    try {
      const out = await doWrite(url, body);
      if (out.kind !== 'saved') {
        setStatus(invitationRefusal(out));
        return false;
      }
      setIssued(out.body ?? null);
      setStatus(done(out.body));
      router.refresh();
      return true;
    } finally {
      setBusy(false);
      setTimeout(() => statusRef.current?.focus(), 0);
    }
  }
  const sentWords = (r: InviteMemberResponse | undefined) => (r && r.emailSent ? `Invitation sent to ${r.invitation.email}.` : EMAIL_FAILED);

  async function resend(inv: InvitationView, showLink: boolean = resendShowLink): Promise<void> {
    const key = `resend:${inv.id}`;
    const body = { showLink };
    const { requestId, state } = requestIdFor(retry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    retry.current.set(key, state);
    if (await act(`${base}/${encodeURIComponent(inv.id)}/resend`, { ...body, requestId }, (r) => `Resent: the old link no longer works. ${sentWords(r)}`)) {
      retry.current.delete(key);
      setGone((g) => new Set(g).add(inv.id));
    }
  }

  /** "Resend and show link" in the link box, for the invitation just issued or resent when its email failed with no link shown. */
  function resendIssuedWithLink(): void {
    if (issued !== null) void resend(issued.invitation, true);
  }

  async function revoke(inv: InvitationView): Promise<void> {
    setIssued(null);
    if (await act(`${base}/${encodeURIComponent(inv.id)}/revoke`, null, () => `Revoked. The invitation to ${inv.email} no longer works.`)) {
      setConfirmRevoke(false);
      setGone((g) => new Set(g).add(inv.id));
    }
  }

  async function issue(): Promise<void> {
    const e: typeof errors = {};
    if (!EMAIL_SHAPE.test(draft.email.trim())) e.email = 'Enter the new first owner\'s email address.';
    if (draft.requestReference.trim() === '') e.requestReference = 'Enter the reference of the controller\'s written request.';
    else if (draft.requestReference.trim().length > 200) e.requestReference = 'Use 200 characters or fewer.';
    setErrors(e);
    if (Object.keys(e).length > 0) {
      document.getElementById(`${formId}-${Object.keys(e)[0]}`)?.focus();
      return;
    }
    const ok = await act(base, { email: draft.email.trim(), requestReference: draft.requestReference.trim(), showLink: draft.showLink }, (r) => `Issued. ${sentWords(r)}`);
    if (ok) { setIssuing(false); setDraft({ email: '', requestReference: '', showLink: false }); }
  }

  return (
    <section aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`}>First-owner invitation</h2>
      <div role="status" tabIndex={-1} ref={statusRef}>{status}</div>
      {issued !== null && (issued.acceptUrl !== null || !issued.emailSent) ? (
        <CopyLinkFallback key={issued.invitation.id} noticeShownElsewhere onResendWithLink={resendIssuedWithLink} acceptUrl={issued.acceptUrl} expiresAt={issued.invitation.expiresAt} emailSent={issued.emailSent} />
      ) : null}
      {invitations.length === 0 ? <p>No first-owner invitation has been issued.</p> : (
        <ul>
          {invitations.map((i) => (
            <li key={i.id}>
              {`${i.email} · owner · ${STATE_WORDS[i.state]} · expires ${formatDay(i.expiresAt, 'Africa/Kampala')}`}
              {i.state === 'accepted' && i.createdFromShownLink ? <span> · account created from a copied link</span> : null}
            </li>
          ))}
        </ul>
      )}
      {pending !== null ? (
        <div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input id={`${formId}-resend-show`} type="checkbox" checked={resendShowLink} onChange={(e) => setResendShowLink(e.target.checked)} />
            <label htmlFor={`${formId}-resend-show`}>Show link</label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} aria-describedby={`${formId}-resend-hint`}
              onClick={() => { void resend(pending); }}>Resend invitation</button>
            <span id={`${formId}-resend-hint`} style={HINT_STYLE}>(makes a new link; the old one stops working)</span>
            <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} onClick={() => setConfirmRevoke(true)}>Revoke invitation</button>
          </div>
          {confirmRevoke ? (
            <InlineConfirm objectName={`Invitation to ${pending.email}`} consequence="Its link stops working at once. You can issue a new first-owner invitation afterwards."
              actionLabel="Revoke invitation" busy={busy} onConfirm={() => revoke(pending)} onCancel={() => setConfirmRevoke(false)} />
          ) : null}
        </div>
      ) : null}
      {mayIssue && !issuing ? (
        <button type="button" className="btn btn--primary" onClick={() => setIssuing(true)}>Issue a new first-owner invitation</button>
      ) : null}
      {mayIssue && issuing ? (
        <form noValidate onSubmit={(e) => { e.preventDefault(); void issue(); }}>
          <Field id={`${formId}-email`} label="New first owner's email" error={errors.email}>
            {(a) => <input id={a.id} name="email" type="email" required autoComplete="off" spellCheck={false} value={draft.email}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />}
          </Field>
          <Field id={`${formId}-requestReference`} label="Reference of the controller's written request" error={errors.requestReference}>
            {(a) => <input id={a.id} name="requestReference" type="text" required maxLength={200} autoComplete="off" value={draft.requestReference}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => setDraft((d) => ({ ...d, requestReference: e.target.value }))} />}
          </Field>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
            <input id={`${formId}-issue-show`} type="checkbox" checked={draft.showLink} onChange={(e) => setDraft((d) => ({ ...d, showLink: e.target.checked }))} />
            <label htmlFor={`${formId}-issue-show`}>Show link</label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Issue invitation</button>
            <button type="button" className="btn btn--secondary" onClick={() => { setIssuing(false); setErrors({}); }}>Cancel</button>
          </div>
          {Object.keys(errors).length > 0 ? <p style={ERROR_STYLE}>Check the fields marked above.</p> : null}
        </form>
      ) : null}
    </section>
  );
}
