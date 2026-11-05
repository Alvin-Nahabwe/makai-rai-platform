'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { sendWrite, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { formatDay } from '@/lib/format/dates';
import type { AgreementInput, CreateOrganisationResponse } from '@/types/api';
import type { CalendarDate, FieldError } from '@/types/record';

/** A published version of the organisation agreement, as the page reads it from the registry. */
export type AgreementVersionOption = { version: string; publishedOn: CalendarDate; sha256: string };

/** The agreement fields as typed: the date in three parts, as W-10 draws it (SRS lines 2166-2210). */
export type AgreementDraft = { version: string; day: string; month: string; year: string; controllerLegalName: string; dpContactEmail: string };
export type CreateDraft = AgreementDraft & { name: string; ownerEmail: string; showLink: boolean };
export type FieldErrors = Partial<Record<keyof CreateDraft, string>>;

export const EMAIL_FAILED = 'The invitation email could not be sent. Send this link another way.';
const CREATING = 'Creating the organisation...';
const NOT_CREATED = 'Not created: connection lost. Nothing was created.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Hint and error text under a field (globals.css has no field-level classes; the critical tint pair passes contrast in both themes). */
export const HINT_STYLE = { color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', margin: 0 } as const;
export const ERROR_STYLE = { color: 'var(--tint-critical-fg)', fontSize: 'var(--font-size-sm)', fontWeight: 600, margin: 0 } as const;

export const EMPTY_AGREEMENT: AgreementDraft = { version: '', day: '', month: '', year: '', controllerLegalName: '', dpContactEmail: '' };

/** The `YYYY-MM-DD` day the three parts name, or null when they name no real day. */
export function dayOf(d: Pick<AgreementDraft, 'day' | 'month' | 'year'>): CalendarDate | null {
  if (!/^\d{1,2}$/.test(d.day.trim()) || !/^\d{1,2}$/.test(d.month.trim()) || !/^\d{4}$/.test(d.year.trim())) return null;
  const [y, m, dd] = [Number(d.year), Number(d.month), Number(d.day)];
  const date = new Date(Date.UTC(y, m - 1, dd));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== dd) return null;
  return date.toISOString().slice(0, 10);
}

/** The agreement fields' errors (7.4.2 S-24 Validation: each required, email format, date not in the future, a published version). */
export function agreementErrors(d: AgreementDraft, today: CalendarDate, versions: readonly AgreementVersionOption[]): FieldErrors {
  const e: FieldErrors = {};
  if (!versions.some((v) => v.version === d.version)) e.version = 'Choose the agreement version that was signed.';
  const day = dayOf(d);
  if (day === null) e.day = 'Enter the date the agreement was accepted, as day, month and year.';
  else if (day > today) e.day = 'The date the agreement was accepted cannot be after today.';
  if (d.controllerLegalName.trim() === '') e.controllerLegalName = 'Enter the controller\'s legal name.';
  if (!EMAIL_SHAPE.test(d.dpContactEmail.trim())) e.dpContactEmail = 'Enter the data-protection contact\'s email address.';
  return e;
}

/** Every field's error of the create form. */
export function createErrors(d: CreateDraft, today: CalendarDate, versions: readonly AgreementVersionOption[]): FieldErrors {
  const e: FieldErrors = {};
  if (d.name.trim() === '') e.name = 'Enter the organisation name.';
  else if (d.name.trim().length > 100) e.name = 'Use 100 characters or fewer.';
  Object.assign(e, agreementErrors(d, today, versions));
  if (!EMAIL_SHAPE.test(d.ownerEmail.trim())) e.ownerEmail = 'Enter the first owner\'s email address.';
  return e;
}

/** The request body route 41 and route 43 read: the agreement with the chosen version's own text hash. */
export function agreementInputOf(d: AgreementDraft, versions: readonly AgreementVersionOption[]): AgreementInput {
  return {
    agreementVersion: d.version, textHash: versions.find((v) => v.version === d.version)?.sha256 ?? '',
    acceptedOn: dayOf(d) ?? '', controllerLegalName: d.controllerLegalName.trim(), dpContactEmail: d.dpContactEmail.trim(),
  };
}

