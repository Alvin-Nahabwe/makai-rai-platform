'use client';

import { useId, useState, type ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { ErrorSummary, Field, StatusLine, useFindingWrite } from '@/components/findings/FindingActions';
import { characterCount, charCount, KEPT_IN_FORM, raiseFormErrors, TEXT_MAX, type RaiseFormValue } from '@/lib/findings/formRules';
import { STAGE_NAMES } from '@/lib/findings/labels';
import type { RaiseFormData } from '@/lib/findings/pageData';
import { STAGES, type FieldError } from '@/types/record';
import type { FindingView } from '@/types/api';

export type RaiseFindingFormProps = { orgSlug: string; projectId: string; data: RaiseFormData };

/**
 * "Raise a finding" on S-14 (FR-FND-02; SRS 7.4.2 S-14 row; UX-14): a title, a description, a stage, and optionally one risk
 * area. Opened from S-12 it has the stage filled in, the question's own risk areas listed first with the first chosen, and the line
 * "About question <id> (version <n>)". Raise finding sends route 5 with a request id kept for Retry; "Raising..." then
 * "Finding raised. [Open it]". Nothing is sent when Title or Stage is empty: the summary takes focus and names each field.
 */
export function RaiseFindingForm({ orgSlug, projectId, data }: RaiseFindingFormProps): ReactElement {
  const id = `raise-${useId().replace(/:/g, '')}`;
  const prefill = data.prefill;
  const firstArea = prefill?.areaIds[0] ?? '';
  const [v, setV] = useState<RaiseFormValue>({ title: '', description: '', stage: prefill?.stage ?? '', riskArea: firstArea });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [raised, setRaised] = useState<string | null>(null);
  const w = useFindingWrite(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/findings`, KEPT_IN_FORM);
  const stage = (STAGES as readonly string[]).includes(v.stage) ? (v.stage as keyof RaiseFormData['areas']) : null;
  // The question link holds only while the stage is still the question's own.
  const linked = prefill !== null && prefill.stage === v.stage;
  const areas = stage === null ? [] : data.areas[stage];
  const ordered = linked ? [...areas].sort((a, b) => Number(prefill.areaIds.includes(b.id)) - Number(prefill.areaIds.includes(a.id)) || 0) : areas;
  const err = (field: string) => errors.find((e) => e.field === field)?.message ?? w.failure?.fields.find((e) => e.field === field)?.message ?? null;
  const all = [...errors, ...(w.failure?.fields ?? [])];

  const submit = async () => {
    const problems = raiseFormErrors(v);
    setErrors(problems); setAttempt((n) => n + 1); setRaised(null);
    if (problems.length > 0) return;
    const sent = await w.send<FindingView>({
      stage: v.stage, title: v.title, description: v.description, riskArea: v.riskArea === '' ? null : v.riskArea,
      questionId: linked ? prefill.questionId : null, decisionVersionId: linked ? prefill.versionId : null,
    });
    if (sent === null) return;
    setRaised(sent.body.id);
    setV({ title: '', description: '', stage: v.stage, riskArea: '' });
  };
  const set = (patch: Partial<RaiseFormValue>) => { setV((x) => ({ ...x, ...patch })); setErrors([]); };

  return (
    <form id="raise" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Raise a finding</h2>
      <ErrorSummary summary={all.length === 1 ? 'There is a problem with this finding. What you typed is kept.' : `There are ${all.length} problems with this finding. What you typed is kept.`} errors={all} focusKey={attempt} />
      {linked ? <p>About question <bdi>{prefill.questionId}</bdi>{prefill.versionNumber === null ? '' : ` (version ${prefill.versionNumber})`}</p> : null}
      <Field id="title" label="Title" error={err('title')} render={(a) => <input {...a} name="title" type="text" value={v.title} onChange={(e) => set({ title: e.target.value })} />} />
      <Field id="description" label="Description" error={err('description')} help="Say what the problem is and who it may affect."
        render={(a) => <textarea {...a} name="description" rows={4} value={v.description} onChange={(e) => set({ description: e.target.value })} />} />
      <p className="text-muted">{characterCount(charCount(v.description), TEXT_MAX)}</p>
      <Field id="stage" label="Stage" error={err('stage')} render={(a) => (
        <select {...a} name="stage" value={v.stage} onChange={(e) => set({ stage: e.target.value, riskArea: '' })}>
          <option value="">Choose a stage</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_NAMES[s]}</option>)}
        </select>
      )} />
      <Field id="riskArea" label="Risk area (optional)" error={err('riskArea')} render={(a) => (
        <select {...a} name="riskArea" value={v.riskArea} onChange={(e) => set({ riskArea: e.target.value })}>
          <option value="">No risk area</option>
          {ordered.map((area) => <option key={area.id} value={area.id}>{area.id} {area.name}</option>)}
        </select>
      )} />
      <div className="form-actions">
        <button type="submit" className="btn btn--primary" disabled={w.phase !== 'idle'}>Raise finding</button>
      </div>
      {w.failure !== null && w.failure.fields.length === 0 ? <p role="alert">{w.failure.text}</p> : null}
      <StatusLine>
        {w.phase === 'saving' ? 'Raising...' : w.phase === 'slow' ? 'Still saving. The connection is slow. What you typed is still in the form.'
          : raised === null ? null : <>Finding raised. <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${raised}`}>Open it</ListLink></>}
      </StatusLine>
    </form>
  );
}
