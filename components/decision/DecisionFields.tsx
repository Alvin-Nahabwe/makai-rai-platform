'use client';

import type { ReactElement, ReactNode } from 'react';
import {
  FINDING_NOTE, OUTSIDE_ROLE_LABELS, REASON_HELP, SCOPE_OPTIONS, STATUS_OPTIONS, reasonCount,
} from '@/lib/decision/copy';
import { reasonLength } from '@/lib/decision/rules';
import { formatDeclaredDate } from '@/lib/format/dates';
import { dateParts, isDecision, todayParts, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { OUTSIDE_ROLES, type Decider, type FieldError } from '@/types/record';

export interface DecisionFieldsProps {
  data: QuestionPanelData; value: DecisionDraft; errors: FieldError[]; disabled: boolean;
  onChange: (v: DecisionDraft) => void;
}

/** The id of the control a field error points to, so the M-11 summary links to it (7.4.1 "Validation errors"). */
export const FIELD_TARGET: Readonly<Record<string, string>> = Object.freeze({
  status: 'decision-status-done', scopeAnswer: 'decision-scope-yes', optionsInPlace: 'decision-option-0', reasonCode: 'decision-reason-code',
  reason: 'decision-reason', decidedBy: 'decision-decided-by', declaredDate: 'decision-day',
});

/** The label a field error is listed under in the M-11 summary. */
export const FIELD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  status: 'Status', scopeAnswer: 'Scope answer', optionsInPlace: 'Which of these are in place?', reasonCode: 'Reason code',
  reason: 'Reason', decidedBy: 'Decided by', declaredDate: 'When was this decided?',
});

const deciderValue = (d: Decider | null): string => (d === null ? '' : d.kind === 'member' ? `member:${d.userId}` : `role:${d.role}`);
function deciderFrom(v: string): Decider | null {
  if (v.startsWith('member:')) return { kind: 'member', userId: v.slice('member:'.length) };
  const role = OUTSIDE_ROLES.find((r) => `role:${r}` === v);
  return role === undefined ? null : { kind: 'outside_role', role };
}

/**
 * A field's error line: bold text in the body colour. The shared `.form-error` (app/globals.css:682) fails axe's colour
 * contrast check in the light theme, so these lines do not use it (NFR-A11Y-05); the words, not a colour, say it is an error.
 */
export const FIELD_ERROR_STYLE = Object.freeze({ color: 'var(--text-body)', fontWeight: 700, margin: '0.25rem 0' });

const describedBy = (...ids: Array<string | false>): string => ids.filter(Boolean).join(' ');

function FieldMessage({ id, error }: { id: string; error: FieldError | undefined }): ReactElement | null {
  return error === undefined ? null : <p id={id} className="field-error" style={FIELD_ERROR_STYLE}>{error.message}</p>;
}

/**
 * The fields of S-12's "Record a decision" (W-3, SRS lines 1835-1942; UX-09 to UX-12; FR-DEC-01, FR-DEC-10):
 * native radios, checkboxes, selects and text inputs only, each labelled, with its help and its error linked
 * by `aria-describedby`. A controlled component: every change goes to `onChange` with the whole draft, and the
 * parent keeps the draft. The date fields are never filled on open; Today, Same as my last save and Same as
 * version N fill them only when pressed (FR-DEC-10, NFR-A11Y-04 SC 3.3.7).
 */
