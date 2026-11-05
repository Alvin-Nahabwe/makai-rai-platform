'use client';

import { useRef, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ListLink } from '@/components/ui/ListLink';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { LIFECYCLE_STAGE_WORDS } from '@/lib/projects/metadataValues';
import { signInAgainHref } from '@/lib/auth/idle';
import type { PROJECT_METADATA_FIELDS } from '@/lib/validate';

const AI_SYSTEM_TYPES = [
  { value: '', label: 'Select AI system type...' },
  { value: 'classification', label: 'Classification' },
  { value: 'regression', label: 'Regression' },
  { value: 'nlp', label: 'Natural Language Processing' },
  { value: 'computer_vision', label: 'Computer Vision' },
  { value: 'recommendation', label: 'Recommendation System' },
  { value: 'generative_ai', label: 'Generative AI' },
  { value: 'other', label: 'Other' },
];


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
 * S-09, create and edit (FR-PRJ-01, UX-27; SRS row S-09). Create POSTs route 23 and edit PATCHes route 24, each through
 * `sendWrite` with a request id from `requestIdFor`: the same id when the same form is sent again after a lost
 * connection, a new one once any field was edited. The role gate lives one layer up, in the server component of the page
 * (D-127). The words of the dataset size and personal data options come from `lib/project/labels.ts`, so the form and a
 * generated document cannot differ (owner default B37).
 */
