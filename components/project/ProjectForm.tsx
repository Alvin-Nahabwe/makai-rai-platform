'use client';

import './ProjectForm.css';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ListLink } from '@/components/ui/ListLink';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DateField } from '@/components/ui/DateField';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { FieldError, FieldLabel } from '@/components/ui/TextInput';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { DATASET_SIZE_WORDS, LIFECYCLE_STAGE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { PROJECT_WRITE_COPY } from '@/lib/project/write/copy';
import { datePartsOf, parseDateParts } from '@/lib/ui/dateParts';
import { signInAgainHref } from '@/lib/auth/idle';
import { formRefusalOf } from '@/lib/projects/writeRefusal';
import type { DateParts } from '@/components/ui/types';
import type { CalendarDate, FieldError as ApiFieldError } from '@/types/record';
import type { PROJECT_METADATA_FIELDS } from '@/lib/validate';
import '@/components/ui/textAreaStyles';
import '@/components/ui/selectStyles';
import '@/components/ui/buttonStyles';

const C = PROJECT_FORM_COPY;

export type ProjectFormValues = { name: string; description: string } &
  Partial<Record<(typeof PROJECT_METADATA_FIELDS)[number], string | boolean | number | null>>;

type Mode = { mode: 'create' } | { mode: 'edit'; projectId: string; initial: ProjectFormValues };

/** Every text-like field of the form, as strings. */
const TEXT_FIELDS = [
  'name', 'aiSystemType', 'aiSystemTypeOther', 'description', 'institution', 'department', 'country', 'deploymentSector', 'targetPopulation',
  'teamSize', 'datasetType', 'datasetSize', 'processesPersonalData', 'fundingSource', 'regulatoryContext', 'developmentStage',
] as const;
/** The two dates, each the kit's DateField: three boxes, held as DateParts. */
const DATE_FIELDS = ['projectStart', 'projectEnd'] as const;
type TextFieldName = (typeof TEXT_FIELDS)[number];
type DateFieldName = (typeof DATE_FIELDS)[number];
export type FormState = Record<TextFieldName, string> & Record<DateFieldName, DateParts>;

const isDateField = (field: string): field is DateFieldName => (DATE_FIELDS as readonly string[]).includes(field);

export function initialState(p: Mode): FormState {
  const texts = Object.fromEntries(TEXT_FIELDS.map((f) => [f, ''])) as Record<TextFieldName, string>;
  if (p.mode === 'create') return { ...texts, projectStart: datePartsOf(null), projectEnd: datePartsOf(null) };
  for (const f of TEXT_FIELDS) {
    const v = p.initial[f];
    texts[f] = v === null || v === undefined ? '' : String(v);
  }
  // An absent key is no date, as an absent text is ''. The edit page passes 'YYYY-MM-DD' or null (edit/page.tsx); any
  // other string throws in datePartsOf, by design.
  const dateOf = (f: DateFieldName) => datePartsOf((p.initial[f] ?? null) as CalendarDate | null);
  return { ...texts, projectStart: dateOf('projectStart'), projectEnd: dateOf('projectEnd') };
}

/** What a submit does: the request body, or the form's own errors (name first, then the dates) and nothing sent. */
export type Submission = { kind: 'body'; body: Record<string, unknown> } | { kind: 'errors'; errors: ApiFieldError[] };

/**
 * The form's own check, then the request body: a filled field as its typed value; an emptied field as `null` when editing
 * (clears it), left out when creating. The Other text is sent only while the type is Other, so choosing another type
 * clears it on edit. A date is sent as YYYY-MM-DD; an incomplete one, or one the calendar does not have, is an error.
 */
export function submissionOf(form: FormState, editing: boolean): Submission {
  const errors: ApiFieldError[] = [];
  if (!form.name.trim()) errors.push({ field: 'name', message: C.nameRequired });
  const dates = {} as Record<DateFieldName, CalendarDate | null>;
  for (const f of DATE_FIELDS) {
    const r = parseDateParts(form[f]);
    if (r.ok) dates[f] = r.value;
    else errors.push({ field: f, message: C.dateInvalid });
  }
  if (errors.length > 0) return { kind: 'errors', errors };

  const body: Record<string, unknown> = { name: form.name.trim(), description: form.description.trim() };
  for (const f of TEXT_FIELDS) {
    if (f === 'name' || f === 'description' || f === 'aiSystemTypeOther') continue;
    const v = form[f].trim();
    if (v === '') { if (editing) body[f] = null; continue; }
    if (f === 'processesPersonalData') body[f] = v === 'true';
    // A whole number goes as a number; any other text goes as typed, so the server refuses it with its own message beside
    // the field. Never Number() of other text: NaN is written as null and would clear the field silently (review F1).
    else if (f === 'teamSize') body[f] = /^\d+$/.test(v) ? Number(v) : v;
    else body[f] = v;
  }
  const other = form.aiSystemTypeOther.trim();
  if (form.aiSystemType === 'other' && other !== '') body.aiSystemTypeOther = other;
  else if (editing) body.aiSystemTypeOther = null;
  for (const f of DATE_FIELDS) {
    if (dates[f] !== null) body[f] = dates[f];
    else if (editing) body[f] = null;
  }
  return { kind: 'body', body };
}

/** The id an error summary's link goes to: a date has no element of its own id, so its link goes to its Day box. */
export function summaryTargetOf(field: string): string {
  return isDateField(field) ? `${field}-day` : field;
}

/**
 * One field of the form, from the kit's exported parts (plan 1A Task 17): the label (with "(required)" in words when the
 * field is required), the native control the caller passes, wearing the kit's control classes, then the kit's error
 * with the id `{id}-error`. The kit's TextInput, TextArea and Select cannot carry what these controls need (a
 * placeholder, a number or date type, no count line, the absent `aria-invalid` and `name` the form had), so the field is
 * composed here.
 */
function Field({ id, label, required = false, error, children }: { id: string; label: string; required?: boolean; error?: string; children: ReactNode }): ReactElement {
  return (
    <div className="ui-field">
      <FieldLabel htmlFor={id} label={label} required={required} />
      {children}
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
    </div>
  );
}

/** A native select inside the kit's wrapper, with the kit's chevron. */
function SelectBox({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="ui-select__wrap">
      {children}
      <span className="ui-select__icon"><Icon name="chevron-down" size={20} /></span>
    </div>
  );
}

/**
 * S-09, create and edit (FR-PRJ-01, UX-27; SRS row S-09). Create POSTs route 23 and edit PATCHes route 24, each through
 * `sendWrite` with a request id from `requestIdFor`: the same id when the same form is sent again after a lost
 * connection, a new one once any field was edited. The role gate lives one layer up, in the server component of the page
 * (D-127). The words of the dataset size, personal data and development status options come from `lib/project/labels.ts`,
 * so the form and a generated document cannot differ (owner default B37).
 */
export default function NewProjectForm(p: Mode) {
  const router = useRouter();
  const params = useParams();
  const orgSlug = (params?.slug ?? '') as string;
  const editing = p.mode === 'edit';
  const [form, setForm] = useState<FormState>(() => initialState(p));
  const [showDetails, setShowDetails] = useState(editing);
  // The details animate only once the person has pressed the toggle: shown on load (edit mode) or opened for a refused
  // field, they appear without motion (nothing moves on page load).
  const [toggled, setToggled] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<{ text: string; errors: ApiFieldError[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const sending = useRef(false);   // Enter in a field submits without the button, so the handler refuses a second send itself
  const summaryTitle = useRef<HTMLHeadingElement>(null);

  // The kit's summary does not focus itself: after each refused submit its title takes focus, so it is read out.
  useEffect(() => { if (summary !== null) summaryTitle.current?.focus(); }, [summary]);

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    setError('');
    setFieldErrors({});
    setSummary(null);
    const submission = submissionOf(form, editing);
    if (submission.kind === 'errors') {
      // The form's own check: each message beside its field and in the summary, as a refusal from the server is shown.
      setFieldErrors(Object.fromEntries(submission.errors.map((f) => [f.field, f.message])));
      setSummary({ text: PROJECT_WRITE_COPY.summary(submission.errors.length), errors: submission.errors });
      if (submission.errors.some((f) => isDateField(f.field))) setShowDetails(true);   // a date's message could not be seen in the closed section
      return;
    }
    sending.current = true;
    setLoading(true);
    setSlow(false);
    let navigating = false;   // saved: the form stays busy, and refuses a second send, until the new page replaces it
    try {
      const { body } = submission;
      const { requestId, state } = requestIdFor(retry.current, body);
      retry.current = state;
      const url = editing ? `/api/v1/orgs/${orgSlug}/projects/${p.projectId}` : `/api/v1/orgs/${orgSlug}/projects`;
      const outcome = await sendWrite<{ id: string }>(url, editing ? 'PATCH' : 'POST', { ...body, requestId }, { onSlow: () => setSlow(true) });
      if (outcome.kind === 'saved') {
        navigating = true;
        retry.current = { requestId: null, sentBody: null };
        router.push(`/orgs/${orgSlug}/projects/${outcome.body.id}`);
        return;
      }
      if (outcome.kind === 'not_saved') {
        // The same form sent again keeps its request id, so a request that had arrived is answered again, not repeated:
        // the line says the outcome is not known and that sending again is safe.
        setError(editing ? C.noReply.save : C.noReply.create);
        return;
      }
      const r = formRefusalOf(outcome.status, outcome.body);
      if (r.kind === 'fields') {
        setFieldErrors(Object.fromEntries(r.fields.map((f) => [f.field, f.message])));
        setSummary({ text: r.summary, errors: r.fields });
        if (r.openDetails) setShowDetails(true);   // a message inside the closed section could not be seen
      } else if (r.kind === 'signin') {
        window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
      } else {
        if (r.kind === 'stop') retry.current = { requestId: null, sentBody: null };   // the same request would be refused again
        setError(r.line);
      }
    } finally {
      if (!navigating) {
        sending.current = false;
        setLoading(false);
        setSlow(false);
      }
    }
  }

  /** The error linked to its control, so a screen reader reads it with the field (WCAG 3.3.1). */
  const fieldA = (name: string) => (fieldErrors[name] ? { 'aria-invalid': true as const, 'aria-describedby': `${name}-error` } : {});
  const inputClass = (name: string) => (fieldErrors[name] ? 'ui-input ui-input--invalid' : 'ui-input');
  const selectClass = (name: string) => (fieldErrors[name] ? 'ui-select ui-select--invalid' : 'ui-select');
  /** A one-line text field: the label, the native input in the kit's classes, the error. */
  const text = (name: Exclude<TextFieldName, 'description'>, label: string, placeholder?: string) => (
    <Field id={name} label={label} error={fieldErrors[name]}>
      <input
        id={name} className={inputClass(name)} {...fieldA(name)} type="text" placeholder={placeholder}
        value={form[name]} onChange={(e) => updateField(name, e.target.value)}
      />
    </Field>
  );
  /** A select of the descriptive words, "Not chosen" first. */
  const select = (name: TextFieldName, label: string, words: Readonly<Record<string, string>>) => (
    <Field id={name} label={label} error={fieldErrors[name]}>
      <SelectBox>
        <select id={name} className={selectClass(name)} {...fieldA(name)} value={form[name]} onChange={(e) => updateField(name, e.target.value)}>
          <option value="">{C.notChosen}</option>
          {Object.entries(words).map(([value, w]) => <option key={value} value={value}>{w}</option>)}
        </select>
      </SelectBox>
    </Field>
  );
  const L = C.labels;
  const P = C.placeholders;

  return (
    <div className="page-content">
      <ListLink href={`/orgs/${orgSlug}/projects`} className="back-link project-form__back">
        <Icon name="chevron-left" size={16} />{C.back}
      </ListLink>
      <PageHeader title={editing ? C.headingEdit : C.headingCreate} lead={editing ? C.leadEdit : C.leadCreate} />

      <div className="form-container">
        <StatusRegion message={error === '' ? null : error} politeness="assertive" tone="error" />
        {summary ? (
          <ErrorSummary ref={summaryTitle} title={summary.text} errors={summary.errors.map((f) => ({ fieldId: summaryTargetOf(f.field), message: f.message }))} />
        ) : null}

        <form method="post" noValidate onSubmit={handleSubmit}>
          <section aria-labelledby="project-about-title">
            <h2 id="project-about-title" className="project-form__section-title">{C.sectionAbout}</h2>
            <Field id="name" label={L.name} required error={fieldErrors.name}>
              <input
                id="name" className={inputClass('name')} {...fieldA('name')} type="text" aria-required="true" placeholder={P.name}
                value={form.name} onChange={(e) => updateField('name', e.target.value)}
              />
            </Field>

            <Field id="aiSystemType" label={L.aiSystemType} error={fieldErrors.aiSystemType}>
              <SelectBox>
                <select id="aiSystemType" className={selectClass('aiSystemType')} {...fieldA('aiSystemType')} value={form.aiSystemType} onChange={(e) => updateField('aiSystemType', e.target.value)}>
                  <option value="">{C.notChosen}</option>
                  {C.aiSystemTypes.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </SelectBox>
            </Field>

            {form.aiSystemType === 'other' ? text('aiSystemTypeOther', L.aiSystemTypeOther) : null}

            <Field id="description" label={L.description} error={fieldErrors.description}>
              <textarea
                id="description" className={fieldErrors.description ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'} {...fieldA('description')}
                rows={3} placeholder={P.description} value={form.description} onChange={(e) => updateField('description', e.target.value)}
              />
            </Field>
          </section>

          <div className="form-section-toggle">
            <button
              type="button" className="ui-button ui-button--quiet" aria-expanded={showDetails} aria-controls="project-details"
              onClick={() => { setToggled(true); setShowDetails(!showDetails); }}
            >
              <span className="ui-button__icon"><Icon name={showDetails ? 'chevron-down' : 'chevron-right'} size={20} /></span>
              {showDetails ? C.hideDetails : C.showDetails}
            </button>
            <span className="text-muted project-form__optional">{C.optional}</span>
          </div>

          <section
            id="project-details" aria-labelledby="project-details-title" className="form-details"
            data-toggled={toggled ? '' : undefined} hidden={!showDetails}
          >
            <h2 id="project-details-title" className="project-form__section-title">{C.sectionDetails}</h2>
            <div className="form-row">
              {text('deploymentSector', L.deploymentSector, P.deploymentSector)}
              {text('datasetType', L.datasetType, P.datasetType)}
            </div>

            <div className="form-row">
              {select('datasetSize', L.datasetSize, DATASET_SIZE_WORDS)}
              {select('processesPersonalData', L.processesPersonalData, PERSONAL_DATA_WORDS)}
            </div>

            <div className="form-row">
              {text('fundingSource', L.fundingSource)}
              {text('regulatoryContext', L.regulatoryContext, P.regulatoryContext)}
            </div>

            <div className="form-row">
              {select('developmentStage', L.developmentStage, LIFECYCLE_STAGE_WORDS)}
              <Field id="teamSize" label={L.teamSize} error={fieldErrors.teamSize}>
                <input id="teamSize" className={inputClass('teamSize')} {...fieldA('teamSize')} type="text" inputMode="numeric" value={form.teamSize} onChange={(e) => updateField('teamSize', e.target.value)} />
              </Field>
            </div>

            <div className="form-row">
              <DateField
                idPrefix="projectStart" legend={L.projectStart} value={form.projectStart}
                onChange={(v) => updateField('projectStart', v)} error={fieldErrors.projectStart}
              />
              <DateField
                idPrefix="projectEnd" legend={L.projectEnd} value={form.projectEnd}
                onChange={(v) => updateField('projectEnd', v)} error={fieldErrors.projectEnd}
              />
            </div>

            <div className="form-row">
              {text('institution', L.institution, P.institution)}
              {text('department', L.department, P.department)}
            </div>

            <div className="form-row">
              {text('country', L.country)}
              {text('targetPopulation', L.targetPopulation, P.targetPopulation)}
            </div>
          </section>

          <div className="form-actions project-form__actions">
            <Button variant="primary" type="submit" busy={loading}>
              {loading ? (editing ? C.saving : C.creating) : editing ? C.save : C.create}
            </Button>
            <ButtonLink variant="quiet" href={editing ? `/orgs/${orgSlug}/projects/${p.projectId}` : `/orgs/${orgSlug}/projects`}>{C.cancel}</ButtonLink>
          </div>
          <p role="status">{slow ? C.slow : ''}</p>
        </form>
      </div>
    </div>
  );
}
