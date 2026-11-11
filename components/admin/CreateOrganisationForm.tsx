'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { useHydrated } from '@/lib/client/useHydrated';
import { MAX_LEGAL_NAME, MAX_ORG_NAME } from '@/lib/admin/limits';
import type { CreateOrganisationResponse, InviteMemberResponse } from '@/types/api';
import type { FieldError } from '@/types/record';

export type CreateDraft = { name: string; legalName: string; ownerEmail: string; showLink: boolean };
export type FieldErrors = Partial<Record<keyof CreateDraft, string>>;

export const EMAIL_FAILED = 'The invitation email could not be sent. Send this link another way.';
/** A replayed create (route 41 answers 200): the first call may have sent the email (owner copy; C4 ORG fix round 1). */
export const ALREADY_CREATED = 'This organisation was already created. If the email did not arrive, use Resend.';
/** A replayed resend (route 45 answers 200): the first call may have sent the email (owner copy, after S-22's; C4 CR-1). */
export const ALREADY_RESENT = 'This invitation was already resent. If the email did not arrive, use Resend again.';
const CREATING = 'Creating the organisation...';
const NOT_CREATED = 'Not created: connection lost. Nothing was created.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Hint and error text under a field (globals.css has no field-level classes; the critical tint pair passes contrast in both themes). */
export const HINT_STYLE = { color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', margin: 0 } as const;
export const ERROR_STYLE = { color: 'var(--tint-critical-fg)', fontSize: 'var(--font-size-sm)', fontWeight: 600, margin: 0 } as const;

/** Every field's error of the create form. */
export function createErrors(d: CreateDraft): FieldErrors {
  const e: FieldErrors = {};
  if (d.name.trim() === '') e.name = 'Enter the organisation name.';
  else if (d.name.trim().length > MAX_ORG_NAME) e.name = `Use ${MAX_ORG_NAME} characters or fewer.`;
  if (d.legalName.trim() === '') e.legalName = 'Enter the institution\'s legal name.';
  else if (d.legalName.trim().length > MAX_LEGAL_NAME) e.legalName = `Use ${MAX_LEGAL_NAME} characters or fewer.`;
  if (!EMAIL_SHAPE.test(d.ownerEmail.trim())) e.ownerEmail = 'Enter the first owner\'s email address.';
  return e;
}

/** The fields route 41 reads, trimmed (the request id is added by the sender). */
export function createFields(d: CreateDraft): { name: string; legalName: string; ownerEmail: string; showLink: boolean } {
  return { name: d.name.trim(), legalName: d.legalName.trim(), ownerEmail: d.ownerEmail.trim(), showLink: d.showLink };
}

/** A server's field errors (422) on the form's own fields. */
export function serverFieldErrors(fields: readonly FieldError[] | undefined): FieldErrors {
  const map: Record<string, keyof CreateDraft> = { name: 'name', legalName: 'legalName', ownerEmail: 'ownerEmail' };
  const e: FieldErrors = {};
  for (const f of fields ?? []) {
    const key = map[f.field];
    if (key !== undefined && e[key] === undefined) e[key] = f.message;
  }
  return e;
}

/** The sentence for a first-owner invitation write that did not succeed (7.4.1 patterns; the definer's 409s in words). */
export function invitationRefusal(out: Exclude<SendOutcome<unknown>, { kind: 'saved' }>): string {
  if (out.kind === 'not_saved') return 'Not done: connection lost. It may have arrived. Reload the page before trying again.';
  if (out.status === 401) return 'Not done: you have been signed out. Sign in again.';
  if (out.status >= 500) return 'Not done: the server had a problem. Reload the page and try again.';
  switch (out.body.code) {
    case 'invitation_not_pending': return 'That invitation is no longer pending. Reload the page.';
    case 'active_owner_exists': return 'This organisation has an active owner. A first-owner invitation is not needed.';
    case 'pending_owner_invitation_exists': return 'A first-owner invitation is already pending. Resend or revoke it instead.';
    case 'not_found': return 'That invitation is no longer here. Reload the page.';
    case 'organisation_archived': return 'This organisation is archived.';
    case 'validation': return 'Not done: check the fields marked below.';
    default: return 'Not done. Reload the page and try again.';
  }
}

/**
 * What a resent first-owner invitation says: the 7.4.1 resend pattern with UX-23's failure sentence, or, for a replay
 * (route 45 answers 200 and keeps no link), that it was already resent, since the first call may have sent the email.
 */
export function resentWords(r: InviteMemberResponse, status: number = 201): string {
  if (status === 200) return ALREADY_RESENT;
  return `Resent: the old link no longer works. ${r.emailSent ? `Invitation sent to ${r.invitation.email}.` : EMAIL_FAILED}`;
}

/** What the page says after a send: the 7.4.2 S-24 texts, and the link box for a created organisation. */
export type CreateResult =
  | { kind: 'created'; status: string; response: CreateOrganisationResponse; replayed?: boolean }
  | { kind: 'not_created'; status: string; retry: boolean; fields: FieldErrors };

export function createResult(out: SendOutcome<CreateOrganisationResponse>): CreateResult {
  if (out.kind === 'saved') {
    const r = out.body;
    if (out.status === 200) return { kind: 'created', response: r, status: ALREADY_CREATED, replayed: true };
    return { kind: 'created', response: r, status: r.emailSent ? `Created. Invitation sent to ${r.invitation.email}.` : `Created. ${EMAIL_FAILED}` };
  }
  if (out.kind === 'not_saved') return { kind: 'not_created', status: NOT_CREATED, retry: true, fields: {} };
  if (out.status === 401) return { kind: 'not_created', status: 'Not created: you have been signed out. Sign in again.', retry: false, fields: {} };
  if (out.status >= 500) return { kind: 'not_created', status: 'Not created: the server had a problem, so nothing was created. Retry.', retry: true, fields: {} };
  switch (out.body.code) {
    case 'validation': return { kind: 'not_created', status: 'Not created: check the fields marked below.', retry: false, fields: serverFieldErrors(out.body.fields) };
    // The slug comes from the name: a second organisation whose name gives the same address is refused. After a lost
    // reply, the first attempt may be the one that took it.
    case 'slug_taken': return { kind: 'not_created', status: 'Another organisation already uses this web address. Change the name slightly and try again.', retry: false, fields: {} };
    case 'not_platform_admin': return { kind: 'not_created', status: 'Not created: this account is not the MAK-AI administrator.', retry: false, fields: {} };
    default: return { kind: 'not_created', status: 'Not created. Reload the page and try again.', retry: false, fields: {} };
  }
}

/**
 * After "Resend and show link" on a just-created organisation (route 45 with Show link): the organisation stays created
 * either way; a resend that went through replaces the invitation and its link, and one that did not says why.
 */
export function resentResult(created: CreateOrganisationResponse, out: SendOutcome<InviteMemberResponse>): CreateResult {
  if (out.kind !== 'saved') return { kind: 'created', response: created, status: invitationRefusal(out) };
  const r = out.body;
  return {
    kind: 'created', response: { ...created, invitation: r.invitation, acceptUrl: r.acceptUrl, emailSent: r.emailSent },
    status: resentWords(r, out.status), replayed: out.status === 200,
  };
}

type FieldProps = { id: string; label: string; hint?: string; error?: string; children: (a: { id: string; describedBy: string | undefined; invalid: true | undefined }) => ReactElement };

/** A labelled field with its hint and error, joined by aria-describedby (NFR-A11Y-02). */
export function Field({ id, label, hint, error, children }: FieldProps): ReactElement {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      {hint ? <p id={hintId} style={HINT_STYLE}>{hint}</p> : null}
      {children({ id, describedBy, invalid: error ? true : undefined })}
      {error ? <p id={errorId} style={ERROR_STYLE}>{error}</p> : null}
    </div>
  );
}