export default function NewProjectForm(p: Mode) {
  const router = useRouter();
  const params = useParams();
  const orgSlug = (params?.slug ?? '') as string;
  const editing = p.mode === 'edit';
  const [form, setForm] = useState<FormState>(() => initialState(p));
  const [showDetails, setShowDetails] = useState(editing);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });

  function updateField(field: FieldName, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    if (!form.name.trim()) {
      setError('Project name is required');
      return;
    }
    setLoading(true);
    setSlow(false);
    try {
      const body = bodyOf(form, editing);
      const { requestId, state } = requestIdFor(retry.current, body);
      retry.current = state;
      const url = editing ? `/api/v1/orgs/${orgSlug}/projects/${p.projectId}` : `/api/v1/orgs/${orgSlug}/projects`;
      const outcome = await sendWrite<{ id: string }>(url, editing ? 'PATCH' : 'POST', { ...body, requestId }, { onSlow: () => setSlow(true) });
      if (outcome.kind === 'saved') {
        retry.current = { requestId: null, sentBody: null };
        router.push(`/orgs/${orgSlug}/projects/${outcome.body.id}`);
        return;
      }
      if (outcome.kind === 'not_saved') {
        // The same form sent again keeps its request id, so a request that had arrived is answered again, not repeated.
        setError('Something went wrong. Please try again.');
        return;
      }
      const rejected = outcome.body as { error: string; code: string; fields?: Array<{ field: string; message: string }> };
      if (rejected.fields !== undefined && rejected.fields.length > 0) {
        setFieldErrors(Object.fromEntries(rejected.fields.map((f) => [f.field, f.message])));
        // A field this form has no control for would otherwise show nothing at all.
        const unshown = rejected.fields.filter((f) => !(TEXT_FIELDS as readonly string[]).includes(f.field));
        if (unshown.length > 0) setError(unshown.map((f) => f.message).join(' '));
      } else if (outcome.status === 401) {
        window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
      } else if (outcome.status === 403 || outcome.status === 404) {
        // The same request would be refused again, so the id is dropped and the person is told why (F8).
        retry.current = { requestId: null, sentBody: null };
        setError(outcome.status === 403 ? 'You can no longer change this project.' : 'This project no longer exists.');
      } else if (rejected.code === 'project_archived') {
        setError('This project is archived. Nothing in it can be changed.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
      setSlow(false);
    }
  }

  const fieldError = (name: string) => (fieldErrors[name] ? <div className="form-error" id={`${name}-error`}>{fieldErrors[name]}</div> : null);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <ListLink href={`/orgs/${orgSlug}/projects`} className="back-link">← Back to Projects</ListLink>
          <h1>{editing ? 'Edit project' : 'New Project'}</h1>
          <p className="text-muted">{editing ? 'Change the name, the description and the descriptive fields' : 'Register a new AI system for responsible AI assessment'}</p>
        </div>
      </div>

      <div className="form-container">
        {error && <div className="form-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="name">Project name <span className="required">*</span></label>
            <input
              id="name" type="text" required placeholder="e.g., Patient Triage ML Model"
              value={form.name} onChange={(e) => updateField('name', e.target.value)}
            />
            {fieldError('name')}
          </div>

          <div className="form-group">
            <label htmlFor="aiSystemType">AI system type</label>
            <select id="aiSystemType" value={form.aiSystemType} onChange={(e) => updateField('aiSystemType', e.target.value)}>
              {AI_SYSTEM_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {fieldError('aiSystemType')}
          </div>

          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description" rows={3} placeholder="Brief description of the AI system and its purpose..."
              value={form.description} onChange={(e) => updateField('description', e.target.value)}
            />
            {fieldError('description')}
          </div>

          <div className="form-section-toggle">
            <button
              type="button" className="toggle-btn" aria-expanded={showDetails} aria-controls="project-details"
              onClick={() => setShowDetails(!showDetails)}
            >
              <span className={`toggle-icon ${showDetails ? 'open' : ''}`} aria-hidden="true">▶</span>
              Show additional details
            </button>
            <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              Optional — can be added later
            </span>
          </div>

          <div id="project-details" className="form-details" hidden={!showDetails}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="deploymentSector">Sector</label>
                <input id="deploymentSector" type="text" placeholder="e.g., Healthcare, Agriculture" value={form.deploymentSector} onChange={(e) => updateField('deploymentSector', e.target.value)} />
                {fieldError('deploymentSector')}
              </div>
              <div className="form-group">
                <label htmlFor="datasetType">Dataset type</label>
                <input id="datasetType" type="text" placeholder="e.g., Tabular, images" value={form.datasetType} onChange={(e) => updateField('datasetType', e.target.value)} />
                {fieldError('datasetType')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="datasetSize">Dataset size</label>
                <select id="datasetSize" value={form.datasetSize} onChange={(e) => updateField('datasetSize', e.target.value)}>
                  <option value="">Not chosen</option>
                  {Object.entries(DATASET_SIZE_WORDS).map(([value, words]) => <option key={value} value={value}>{words}</option>)}
                </select>
                {fieldError('datasetSize')}
              </div>
              <div className="form-group">
                <label htmlFor="processesPersonalData">Personal data</label>
                <select id="processesPersonalData" value={form.processesPersonalData} onChange={(e) => updateField('processesPersonalData', e.target.value)}>
                  <option value="">Not chosen</option>
                  {Object.entries(PERSONAL_DATA_WORDS).map(([value, words]) => <option key={value} value={value}>{words}</option>)}
                </select>
                {fieldError('processesPersonalData')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="fundingSource">Funding source</label>
                <input id="fundingSource" type="text" value={form.fundingSource} onChange={(e) => updateField('fundingSource', e.target.value)} />
                {fieldError('fundingSource')}
              </div>
              <div className="form-group">
                <label htmlFor="regulatoryContext">Regulatory context</label>
                <input id="regulatoryContext" type="text" placeholder="e.g., a national data-protection act" value={form.regulatoryContext} onChange={(e) => updateField('regulatoryContext', e.target.value)} />
                {fieldError('regulatoryContext')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="developmentStage">Lifecycle stage</label>
                <select id="developmentStage" value={form.developmentStage} onChange={(e) => updateField('developmentStage', e.target.value)}>
                  <option value="">Not chosen</option>
                  {Object.entries(LIFECYCLE_STAGE_WORDS).map(([value, words]) => <option key={value} value={value}>{words}</option>)}
                </select>
                {fieldError('developmentStage')}
              </div>
              <div className="form-group">
                <label htmlFor="teamSize">Team size</label>
                <input id="teamSize" type="number" min="0" placeholder="e.g., 5" value={form.teamSize} onChange={(e) => updateField('teamSize', e.target.value)} />
                {fieldError('teamSize')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="projectStart">Start date</label>
                <input id="projectStart" type="date" value={form.projectStart} onChange={(e) => updateField('projectStart', e.target.value)} />
                {fieldError('projectStart')}
              </div>
              <div className="form-group">
                <label htmlFor="projectEnd">End date</label>
                <input id="projectEnd" type="date" value={form.projectEnd} onChange={(e) => updateField('projectEnd', e.target.value)} />
                {fieldError('projectEnd')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="institution">Institution</label>
                <input id="institution" type="text" placeholder="e.g., your institute, ministry, or research organisation" value={form.institution} onChange={(e) => updateField('institution', e.target.value)} />
                {fieldError('institution')}
              </div>
              <div className="form-group">
                <label htmlFor="department">Department</label>
                <input id="department" type="text" placeholder="e.g., Computer Science" value={form.department} onChange={(e) => updateField('department', e.target.value)} />
                {fieldError('department')}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="country">Country</label>
                <input id="country" type="text" placeholder="e.g., Uganda" value={form.country} onChange={(e) => updateField('country', e.target.value)} />
                {fieldError('country')}
              </div>
              <div className="form-group">
                <label htmlFor="targetPopulation">Target population</label>
                <input id="targetPopulation" type="text" placeholder="e.g., Rural communities in East Africa" value={form.targetPopulation} onChange={(e) => updateField('targetPopulation', e.target.value)} />
                {fieldError('targetPopulation')}
              </div>
            </div>
          </div>

          <div className="form-actions">
            <ListLink href={editing ? `/orgs/${orgSlug}/projects/${p.projectId}` : `/orgs/${orgSlug}/projects`} className="btn btn--secondary">Cancel</ListLink>
            <button type="submit" className="btn btn--primary btn--large" disabled={loading}>
              {loading ? (editing ? 'Saving...' : 'Creating...') : editing ? 'Save changes' : 'Create project'}
            </button>
          </div>
          <p role="status">{slow ? 'Still saving. The connection is slow.' : ''}</p>
        </form>
      </div>
    </div>
  );
}
