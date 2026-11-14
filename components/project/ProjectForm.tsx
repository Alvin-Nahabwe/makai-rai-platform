'use client';

import './ProjectForm.css';
import '@/components/ui/TextArea.css';
import '@/components/ui/Select.css';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ListLink } from '@/components/ui/ListLink';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { FieldError, FieldLabel } from '@/components/ui/TextInput';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { DATASET_SIZE_WORDS, LIFECYCLE_STAGE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { signInAgainHref } from '@/lib/auth/idle';
import { formRefusalOf } from '@/lib/projects/writeRefusal';
import type { FieldError as ApiFieldError } from '@/types/record';
import type { PROJECT_METADATA_FIELDS } from '@/lib/validate';

const C = PROJECT_FORM_COPY;

export type ProjectFormValues = { name: string; description: string } &
  Partial<Record<(typeof PROJECT_METADATA_FIELDS)[number], string | boolean | number | null>>;

type Mode = { mode: 'create' } | { mode: 'edit'; projectId: string; initial: ProjectFormValues };

/** Every text-like field of the form, as strings. */
const TEXT_FIELDS = [
  'name', 'aiSystemType', 'description', 'institution', 'department', 'country', 'deploymentSector', 'targetPopulation', 'teamSize',
  'datasetType', 'datasetSize', 'processesPersonalData', 'fundingSource', 'regulatoryContext', 'developmentStage', 'projectStart', 'projectEnd',
] as const;
type FieldName = (typeof TEXT_FIELDS)[number];
type FormState = Record<FieldName, string>;

function initialState(p: Mode): FormState {
  const blank = Object.fromEntries(TEXT_FIELDS.map((f) => [f, ''])) as FormState;
  if (p.mode === 'create') return blank;
  for (const f of TEXT_FIELDS) {
    const v = p.initial[f];
    blank[f] = v === null || v === undefined ? '' : String(v);
  }
  return blank;
}

/** The request body: a filled field as its typed value; an emptied field as `null` when editing (clears it), left out when creating. */
function bodyOf(form: FormState, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { name: form.name.trim(), description: form.description.trim() };
  const blank = editing ? null : undefined;
  for (const f of TEXT_FIELDS) {
    if (f === 'name' || f === 'description') continue;
    const v = form[f].trim();
    if (v === '') { if (blank !== undefined) body[f] = blank; continue; }
    if (f === 'processesPersonalData') body[f] = v === 'true';
    else if (f === 'teamSize') body[f] = Number(v);
    else body[f] = v;
  }
  return body;
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

  function updateField(field: FieldName, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    setError('');
    setFieldErrors({});
    setSummary(null);
    if (!form.name.trim()) {
      setError(C.nameRequired);
      return;
    }
    sending.current = true;
    setLoading(true);
    setSlow(false);
    let navigating = false;   // saved: the form stays busy, and refuses a second send, until the new page replaces it
    try {
      const body = bodyOf(form, editing);
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
  const text = (name: Exclude<FieldName, 'description'>, label: string, placeholder?: string) => (
    <Field id={name} label={label} error={fieldErrors[name]}>
      <input
        id={name} className={inputClass(name)} {...fieldA(name)} type="text" placeholder={placeholder}
        value={form[name]} onChange={(e) => updateField(name, e.target.value)}
      />
    </Field>
  );
  /** A select of the descriptive words, "Not chosen" first. */
  const select = (name: FieldName, label: string, words: Readonly<Record<string, string>>) => (
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
          <ErrorSummary ref={summaryTitle} title={summary.text} errors={summary.errors.map((f) => ({ fieldId: f.field, message: f.message }))} />
        ) : null}

        <form method="post" onSubmit={handleSubmit}>
          <Field id="name" label={L.name} required error={fieldErrors.name}>
            <input
              id="name" className={inputClass('name')} {...fieldA('name')} type="text" required placeholder={P.name}
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

          <Field id="description" label={L.description} error={fieldErrors.description}>
            <textarea
              id="description" className={fieldErrors.description ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'} {...fieldA('description')}
              rows={3} placeholder={P.description} value={form.description} onChange={(e) => updateField('description', e.target.value)}
            />
          </Field>

          <div className="form-section-toggle">
            <button
              type="button" className="ui-button ui-button--quiet" aria-expanded={showDetails} aria-controls="project-details"
              onClick={() => { setToggled(true); setShowDetails(!showDetails); }}
            >
              <span className="ui-button__icon"><Icon name={showDetails ? 'chevron-down' : 'chevron-right'} size={20} /></span>
              {C.moreDetails}
            </button>
            <span className="text-muted project-form__optional">{C.optional}</span>
          </div>

          <div id="project-details" className="form-details" data-toggled={toggled ? '' : undefined} hidden={!showDetails}>
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
                <input id="teamSize" className={inputClass('teamSize')} {...fieldA('teamSize')} type="number" min="0" value={form.teamSize} onChange={(e) => updateField('teamSize', e.target.value)} />
              </Field>
            </div>

            <div className="form-row">
              <Field id="projectStart" label={L.projectStart} error={fieldErrors.projectStart}>
                <input id="projectStart" className={inputClass('projectStart')} {...fieldA('projectStart')} type="date" value={form.projectStart} onChange={(e) => updateField('projectStart', e.target.value)} />
              </Field>
              <Field id="projectEnd" label={L.projectEnd} error={fieldErrors.projectEnd}>
                <input id="projectEnd" className={inputClass('projectEnd')} {...fieldA('projectEnd')} type="date" value={form.projectEnd} onChange={(e) => updateField('projectEnd', e.target.value)} />
              </Field>
            </div>

            <div className="form-row">
              {text('institution', L.institution, P.institution)}
              {text('department', L.department, P.department)}
            </div>

            <div className="form-row">
              {text('country', L.country)}
              {text('targetPopulation', L.targetPopulation, P.targetPopulation)}
            </div>
          </div>

          <div className="form-actions">
            <ButtonLink variant="secondary" href={editing ? `/orgs/${orgSlug}/projects/${p.projectId}` : `/orgs/${orgSlug}/projects`}>{C.cancel}</ButtonLink>
            <Button variant="primary" type="submit" busy={loading}>
              {loading ? (editing ? C.saving : C.creating) : editing ? C.save : C.create}
            </Button>
          </div>
          <p role="status">{slow ? C.slow : ''}</p>
        </form>
      </div>
    </div>
  );
}