/** A server's field errors (422) on the form's own fields. */
export function serverFieldErrors(fields: readonly FieldError[] | undefined): FieldErrors {
  const map: Record<string, keyof CreateDraft> = {
    name: 'name', ownerEmail: 'ownerEmail', 'agreement.agreementVersion': 'version', 'agreement.textHash': 'version',
    'agreement.acceptedOn': 'day', 'agreement.controllerLegalName': 'controllerLegalName', 'agreement.dpContactEmail': 'dpContactEmail',
    agreementVersion: 'version', textHash: 'version', acceptedOn: 'day', controllerLegalName: 'controllerLegalName', dpContactEmail: 'dpContactEmail',
  };
  const e: FieldErrors = {};
  for (const f of fields ?? []) {
    const key = map[f.field];
    if (key !== undefined && e[key] === undefined) e[key] = f.message;
  }
  return e;
}

/** What the page says after a send: the 7.4.2 S-24 texts, and the link box for a created organisation. */
export type CreateResult =
  | { kind: 'created'; status: string; response: CreateOrganisationResponse }
  | { kind: 'not_created'; status: string; retry: boolean; fields: FieldErrors };

export function createResult(out: SendOutcome<CreateOrganisationResponse>): CreateResult {
  if (out.kind === 'saved') {
    const r = out.body;
    return { kind: 'created', response: r, status: r.emailSent ? `Created. Invitation sent to ${r.invitation.email}.` : `Created. ${EMAIL_FAILED}` };
  }
  if (out.kind === 'not_saved') return { kind: 'not_created', status: NOT_CREATED, retry: true, fields: {} };
  if (out.status === 401) return { kind: 'not_created', status: 'Not created: you have been signed out. Sign in again.', retry: false, fields: {} };
  if (out.status >= 500) return { kind: 'not_created', status: 'Not created: the server had a problem. Nothing was created. Retry.', retry: true, fields: {} };
  switch (out.body.code) {
    case 'validation': return { kind: 'not_created', status: 'Not created: check the fields marked below.', retry: false, fields: serverFieldErrors(out.body.fields) };
    // The slug comes from the name: a second organisation whose name gives the same address is refused. After a lost
    // reply, the first attempt may be the one that took it.
    case 'slug_taken': return { kind: 'not_created', status: 'Not created: an organisation with this name, or one very like it, already exists. Check the organisations list, or change the name.', retry: false, fields: {} };
    case 'not_platform_admin': return { kind: 'not_created', status: 'Not created: this account is not the MAK-AI administrator.', retry: false, fields: {} };
    default: return { kind: 'not_created', status: 'Not created. Reload the page and try again.', retry: false, fields: {} };
  }
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

/** The agreement's fields, shared by S-24's create form and its "Record a newer agreement version" form. */
export function AgreementFields({ prefix, draft, errors, versions, onChange }: {
  prefix: string; draft: AgreementDraft; errors: FieldErrors; versions: readonly AgreementVersionOption[];
  onChange: (patch: Partial<AgreementDraft>) => void;
}): ReactElement {
  const legendId = `${prefix}-date-legend`;
  const dateErrorId = `${prefix}-date-error`;
  const dateDescribedBy = errors.day ? dateErrorId : undefined;
  return (
    <>
      <Field id={`${prefix}-version`} label="Agreement version accepted" error={errors.version}>
        {(a) => (
          <select id={a.id} name="agreementVersion" required value={draft.version} aria-describedby={a.describedBy} aria-invalid={a.invalid}
            onChange={(e) => onChange({ version: e.target.value })}>
            <option value="">Choose a version</option>
            {versions.map((v) => <option key={v.version} value={v.version}>{`Organisation agreement v${v.version} (published ${formatDay(v.publishedOn)})`}</option>)}
          </select>
        )}
      </Field>
      {draft.version !== '' ? <p style={HINT_STYLE}><Link href={`/legal/organisation-agreement/${encodeURIComponent(draft.version)}`} prefetch={false}>Read this version</Link></p> : null}
      <fieldset className="form-group" aria-describedby={dateDescribedBy}>
        <legend id={legendId}>Date the agreement was accepted</legend>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {(['day', 'month', 'year'] as const).map((part) => (
            <span key={part} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label htmlFor={`${prefix}-${part}`}>{part === 'day' ? 'Day' : part === 'month' ? 'Month' : 'Year'}</label>
              <input id={`${prefix}-${part}`} name={part} type="text" inputMode="numeric" required autoComplete="off"
                size={part === 'year' ? 4 : 2} maxLength={part === 'year' ? 4 : 2} value={draft[part]}
                aria-invalid={errors.day ? true : undefined} aria-describedby={dateDescribedBy}
                onChange={(e) => onChange({ [part]: e.target.value } as Partial<AgreementDraft>)} />
            </span>
          ))}
        </div>
        {errors.day ? <p id={dateErrorId} style={ERROR_STYLE}>{errors.day}</p> : null}
      </fieldset>
      <Field id={`${prefix}-controller`} label="Controller legal name" error={errors.controllerLegalName}>
        {(a) => <input id={a.id} name="controllerLegalName" type="text" required autoComplete="organization" value={draft.controllerLegalName}
          aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => onChange({ controllerLegalName: e.target.value })} />}
      </Field>
      <Field id={`${prefix}-dpo`} label="Data-protection contact email" error={errors.dpContactEmail}>
        {(a) => <input id={a.id} name="dpContactEmail" type="email" required autoComplete="off" spellCheck={false} value={draft.dpContactEmail}
          aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => onChange({ dpContactEmail: e.target.value })} />}
      </Field>
    </>
  );
}

