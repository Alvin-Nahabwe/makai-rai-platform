'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ListLink } from '@/components/ui/ListLink';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { ErrorSummary, Field, StatusLine, useFindingWrite } from '@/components/findings/FindingActions';
import { characterCount, charCount, KEPT_IN_FORM, raiseFormErrors, raiseRequestBody, TEXT_MAX, type RaiseFormValue } from '@/lib/findings/formRules';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { STAGE_NAMES } from '@/lib/findings/labels';
import type { RaiseFormData } from '@/lib/findings/pageData';
import { STAGES, type FieldError } from '@/types/record';
import type { FindingView } from '@/types/api';

export type RaiseFindingFormProps = { orgSlug: string; projectId: string; data: RaiseFormData };

const C = FINDINGS_COPY.raise;

/**
 * "Raise a finding" on S-14 (FR-FND-02; SRS 7.4.2 S-14 row; UX-14): a title, a description, a stage, and optionally one risk
 * area. Opened from S-12 it has the stage filled in, the question's own risk areas listed first with the first chosen, and the line
 * "About question: <question>". Raise finding sends route 5 with a request id kept for Retry; "Raising..." then
 * "Finding raised. [View the finding]". Nothing is sent when Title or Stage is empty: the summary takes focus and names each
 * field. The summary is the legacy one (`ErrorSummary` of FindingActions.tsx): a server answer can name a field this form
 * does not show (the question or the decision version), which the kit's summary cannot list.
 */
export function RaiseFindingForm({ orgSlug, projectId, data }: RaiseFindingFormProps): ReactElement {
  const router = useRouter();
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
  const ordered = linked ? [...areas].sort((a, b) => Number(prefill.areaIds.includes(b.id)) - Number(prefill.areaIds.includes(a.id))) : areas;
  const err = (field: string) => errors.find((e) => e.field === field)?.message ?? w.failure?.fields.find((e) => e.field === field)?.message ?? null;
  const all = [...errors, ...(w.failure?.fields ?? [])];

  const submit = async () => {
    const problems = raiseFormErrors(v);
    setErrors(problems); setAttempt((n) => n + 1); setRaised(null);
    if (problems.length > 0) return;
    const sent = await w.send<FindingView>(raiseRequestBody(v, prefill === null ? null : { stage: prefill.stage, questionId: prefill.questionId, versionId: prefill.versionId }));
    if (sent === null) return;
    setRaised(sent.body.id);
    router.refresh();   // the new finding is listed under its stage
    setV({ title: '', description: '', stage: v.stage, riskArea: '' });
  };
  const set = (patch: Partial<RaiseFormValue>) => { setV((x) => ({ ...x, ...patch })); setErrors([]); };

  return (
    <form method="post" id="raise" className="finding-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{C.heading}</h2>
      <ErrorSummary summary={C.summary(all.length)} errors={all} focusKey={attempt} />
      {linked ? <p>{C.aboutQuestion} <bdi>{prefill.questionText}</bdi></p> : null}
      <TextInput id="title" name="title" label={C.title} error={err('title') ?? undefined} value={v.title} onChange={(e) => set({ title: e.target.value })} />
      <Field id="description" label={C.description} error={err('description')} help={C.descriptionHelp}
        render={(a) => <textarea {...a} className={err('description') ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'} name="description" rows={4} value={v.description} onChange={(e) => set({ description: e.target.value })} />}
        after={<p className="ui-count">{characterCount(charCount(v.description), TEXT_MAX)}</p>} />
      <Select id="stage" name="stage" label={C.stage} error={err('stage') ?? undefined} value={v.stage} placeholder={C.chooseStage}
        options={STAGES.map((s) => ({ value: s, label: STAGE_NAMES[s] }))} onChange={(e) => set({ stage: e.target.value, riskArea: '' })} />
      <Select id="riskArea" name="riskArea" label={C.riskArea} error={err('riskArea') ?? undefined} value={v.riskArea} placeholder={C.noRiskArea}
        options={ordered.map((area) => ({ value: area.id, label: C.areaOption(area.id, area.name) }))} onChange={(e) => set({ riskArea: e.target.value })} />
      <div className="finding-actions">
        <Button variant="primary" type="submit" busy={w.phase !== 'idle'}>{C.submit}</Button>
      </div>
      {w.failure !== null && w.failure.fields.length === 0 ? <p role="alert" className="finding-alert">{w.failure.text}</p> : null}
      <StatusLine>
        {w.phase === 'saving' ? C.raising : w.phase === 'slow' ? C.slow
          : raised === null ? null : <>{C.raised} <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${raised}`}>{C.viewFinding}</ListLink></>}
      </StatusLine>
    </form>
  );
}