export type CreateOrganisationFormViewProps = {
  draft: CreateDraft; errors: FieldErrors;
  status: string; busy: boolean; result: CreateResult | null;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onChange: (patch: Partial<CreateDraft>) => void; onSubmit: () => void; onRetry: () => void;
  /** Route 45 with Show link, offered by the link box when the email failed and no link was shown. */
  onResendWithLink?: () => void;
};

/**
 * S-24's create form as markup, from its state (vitest has no DOM library; the e2e drives the real one). The
 * status region is mounted from the first render and keeps its place, so each text put in it is announced
 * (4.1.3); the email-failure sentence goes there, and the link box is told so (`noticeShownElsewhere`) and keyed by
 * the invitation, so a copy result never carries over.
 */
export function CreateOrganisationFormView(p: CreateOrganisationFormViewProps): ReactElement {
  const formId = useId();
  const d = p.draft;
  const created = p.result?.kind === 'created' ? p.result.response : null;
  return (
    <div>
      <div role="status" id={`${formId}-status`}>{p.status}</div>
      {p.result?.kind === 'not_created' && p.result.retry
        ? <button type="button" className="btn btn--secondary" onClick={p.onRetry} aria-disabled={p.busy || undefined}>Retry</button> : null}
      {created !== null ? (
        <>
          {!(p.result?.kind === 'created' && p.result.replayed) && (created.acceptUrl !== null || !created.emailSent) ? (
            <CopyLinkFallback key={created.invitation.id} noticeShownElsewhere onResendWithLink={p.onResendWithLink} acceptUrl={created.acceptUrl}
              expiresAt={created.invitation.expiresAt} emailSent={created.emailSent} />
          ) : null}
          <p><Link href={`/admin/organisations/${encodeURIComponent(created.orgId)}`} prefetch={false}>Open the organisation</Link></p>
        </>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
          <Field id={`${formId}-name`} label="Organisation name"
            hint="Create one organisation for each team whose members may read each other's records. An institution with several teams gets one organisation for each."
            error={p.errors.name}>
            {(a) => <input id={a.id} name="name" type="text" required maxLength={MAX_ORG_NAME} autoComplete="off" value={d.name}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onChange({ name: e.target.value })} />}
          </Field>
          <Field id={`${formId}-legal-name`} label="Institution's legal name"
            hint="The registered name of the university, hospital or institute the team belongs to."
            error={p.errors.legalName}>
            {(a) => <input id={a.id} name="legalName" type="text" required maxLength={MAX_LEGAL_NAME} autoComplete="off" value={d.legalName}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onChange({ legalName: e.target.value })} />}
          </Field>
          <Field id={`${formId}-owner`} label="First owner's email" error={p.errors.ownerEmail}>
            {(a) => <input id={a.id} name="ownerEmail" type="email" required autoComplete="off" spellCheck={false} value={d.ownerEmail}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onChange({ ownerEmail: e.target.value })} />}
          </Field>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
            <input id={`${formId}-show`} name="showLink" type="checkbox" checked={d.showLink} onChange={(e) => p.onChange({ showLink: e.target.checked })} />
            <label htmlFor={`${formId}-show`}>Show link (to send it yourself if the email does not arrive)</label>
          </div>
          <p>Creating the organisation also sends an invitation to the first owner. If either part does not go through, nothing is created.</p>
          <button type="submit" className="btn btn--primary" disabled={p.hydrated === false} aria-disabled={p.busy || undefined}>Create organisation and send invitation</button>
        </form>
      )}
    </div>
  );
}

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<CreateOrganisationResponse>>;