export type CreateOrganisationFormViewProps = {
  draft: CreateDraft; errors: FieldErrors; versions: readonly AgreementVersionOption[];
  status: string; busy: boolean; result: CreateResult | null;
  onChange: (patch: Partial<CreateDraft>) => void; onSubmit: () => void; onRetry: () => void;
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
          {created.acceptUrl !== null || !created.emailSent ? (
            <CopyLinkFallback key={created.invitation.id} noticeShownElsewhere acceptUrl={created.acceptUrl}
              expiresAt={created.invitation.expiresAt} emailSent={created.emailSent} />
          ) : null}
          <p><Link href={`/admin/organisations/${encodeURIComponent(created.orgId)}`} prefetch={false}>Open the organisation</Link></p>
        </>
      ) : (
        <form noValidate onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
          <Field id={`${formId}-name`} label="Organisation name"
            hint="Create one organisation for each team whose members may read each other's records. An institution with several teams gets one organisation for each."
            error={p.errors.name}>
            {(a) => <input id={a.id} name="name" type="text" required maxLength={100} autoComplete="off" value={d.name}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onChange({ name: e.target.value })} />}
          </Field>
          <AgreementFields prefix={`${formId}-agreement`} draft={d} errors={p.errors} versions={p.versions} onChange={p.onChange} />
          <Field id={`${formId}-owner`} label="First owner's email" error={p.errors.ownerEmail}>
            {(a) => <input id={a.id} name="ownerEmail" type="email" required autoComplete="off" spellCheck={false} value={d.ownerEmail}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => p.onChange({ ownerEmail: e.target.value })} />}
          </Field>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
            <input id={`${formId}-show`} name="showLink" type="checkbox" checked={d.showLink} onChange={(e) => p.onChange({ showLink: e.target.checked })} />
            <label htmlFor={`${formId}-show`}>Show link (to send it yourself if the email does not arrive)</label>
          </div>
          <p>Creating the organisation also records the agreement and sends an invitation to the first owner. If any part fails, nothing is created.</p>
          <button type="submit" className="btn btn--primary" aria-disabled={p.busy || undefined}>Create organisation and send invitation</button>
        </form>
      )}
    </div>
  );
}

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<CreateOrganisationResponse>>;

/**
 * S-24 create mode (FR-ORG-01, J-01). Validates every field on submit (7.4.2 S-24 Validation) and moves focus to
 * the first field at fault; then sends route 41 and shows the 7.4.2 texts. `send` and `today` are injectable for the
 * unit tests; the page passes today's date in East Africa Time.
 */
export function CreateOrganisationForm({ versions, today, send }: { versions: readonly AgreementVersionOption[]; today: CalendarDate; send?: Send }): ReactElement {
  const [draft, setDraft] = useState<CreateDraft>({ ...EMPTY_AGREEMENT, name: '', ownerEmail: '', showLink: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const lastBody = useRef<Record<string, unknown> | null>(null);
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
    const e = createErrors(draft, today, versions);
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first !== undefined) {
      setStatus('');
      const input = document.querySelector<HTMLElement>(`form [name="${first === 'version' ? 'agreementVersion' : first}"]`);
      input?.focus();
      return;
    }
    const body = { name: draft.name.trim(), agreement: agreementInputOf(draft, versions), ownerEmail: draft.ownerEmail.trim(), showLink: draft.showLink };
    lastBody.current = body;
    void run(body);
  }

  return (
    <CreateOrganisationFormView draft={draft} errors={errors} versions={versions} status={status} busy={busy} result={result}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} onSubmit={submit}
      onRetry={() => { if (!busy && lastBody.current !== null) void run(lastBody.current); }} />
  );
}
