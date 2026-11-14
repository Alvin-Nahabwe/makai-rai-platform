'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ListLink } from '@/components/ui/ListLink';
import { TextInput } from '@/components/ui/TextInput';
import { useHydrated } from '@/lib/client/useHydrated';
import { MAX_LEGAL_NAME, MAX_ORG_NAME } from '@/lib/admin/limits';
import { ADMIN_FORMS_COPY } from '@/lib/admin/forms/copy';
import { COPY_LINK_COPY } from '@/lib/invitations/link/copy';
import './AdminForms.css';
import type { CreateOrganisationResponse, InviteMemberResponse } from '@/types/api';
import type { FieldError } from '@/types/record';
// The kit's styles entries for the native elements below that wear kit classes (rulings X-6, X-7).
import '@/components/ui/formStyles';

export type CreateDraft = { name: string; legalName: string; ownerEmail: string; showLink: boolean };
export type FieldErrors = Partial<Record<keyof CreateDraft, string>>;

const C = ADMIN_FORMS_COPY.create;
const I = ADMIN_FORMS_COPY.invitation;

/** The one sentence for an invitation email that could not be sent, with the link on the screen (the copy-link box's own words). */
export const EMAIL_FAILED = COPY_LINK_COPY.emailFailed;
/**
 * The email-failed sentence that is true of the screen (answer Q21): with the link shown it says to send the link
 * another way; with none, the link box offers its button, and the sentence names it.
 */