/**
 * S-24 create mode (FR-ORG-01, J-01). Validates every field on submit (7.4.2 S-24 Validation) and moves focus to
 * the first field at fault; then sends route 41 and shows the 7.4.2 texts. `send` is injectable for the unit tests.
 */
type Resend = (url: string, body: Record<string, unknown>) => Promise<SendOutcome<InviteMemberResponse>>;

export function CreateOrganisationForm({ send, resend }: { send?: Send; resend?: Resend }): ReactElement {
  const [draft, setDraft] = useState<CreateDraft>({ name: '', legalName: '', ownerEmail: '', showLink: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const [result, setResult] = useState<CreateResult | null>(null);
  const lastBody = useRef<Record<string, unknown> | null>(null);
  const resendRetry = useRef(new Map<string, RetryState>());
  const createRetry = useRef<RetryState>({ requestId: null, sentBody: null });
  const doSend: Send = send ?? ((body) => sendWrite<CreateOrganisationResponse>('/api/admin/organisations', 'POST', body, { onSlow: () => setStatus(CREATING) }));

  async function run(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setStatus(CREATING);
    try {
      const r = createResult(await doSend(body));
      setResult(r);
      setStatus(r.status);
      if (r.kind === 'not_created') setErrors(r.fields);
    } finally {
      setBusy(false);
    }
  }

  function submit(): void {
    if (busy) return;
    const e = createErrors(draft);
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first !== undefined) {
      setStatus('');
      const input = document.querySelector<HTMLElement>(`form [name="${first}"]`);
      input?.focus();
      return;
    }
    const fields = createFields(draft);
    // One request id per body until it is created: Retry, or a second press with the same fields, is answered, not
    // created twice (NFR-INT-02).
    const { requestId, state } = requestIdFor(createRetry.current, fields);
    createRetry.current = state;
    const body = { ...fields, requestId };
    lastBody.current = body;
    void run(body);
  }

  /** Route 45 for the invitation just created, with Show link; one request id per invitation until it goes through. */
  async function resendWithLink(): Promise<void> {
    if (busy || result?.kind !== 'created') return;
    const created = result.response;
    const key = created.invitation.id;
    const body = { showLink: true };
    const { requestId, state } = requestIdFor(resendRetry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    resendRetry.current.set(key, state);
    setBusy(true);
    setStatus('Sending...');
    try {
      const url = `/api/admin/organisations/${encodeURIComponent(created.orgId)}/owner-invitations/${encodeURIComponent(key)}/resend`;
      const out = await (resend ?? ((u: string, b: Record<string, unknown>) => sendWrite<InviteMemberResponse>(u, 'POST', b, { onSlow: () => setStatus('Sending...') })))(url, { ...body, requestId });
      const r = resentResult(created, out);
      if (out.kind === 'saved') resendRetry.current.delete(key);
      setResult(r);
      setStatus(r.status);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CreateOrganisationFormView draft={draft} errors={errors} status={status} busy={busy} hydrated={hydrated} result={result}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onSubmit={submit}
      onRetry={() => { if (!busy && lastBody.current !== null) void run(lastBody.current); }}
      onResendWithLink={() => { void resendWithLink(); }} />
  );
}