export function DecisionFields({ data, value, errors, disabled, onChange }: DecisionFieldsProps): ReactElement {
  const q = data.question;
  const err = (field: string) => errors.find((e) => e.field === field);
  const set = (patch: Partial<DecisionDraft>) => onChange({ ...value, ...patch });
  const current = isDecision(data.current) ? data.current : null;
  const errId = (f: string) => `decision-${f}-error`;

  const statusGroup = (
    <fieldset className="form-group" aria-describedby={describedBy('decision-finding-note', err('status') !== undefined && errId('status'))}>
      <legend>Status</legend>
      {STATUS_OPTIONS.map((o) => (
        <div key={o.value} className="checkbox-label">
          <input
            type="radio" id={`decision-status-${o.value}`} name="status" value={o.value} checked={value.status === o.value} disabled={disabled}
            aria-describedby={`decision-status-${o.value}-help`}
            onChange={() => {
              // A reason code belongs to one status (OD-C2 (a)); it does not follow the person to another.
              const keep = data.reasonCodes.some((c) => c.code === value.reasonCode && c.status === o.value);
              set({ status: o.value, reasonCode: keep ? value.reasonCode : null });
            }}
          />
          <label htmlFor={`decision-status-${o.value}`}>{o.label}</label>{' '}
          <span id={`decision-status-${o.value}-help`} className="text-muted">{o.help}</span>
        </div>
      ))}
      <p id="decision-finding-note">{FINDING_NOTE}</p>
      <FieldMessage id={errId('status')} error={err('status')} />
    </fieldset>
  );

  const scopeGroup = (
    <fieldset className="form-group" aria-describedby={describedBy('decision-scope-note', err('scopeAnswer') !== undefined && errId('scopeAnswer'))}>
      <legend>Scope answer (required)</legend>
      {SCOPE_OPTIONS.map((o) => (
        <div key={o.value} className="checkbox-label">
          <input
            type="radio" id={`decision-scope-${o.value}`} name="scopeAnswer" value={o.value} checked={value.scopeAnswer === o.value} disabled={disabled}
            aria-describedby={`decision-scope-${o.value}-help`} onChange={() => set({ scopeAnswer: o.value })}
          />
          <label htmlFor={`decision-scope-${o.value}`}>{o.label}</label>{' '}
          <span id={`decision-scope-${o.value}-help`} className="text-muted">{o.help}</span>
        </div>
      ))}
      <p id="decision-scope-note">This answer decides whether Q-PP-13 and Q-PP-14 apply. It does not open a finding.</p>
      <FieldMessage id={errId('scopeAnswer')} error={err('scopeAnswer')} />
    </fieldset>
  );

  const options = q.options ?? [];
  const checklist = q.type === 'checklist' ? (
    <fieldset className="form-group" aria-describedby={describedBy('decision-options-count', err('optionsInPlace') !== undefined && errId('optionsInPlace'))}>
      <legend>Which of these are in place?</legend>
      {options.map((o, i) => (
        <div key={o} className="checkbox-label">
          <input
            type="checkbox" id={`decision-option-${i}`} name="optionsInPlace" value={o} checked={value.optionsInPlace.includes(o)} disabled={disabled}
            onChange={(e) => set({ optionsInPlace: e.target.checked ? options.filter((x) => x === o || value.optionsInPlace.includes(x)) : value.optionsInPlace.filter((x) => x !== o) })}
          />
          <label htmlFor={`decision-option-${i}`}>{o}</label>
        </div>
      ))}
      <p id="decision-options-count">{`${value.optionsInPlace.length} of ${options.length} in place`}</p>
      <FieldMessage id={errId('optionsInPlace')} error={err('optionsInPlace')} />
    </fieldset>
  ) : null;

  const codes = value.status === 'not_yet' || value.status === 'not_applicable' ? data.reasonCodes.filter((c) => c.status === value.status) : null;
  const reasonCode = q.type !== 'gate' && codes !== null ? (
    <div className="form-group">
      <label htmlFor="decision-reason-code">Reason code (required)</label>
      <select
        id="decision-reason-code" name="reasonCode" value={value.reasonCode ?? ''} disabled={disabled}
        aria-invalid={err('reasonCode') !== undefined || undefined} aria-describedby={err('reasonCode') !== undefined ? errId('reasonCode') : undefined}
        onChange={(e) => set({ reasonCode: e.target.value === '' ? null : e.target.value })}
      >
        <option value="">Choose a reason code</option>
        {codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
      </select>
      <FieldMessage id={errId('reasonCode')} error={err('reasonCode')} />
    </div>
  ) : null;

  // A former member who decided the current version stays selectable, named as the record names them.
  const listed = new Set([data.viewer.userId, ...data.members.map((m) => m.userId)]);
  const extraMember = current?.decidedBy?.kind === 'member' && !listed.has(current.decidedBy.user.userId) ? current.decidedBy.user : null;
  const shortcut = (label: string, fill: () => void): ReactNode => (
    <button type="button" className="btn btn--secondary btn--small" disabled={disabled} onClick={fill}>{label}</button>
  );

  return (
    // SC 2.4.11: a control that takes focus is brought wholly into view (a tall reason field near the bottom would
    // otherwise be left half below the fold by the browser's own scroll, which only makes part of it visible).
    <div className="decision-fields" onFocus={(e) => { e.target.scrollIntoView?.({ block: 'nearest' }); }}>
      {current !== null ? <p>{`Starting from version ${current.versionNumber}`}</p> : null}
      {checklist}
      {q.type === 'gate' ? scopeGroup : statusGroup}
      {reasonCode}

      <div className="form-group">
        <label htmlFor="decision-reason">Reason (required)</label>{' '}
        <span id="decision-reason-count" className="text-muted">{reasonCount(reasonLength(value.reason))}</span>
        <textarea
          id="decision-reason" name="reason" rows={5} value={value.reason} disabled={disabled}
          aria-invalid={err('reason') !== undefined || undefined}
          aria-describedby={describedBy('decision-reason-help', 'decision-reason-count', err('reason') !== undefined && errId('reason'))}
          onChange={(e) => set({ reason: e.target.value })}
        />
        <p id="decision-reason-help" className="text-muted">{REASON_HELP}</p>
        <FieldMessage id={errId('reason')} error={err('reason')} />
      </div>

      <div className="form-group">
        <label htmlFor="decision-decided-by">Decided by (required)</label>
        <select
          id="decision-decided-by" name="decidedBy" value={deciderValue(value.decidedBy)} disabled={disabled}
          aria-invalid={err('decidedBy') !== undefined || undefined} aria-describedby={err('decidedBy') !== undefined ? errId('decidedBy') : undefined}
          onChange={(e) => set({ decidedBy: deciderFrom(e.target.value) })}
        >
          <option value={`member:${data.viewer.userId}`}>{`You (${data.viewer.name})`}</option>
          {data.members.map((m) => <option key={m.userId} value={`member:${m.userId}`}>{m.name}</option>)}
          {extraMember !== null ? <option value={`member:${extraMember.userId}`}>{`${extraMember.name} (former member)`}</option> : null}
          <optgroup label="Outside roles">
            {OUTSIDE_ROLES.map((r) => <option key={r} value={`role:${r}`}>{OUTSIDE_ROLE_LABELS[r]}</option>)}
          </optgroup>
        </select>
        <FieldMessage id={errId('decidedBy')} error={err('decidedBy')} />
      </div>

      <fieldset className="form-group" aria-describedby={describedBy('decision-date-help', err('declaredDate') !== undefined && errId('declaredDate'))}>
        <legend>When was this decided? (required)</legend>
        <div className="form-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end' }}>
          {(['day', 'month', 'year'] as const).map((part) => (
            <div key={part}>
              {/* A label is a pointer target too (it focuses its field): 24 px at least (SC 2.5.8, NFR-A11Y-04). */}
              <label htmlFor={`decision-${part}`} style={{ display: 'block', minHeight: '24px', minWidth: '24px' }}>{part === 'day' ? 'Day' : part === 'month' ? 'Month' : 'Year'}</label>
              <input
                type="text" inputMode="numeric" id={`decision-${part}`} name={part} autoComplete="off"
                size={part === 'year' ? 4 : 2} maxLength={part === 'year' ? 4 : 2} style={{ width: part === 'year' ? '5rem' : '3.5rem' }}
                value={value.date[part]} disabled={disabled} aria-invalid={err('declaredDate') !== undefined || undefined}
                onChange={(e) => set({ date: { ...value.date, [part]: e.target.value } })}
              />
            </div>
          ))}
          {shortcut('Today', () => set({ date: todayParts(new Date()) }))}
          {data.lastOwnSaveDate !== null
            ? shortcut(`Same as my last save: ${formatDeclaredDate(data.lastOwnSaveDate)}`, () => set({ date: dateParts(data.lastOwnSaveDate as string) }))
            : null}
          {current?.declaredDate
            ? shortcut(`Same as version ${current.versionNumber} (${formatDeclaredDate(current.declaredDate)})`, () => set({ date: dateParts(current.declaredDate as string) }))
            : null}
        </div>
        <p id="decision-date-help" className="text-muted">Leave the day empty if you only know the month. Leave both empty if you only know the year.</p>
        <FieldMessage id={errId('declaredDate')} error={err('declaredDate')} />
      </fieldset>
    </div>
  );
}