export function emailFailedWords(acceptUrl: string | null): string {
  return acceptUrl !== null ? EMAIL_FAILED : COPY_LINK_COPY.emailFailedNoLink;
}
/** A replayed create (route 41 answers 200): the first call may have sent the email (C4 ORG fix round 1; audit AD35). */
export const ALREADY_CREATED = C.alreadyCreated;
/** A replayed resend (route 45 answers 200): the first call may have sent the email (C4 CR-1; coordinator's answer Q2). */
export const ALREADY_RESENT = I.alreadyResent;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every field's error of the create form. */
export function createErrors(d: CreateDraft): FieldErrors {
  const e: FieldErrors = {};
  if (d.name.trim() === '') e.name = C.nameMissing;
  else if (d.name.trim().length > MAX_ORG_NAME) e.name = C.tooLong(MAX_ORG_NAME);
  if (d.legalName.trim() === '') e.legalName = C.legalNameMissing;
  else if (d.legalName.trim().length > MAX_LEGAL_NAME) e.legalName = C.tooLong(MAX_LEGAL_NAME);
  if (!EMAIL_SHAPE.test(d.ownerEmail.trim())) e.ownerEmail = C.ownerEmailMissing;
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

/** The sentence for an owner invitation write that did not succeed (7.4.1 patterns; the definer's 409s in words). */
export function invitationRefusal(out: Exclude<SendOutcome<unknown>, { kind: 'saved' }>): string {
  if (out.kind === 'not_saved') return I.lostReply;
  if (out.status === 401) return I.signedOut;
  if (out.status >= 500) return I.serverProblem;
  switch (out.body.code) {
    case 'invitation_not_pending': return I.notPending;
    case 'active_owner_exists': return I.activeOwner;
    case 'pending_owner_invitation_exists': return I.pendingExists;
    case 'not_found': return I.notFound;
    case 'organisation_archived': return I.archived;
    case 'validation': return I.checkFields;
    default: return I.other;
  }
}

/**
 * What a resent first-owner invitation says: the 7.4.1 resend pattern with UX-23's failure sentence, or, for a replay
 * (route 45 answers 200 and keeps no link), that it was already resent, since the first call may have sent the email.
 */
export function resentWords(r: InviteMemberResponse, status: number = 201): string {
  if (status === 200) return ALREADY_RESENT;
  return `${I.resentPrefix} ${r.emailSent ? I.sentTo(r.invitation.email) : emailFailedWords(r.acceptUrl)}`;
}

/** What the page says after a send: the 7.4.2 S-24 texts, and the link box for a created organisation. */
export type CreateResult =
  | { kind: 'created'; status: string; response: CreateOrganisationResponse; replayed?: boolean }
  | { kind: 'not_created'; status: string; retry: boolean; fields: FieldErrors };

export function createResult(out: SendOutcome<CreateOrganisationResponse>): CreateResult {
  if (out.kind === 'saved') {
    const r = out.body;
    if (out.status === 200) return { kind: 'created', response: r, status: ALREADY_CREATED, replayed: true };
    return { kind: 'created', response: r, status: r.emailSent ? C.sent(r.invitation.email) : `${C.createdPrefix} ${emailFailedWords(r.acceptUrl)}` };
  }
  if (out.kind === 'not_saved') return { kind: 'not_created', status: C.notCreated, retry: true, fields: {} };
  if (out.status === 401) return { kind: 'not_created', status: C.signedOut, retry: false, fields: {} };
  if (out.status >= 500) return { kind: 'not_created', status: C.serverProblem, retry: true, fields: {} };
  switch (out.body.code) {
    case 'validation': return { kind: 'not_created', status: C.checkFields, retry: false, fields: serverFieldErrors(out.body.fields) };
    // The slug comes from the name: a second organisation whose name gives the same address is refused. After a lost
    // reply, the first attempt may be the one that took it.
    case 'slug_taken': return { kind: 'not_created', status: C.slugTaken, retry: false, fields: {} };
    case 'not_platform_admin': return { kind: 'not_created', status: C.notAdmin, retry: false, fields: {} };
    default: return { kind: 'not_created', status: C.other, retry: false, fields: {} };
  }
}

/**
 * A refused resend on the create screen (answer Q22). A reload of /admin/organisations/new shows an empty form, so the
 * five sentences that send the administrator to a reload point at the screen's "Open the organisation" link instead;
 * the other refusals are the organisation page's.
 */
export function createScreenRefusal(out: Exclude<SendOutcome<unknown>, { kind: 'saved' }>): string {
  const R = C.resendRefusals;
  if (out.kind === 'not_saved') return R.lostReply;
  if (out.status === 401) return I.signedOut;
  if (out.status >= 500) return R.serverProblem;
  switch (out.body.code) {
    case 'invitation_not_pending': return R.notPending;
    case 'not_found': return R.notFound;
    case 'active_owner_exists':
    case 'pending_owner_invitation_exists':
    case 'organisation_archived':
    case 'validation':
      return invitationRefusal(out);
    default: return R.other;
  }
}

/**
 * After "Resend and show link" on a just-created organisation (route 45 with Show link): the organisation stays created
 * either way; a resend that went through replaces the invitation and its link, and one that did not says why.
 */
export function resentResult(created: CreateOrganisationResponse, out: SendOutcome<InviteMemberResponse>): CreateResult {
  if (out.kind !== 'saved') return { kind: 'created', response: created, status: createScreenRefusal(out) };
  const r = out.body;
  return {
    kind: 'created', response: { ...created, invitation: r.invitation, acceptUrl: r.acceptUrl, emailSent: r.emailSent },
    status: resentWords(r, out.status), replayed: out.status === 200,
  };
}

/** The control whose request is in flight: the form's submit, Retry, or the link box's resend. */
export type CreatePressed = 'submit' | 'retry' | 'resend';

export type CreateOrganisationFormViewProps = {
  draft: CreateDraft; errors: FieldErrors;
  status: string; busy: boolean; result: CreateResult | null;
  /**
   * Which control sent the request in flight (ruling L5-25): it alone shows busy, and the other write control on the
   * screen is disabled. Left out, both show busy while `busy` is true (a static render of the view).
   */
  pressed?: CreatePressed | null;
  /** The status line, which takes focus when the pressed control has gone from the screen (rulings X-4, L5-14). */
  statusRef?: Ref<HTMLDivElement>;
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
 * the invitation, so a copy result never carries over. The fields are the kit's (plan 1A Task 19, ruling L5-3), in the
 * order name, legal name, first Owner's email, show link, with no fieldset (a second group breaks the specs' locators).
 */
export function CreateOrganisationFormView({ statusRef, ...p }: CreateOrganisationFormViewProps): ReactElement {
  const formId = useId();
  const d = p.draft;
  const created = p.result?.kind === 'created' ? p.result.response : null;
  /** Busy for its own request; disabled while the other control's request is in flight (ruling L5-25). */
  const pressed = p.pressed ?? null;
  const busyFor = (which: CreatePressed) => p.busy && (pressed === null || pressed === which);
  const unavailableFor = (which: CreatePressed) => p.busy && pressed !== null && pressed !== which;
  return (
    <div>
      {/* The kit's status line as a native element: it takes focus, and StatusRegion takes no tabIndex or ref (T19-j). */}
      <div role="status" tabIndex={-1} ref={statusRef} id={`${formId}-status`} className="ui-status">{p.status}</div>
      {p.result?.kind === 'not_created' && p.result.retry
        ? <Button variant="secondary" busy={busyFor('retry')} disabled={unavailableFor('retry')} onClick={p.onRetry}>{C.retry}</Button> : null}
      {created !== null ? (
        <>
          {!(p.result?.kind === 'created' && p.result.replayed) && (created.acceptUrl !== null || !created.emailSent) ? (
            <CopyLinkFallback key={created.invitation.id} noticeShownElsewhere onResendWithLink={p.onResendWithLink} acceptUrl={created.acceptUrl}
              expiresAt={created.invitation.expiresAt} emailSent={created.emailSent} />
          ) : null}
          <p><ListLink href={`/admin/organisations/${encodeURIComponent(created.orgId)}`}>{C.open}</ListLink></p>
        </>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
          <TextInput id={`${formId}-name`} name="name" label={C.nameLabel} hint={C.nameHint} error={p.errors.name} required
            maxLength={MAX_ORG_NAME} autoComplete="off" value={d.name} onChange={(e) => p.onChange({ name: e.target.value })} />
          <TextInput id={`${formId}-legal-name`} name="legalName" label={C.legalNameLabel} hint={C.legalNameHint} error={p.errors.legalName} required
            maxLength={MAX_LEGAL_NAME} autoComplete="off" value={d.legalName} onChange={(e) => p.onChange({ legalName: e.target.value })} />
          <TextInput id={`${formId}-owner`} name="ownerEmail" type="email" label={C.ownerEmailLabel} error={p.errors.ownerEmail} required
            autoComplete="off" spellCheck={false} value={d.ownerEmail} onChange={(e) => p.onChange({ ownerEmail: e.target.value })} />
          <div className="admin-form__check">
            <Checkbox id={`${formId}-show`} name="showLink" label={C.showLink} checked={d.showLink} onChange={(e) => p.onChange({ showLink: e.target.checked })} />
          </div>
          <p className="admin-form__note">{C.note}</p>
          <Button variant="primary" type="submit" disabled={p.hydrated === false || unavailableFor('submit')} busy={busyFor('submit')}>{C.submit}</Button>
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
  const [pressed, setPressed] = useState<CreatePressed | null>(null);
  const busy = pressed !== null;
  const hydrated = useHydrated();
  const statusRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const lastBody = useRef<Record<string, unknown> | null>(null);
  const resendRetry = useRef(new Map<string, RetryState>());
  const createRetry = useRef<RetryState>({ requestId: null, sentBody: null });
  const doSend: Send = send ?? ((body) => sendWrite<CreateOrganisationResponse>('/api/admin/organisations', 'POST', body, { onSlow: () => setStatus(C.creating) }));

  /** Focus goes to the status line after the render that removed the pressed control (rulings X-4, L5-14). */
  const focusStatus = () => { setTimeout(() => statusRef.current?.focus(), 0); };

  async function run(body: Record<string, unknown>, from: 'submit' | 'retry'): Promise<void> {
    setPressed(from);
    setStatus(C.creating);
    try {
      const r = createResult(await doSend(body));
      setResult(r);
      setStatus(r.status);
      if (r.kind === 'not_created') setErrors(r.fields);
      // Created: the form, and Retry with it, gives way to the link box. Refused: the submit stays, and Retry stays only
      // when the refusal offers it again. While the pressed control stays, focus stays on it.
      if (r.kind === 'created' || (from === 'retry' && !r.retry)) focusStatus();
    } finally {
      setPressed(null);
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
    void run(body, 'submit');
  }

  /** Route 45 for the invitation just created, with Show link; one request id per invitation until it goes through. */
  async function resendWithLink(): Promise<void> {
    if (busy || result?.kind !== 'created') return;
    const created = result.response;
    const key = created.invitation.id;
    const body = { showLink: true };
    const { requestId, state } = requestIdFor(resendRetry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    resendRetry.current.set(key, state);
    setPressed('resend');
    setStatus(C.sending);
    try {
      const url = `/api/admin/organisations/${encodeURIComponent(created.orgId)}/owner-invitations/${encodeURIComponent(key)}/resend`;
      const out = await (resend ?? ((u: string, b: Record<string, unknown>) => sendWrite<InviteMemberResponse>(u, 'POST', b, { onSlow: () => setStatus(C.sending) })))(url, { ...body, requestId });
      const r = resentResult(created, out);
      if (out.kind === 'saved') resendRetry.current.delete(key);
      setResult(r);
      setStatus(r.status);
      // Saved: the box is keyed by the new invitation (or closed for a replay), so its button is gone. Refused: the
      // box and its button stay, and so does focus.
      if (out.kind === 'saved') focusStatus();
    } finally {
      setPressed(null);
    }
  }

  return (
    <CreateOrganisationFormView draft={draft} errors={errors} status={status} busy={busy} pressed={pressed} hydrated={hydrated} result={result}
      statusRef={statusRef} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onSubmit={submit}
      onRetry={() => { if (!busy && lastBody.current !== null) void run(lastBody.current, 'retry'); }}
      onResendWithLink={() => { void resendWithLink(); }} />
  );
}
