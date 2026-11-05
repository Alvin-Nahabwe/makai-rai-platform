import type { FieldError } from '@/types/record';

/** Plain TypeScript with no React, so the three project writers (form, Archive, Unarchive) and their tests share one reading of a refusal. */
export const FORBIDDEN_LINE = 'You can no longer change this project.';
export const GONE_LINE = 'This project no longer exists.';
export const ARCHIVED_FORM_LINE = 'This project is archived. Nothing in it can be changed.';
export const TRY_AGAIN_LINE = 'Something went wrong. Please try again.';

/**
 * What Archive and Unarchive do with an API refusal (F8):
 *  - `signin`: the session ended (401), go to sign in;
 *  - `stop`: the role was lowered (403) or the project is gone (404). The same request would be refused again, so the
 *    request id is dropped, the line stays in the control's own status region and the control is disabled. The page is NOT
 *    refreshed, because the refreshed page leaves the control out and the line would go with it;
 *  - `refresh`: another state (409): the refreshed page shows what applies now, with no line;
 *  - `again`: a server error or a limit: say so, keep the request id, offer Retry.
 */
export type Refusal = { kind: 'signin' } | { kind: 'stop'; line: string } | { kind: 'refresh' } | { kind: 'again' };

export function refusalOf(status: number): Refusal {
  if (status === 401) return { kind: 'signin' };
  if (status === 403) return { kind: 'stop', line: FORBIDDEN_LINE };
  if (status === 404) return { kind: 'stop', line: GONE_LINE };
  if (status === 409) return { kind: 'refresh' };
  return { kind: 'again' };
}

/** The fields that sit in the form's collapsible "additional details" section. */
const DETAIL_FIELDS: readonly string[] = [
  'deploymentSector', 'datasetType', 'datasetSize', 'processesPersonalData', 'fundingSource', 'regulatoryContext', 'developmentStage',
  'teamSize', 'projectStart', 'projectEnd', 'institution', 'department', 'country', 'targetPopulation',
];

export type FormRefusal =
  | { kind: 'signin' }
  | { kind: 'stop'; line: string }
  | { kind: 'again'; line: string }
  | { kind: 'fields'; fields: FieldError[]; summary: string; openDetails: boolean };

/**
 * What the project form does with a refusal (SRS 7.5.5: each message beside its field and in a summary, as DEC-b's and FND-b's
 * forms word it; F8 for 401, 403, 404). A field inside the additional details opens that section, so the message can be seen.
 */
export function formRefusalOf(status: number, body: { code: string; fields?: FieldError[] }): FormRefusal {
  if (body.fields !== undefined && body.fields.length > 0) {
    const n = body.fields.length;
    return {
      kind: 'fields', fields: body.fields, openDetails: body.fields.some((f) => DETAIL_FIELDS.includes(f.field)),
      summary: n === 1 ? 'There is a problem with this project. What you typed is kept.' : `There are ${n} problems with this project. What you typed is kept.`,
    };
  }
  const r = refusalOf(status);
  if (r.kind === 'signin' || r.kind === 'stop') return r;
  if (body.code === 'project_archived') return { kind: 'stop', line: ARCHIVED_FORM_LINE };
  return { kind: 'again', line: TRY_AGAIN_LINE };
}
