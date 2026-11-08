'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { EMAIL_FAILED, ERROR_STYLE, Field, HINT_STYLE, invitationRefusal, resentWords } from '@/components/admin/CreateOrganisationForm';
import { MAX_REQUEST_REFERENCE } from '@/lib/admin/limits';
import { useHydrated } from '@/lib/client/useHydrated';
import { formatDay } from '@/lib/format/dates';
import type { InvitationView, InviteMemberResponse } from '@/types/api';
import type { InvitationState } from '@/types/record';

/** W-10's four invitation states (SRS lines 2166-2210). */
export const STATE_WORDS: Readonly<Record<InvitationState, string>> = { pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked' };
const SENDING = 'Sending...';

/** The sentence after a resend went through: 201 is a new invitation, 200 a replay of one already resent (C4 CR-1). */
export function resendWords(out: Extract<SendOutcome<InviteMemberResponse | undefined>, { kind: 'saved' }>): string {
  if (out.body === undefined) return `Resent: the old link no longer works. ${EMAIL_FAILED}`;
  return resentWords(out.body, out.status);
}
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Write = (url: string, body: Record<string, unknown> | null) => Promise<SendOutcome<InviteMemberResponse | undefined>>;

export type IssueInvitationFormViewProps = {
  formId: string; draft: { email: string; requestReference: string; showLink: boolean };
  errors: { email?: string; requestReference?: string }; busy: boolean;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onDraft: (patch: Partial<{ email: string; requestReference: string; showLink: boolean }>) => void;
  onSubmit: () => void; onCancel: () => void;
};

/** The form that issues a new first-owner invitation (FR-ORG-01 recovery). */
export function IssueInvitationFormView(p: IssueInvitationFormViewProps): ReactElement {
  return (
    <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <Field id={`${p.formId}-email`} label="New first owner's email" error={p.errors.email}>
        {(a) => <input id={a.id} name="email" type="email" required autoComplete="off" spellCheck={false} value={p.draft.email}
          aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onDraft({ email: e.target.value })} />}
      </Field>
      <Field id={`${p.formId}-requestReference`} label="Reference of the controller's written request" error={p.errors.requestReference}>
        {(a) => <input id={a.id} name="requestReference" type="text" required maxLength={MAX_REQUEST_REFERENCE} autoComplete="off" value={p.draft.requestReference}
          aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onDraft({ requestReference: e.target.value })} />}
      </Field>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
        <input id={`${p.formId}-issue-show`} type="checkbox" checked={p.draft.showLink} onChange={(e) => p.onDraft({ showLink: e.target.checked })} />
        <label htmlFor={`${p.formId}-issue-show`}>Show link</label>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn--primary" disabled={p.hydrated === false} aria-disabled={p.busy || undefined}>Issue invitation</button>
        <button type="button" className="btn btn--secondary" onClick={p.onCancel}>Cancel</button>
      </div>
      {Object.keys(p.errors).length > 0 ? <p style={ERROR_STYLE}>Check the fields marked above.</p> : null}
    </form>
  );
}

/**
 * S-24's first-owner invitation box (FR-ORG-02, FR-ACC-10; W-10 note 3). Every first-owner invitation with its state;
 * Resend (a new link, the old one stops working) and Revoke for the pending one; "Issue a new first-owner invitation"
 * only when the organisation has no active owner and none pending, with the reference of the controller's written
 * request. The status region is mounted from the first render and the email-failure sentence goes there, so it is
 * announced; the link box is keyed by the invitation and told the sentence is shown elsewhere (MEM's CopyLinkFallback).
 */
export function OwnerInvitationBox({ orgId, hasActiveOwner, invitations, archived = false, write }: {
  orgId: string; hasActiveOwner: boolean; invitations: InvitationView[]; archived?: boolean; write?: Write;
}): ReactElement {
  const router = useRouter();
  const formId = useId();
  const hydrated = useHydrated();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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

  const base = `/api/admin/organisations/${encodeURIComponent(orgId)}/owner-invitations`;
  const doWrite: Write = write ?? ((url, body) => sendWrite<InviteMemberResponse | undefined>(url, 'POST', body ?? {}, { onSlow: () => setStatus(SENDING) }));
  // The page's list arrives with the next refresh; until then the box knows better what it has just done: an invitation
  // it resent or revoked is no longer pending, and the one it just issued or resent is.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const justIssued = issued !== null && issued.invitation.state === 'pending' && !gone.has(issued.invitation.id) ? issued.invitation : null;
  const pending = justIssued ?? invitations.find((i) => i.state === 'pending' && !gone.has(i.id)) ?? null;
  const mayIssue = !archived && !hasActiveOwner && pending === null;

  async function act(
    url: string, body: Record<string, unknown> | null,
    done: (out: Extract<SendOutcome<InviteMemberResponse | undefined>, { kind: 'saved' }>) => string,
  ): Promise<boolean> {
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
      setIssuedReplayed(out.status === 200);
      setStatus(done(out));
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
    if (await act(`${base}/${encodeURIComponent(inv.id)}/resend`, { ...body, requestId }, resendWords)) {
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
    if (await act(`${base}/${encodeURIComponent(inv.id)}/revoke`, null, () => `Revoked. The invitation to ${inv.email} no longer works.`)) {
      setIssued(null);
      setConfirmRevoke(false);
      setGone((g) => new Set(g).add(inv.id));
    }
  }

  async function issue(): Promise<void> {
    const e: typeof errors = {};
    if (!EMAIL_SHAPE.test(draft.email.trim())) e.email = 'Enter the new first owner\'s email address.';
    if (draft.requestReference.trim() === '') e.requestReference = 'Enter the reference of the controller\'s written request.';
    else if (draft.requestReference.trim().length > MAX_REQUEST_REFERENCE) e.requestReference = `Use ${MAX_REQUEST_REFERENCE} characters or fewer.`;
    setErrors(e);
    if (Object.keys(e).length > 0) {
      document.getElementById(`${formId}-${Object.keys(e)[0]}`)?.focus();
      return;
    }
    const ok = await act(base, { email: draft.email.trim(), requestReference: draft.requestReference.trim(), showLink: draft.showLink }, (out) => `Issued. ${sentWords(out.body)}`);
    if (ok) { setIssuing(false); setDraft({ email: '', requestReference: '', showLink: false }); }
  }

  return (
    <section aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`}>First-owner invitation</h2>
      <div role="status" tabIndex={-1} ref={statusRef}>{status}</div>
      {issued !== null && !issuedReplayed && (issued.acceptUrl !== null || !issued.emailSent) ? (
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
      {archived ? <p>This organisation is archived.</p> : null}
      {pending !== null && !archived ? (
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
        <IssueInvitationFormView formId={formId} draft={draft} errors={errors} busy={busy} hydrated={hydrated}
          onDraft={(patch) => setDraft((d) => ({ ...d, ...patch }))} onSubmit={() => { void issue(); }}
          onCancel={() => { setIssuing(false); setErrors({}); }} />
      ) : null}
    </section>
  );
}
