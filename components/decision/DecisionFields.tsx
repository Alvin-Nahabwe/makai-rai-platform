'use client';

import type { ReactElement } from 'react';
import { CheckboxGroup } from '@/components/ui/Checkbox';
import { DateField } from '@/components/ui/DateField';
import { RadioCards } from '@/components/ui/RadioCards';
import { Select } from '@/components/ui/Select';
import { TextArea } from '@/components/ui/TextArea';
import { OUTSIDE_ROLE_LABELS, SCOPE_OPTIONS, STATUS_OPTIONS, reasonCount } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { REASON_MAX } from '@/lib/decision/rules';
import { formatDeclaredDate } from '@/lib/format/dates';
import { dateParts, isDecision, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { OUTSIDE_ROLES, type Decider, type FieldError } from '@/types/record';
import './DecisionFields.css';

const F = DECISION_FORM_COPY;

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
export const FIELD_LABEL: Readonly<Record<string, string>> = F.fields;

const deciderValue = (d: Decider | null): string => (d === null ? '' : d.kind === 'member' ? `member:${d.userId}` : `role:${d.role}`);
function deciderFrom(v: string): Decider | null {
  if (v.startsWith('member:')) return { kind: 'member', userId: v.slice('member:'.length) };
  const role = OUTSIDE_ROLES.find((r) => `role:${r}` === v);
  return role === undefined ? null : { kind: 'outside_role', role };
}

/**
 * The fields of S-12's "Record a decision" (W-3, SRS lines 1835-1942; UX-09 to UX-12; FR-DEC-01, FR-DEC-10), on the
 * kit's fields (plan 1A Task 17): RadioCards for the status and the personal data question's answer, CheckboxGroup for
 * a checklist, Select for the main reason and Decided by, TextArea for the reason and DateField for the date. Every
 * control keeps its id and name, and each error and help is linked by `aria-describedby`. A controlled component: every
 * change goes to `onChange` with the whole draft, and the parent keeps the draft. The date fields are never filled on
 * open; Today and the two "Same date as" shortcuts fill them only when pressed (FR-DEC-10, NFR-A11Y-04 SC 3.3.7).
 */
export function DecisionFields({ data, value, errors, disabled, onChange }: DecisionFieldsProps): ReactElement {
  const q = data.question;
  const err = (field: string) => errors.find((e) => e.field === field)?.message;
  const set = (patch: Partial<DecisionDraft>) => onChange({ ...value, ...patch });
  const current = isDecision(data.current) ? data.current : null;

  // R3 (owner, 15 Nov 2026): four short cards in two columns, each the radio, the mark and the word; each card's sentence
  // shows under the grid for the card that has focus, or else the chosen one (DecisionFields.css). What the status will do
  // is the consequence line before Save (R2), not a hint under the legend.
  const statusGroup = (
    <RadioCards
      name="status" legend={F.fields.status} disabled={disabled} error={err('status')} columns={2} helpBelow
      value={value.status ?? ''}
      options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, help: o.help, mark: o.value, id: `decision-status-${o.value}` }))}
      onChange={(next) => {
        const status = STATUS_OPTIONS.find((o) => o.value === next)?.value ?? null;
        // A reason code belongs to one status (OD-C2 (a)); it does not follow the person to another.
        const keep = data.reasonCodes.some((c) => c.code === value.reasonCode && c.status === status);
        set({ status, reasonCode: keep ? value.reasonCode : null });
      }}
    />
  );

  const scopeGroup = (
    <RadioCards
      name="scopeAnswer" legend={F.scopeLegend} legendHint={F.scopeNote} disabled={disabled} error={err('scopeAnswer')} columns={2} helpBelow
      value={value.scopeAnswer ?? ''}
      options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: o.label, help: o.help, id: `decision-scope-${o.value}` }))}
      onChange={(next) => set({ scopeAnswer: SCOPE_OPTIONS.find((o) => o.value === next)?.value ?? null })}
    />
  );

  const options = q.options ?? [];
  const checklist = q.type === 'checklist' ? (
    <div className="decision-fields__checklist">
      <CheckboxGroup
        name="optionsInPlace" legend={F.fields.optionsInPlace} disabled={disabled} error={err('optionsInPlace')}
        aria-describedby="decision-options-count" values={value.optionsInPlace}
        options={options.map((o, i) => ({ value: o, label: o, id: `decision-option-${i}` }))}
        onChange={(next) => {
          // As before the kit: a box checked joins the options in their order; a box cleared leaves the rest as they were.
          const added = next.find((x) => !value.optionsInPlace.includes(x));
          set({
            optionsInPlace: added !== undefined
              ? options.filter((x) => x === added || value.optionsInPlace.includes(x))
              : value.optionsInPlace.filter((x) => next.includes(x)),
          });
        }}
      />
      <p id="decision-options-count" className="decision-fields__count">{F.optionsCount(value.optionsInPlace.length, options.length)}</p>
    </div>
  ) : null;

  const codes = value.status === 'not_yet' || value.status === 'not_applicable' ? data.reasonCodes.filter((c) => c.status === value.status) : null;
  // The chosen main reason, of the chosen status: its signed-off line on when to use it sits under the select, and what the
  // reason must say for it joins the reason's hint (spec 9.3 items 2 and 3; plan 1C Task 5 item 4).
  const chosenCode = q.type !== 'gate' && codes !== null ? codes.find((c) => c.code === value.reasonCode) ?? null : null;
  const reasonCode = q.type !== 'gate' && codes !== null ? (
    <div className="decision-fields__reason-code">
      <Select
        id="decision-reason-code" name="reasonCode" label={F.fields.reasonCode} required placeholder={F.chooseOne}
        value={value.reasonCode ?? ''} disabled={disabled} error={err('reasonCode')}
        aria-describedby={chosenCode !== null && chosenCode.useWhen !== '' ? 'decision-reason-code-use' : undefined}
        options={codes.map((c) => ({ value: c.code, label: c.label }))}
        onChange={(e) => set({ reasonCode: e.target.value === '' ? null : e.target.value })}
      />
      {chosenCode !== null && chosenCode.useWhen !== '' ? <p id="decision-reason-code-use" className="decision-fields__help">{chosenCode.useWhen}</p> : null}
    </div>
  ) : null;
  // Ruling (a), 15 Nov 2026: the reason's hint is the question's own signed-off prompt (content 5.1.0), not one line for all.
  const erased = current?.reasonErased?.erasedOn ?? null;
  const reasonHelp = [data.runningQuestion.reasonPrompt, chosenCode?.reasonMustSay ?? ''].filter((t) => t !== '').join(' ');

  // A former member who decided the current version stays selectable, named as the record names them.
  const listed = new Set([data.viewer.userId, ...data.members.map((m) => m.userId)]);
  const extraMember = current?.decidedBy?.kind === 'member' && !listed.has(current.decidedBy.user.userId) ? current.decidedBy.user : null;
  const lastOwn = data.lastOwnSaveDate;
  const shortcuts = [
    ...(lastOwn !== null ? [{ label: F.sameAsMyLast(formatDeclaredDate(lastOwn)), value: dateParts(lastOwn) }] : []),
    ...(current?.declaredDate ? [{ label: F.sameAsCurrent(formatDeclaredDate(current.declaredDate)), value: dateParts(current.declaredDate) }] : []),
  ];

  return (
    <div className="decision-fields">
      {current !== null ? <p className="decision-fields__note">{F.startingNote}</p> : null}
      {checklist}
      <div className="decision-fields__choice">{q.type === 'gate' ? scopeGroup : statusGroup}</div>
      {reasonCode}

      <div className="decision-fields__reason">
        <TextArea
          id="decision-reason" name="reason" label={F.fields.reason} required value={value.reason} disabled={disabled} rows={4}
          maxLength={REASON_MAX} count={(n) => reasonCount(n)} error={err('reason')}
          describedBy={erased === null ? ['decision-reason-help'] : ['decision-reason-help', 'decision-reason-erased']}
          onChange={(e) => set({ reason: e.target.value })}
        />
        <p id="decision-reason-help" className="decision-fields__help">{reasonHelp}</p>
        {/* The current version's reason was erased on the organisation's instruction: the box opens empty, and says why
            (review round 1, A-I1; the reading view says the same, CurrentDecision). */}
        {erased === null ? null : <p id="decision-reason-erased" className="decision-fields__help">{textErasedLine(erased)}</p>}
      </div>

      {/* One row (the sketch's .row): Decided by beside Decided on; the date's shortcuts wrap under its boxes, and below about
          430 px of the card the two stack (DecisionFields.css, a container query). */}
      <div className="decision-fields__row">
      {/* Starts empty on a first decision (owner OQ1 (a)): the empty first option keeps the browser from showing the first
          member as chosen while the answer holds no one. */}
      <Select
        id="decision-decided-by" name="decidedBy" label={F.fields.decidedBy} required value={deciderValue(value.decidedBy)}
        disabled={disabled} error={err('decidedBy')} placeholder={F.chooseOne}
        options={[
          { value: `member:${data.viewer.userId}`, label: F.you(data.viewer.name) },
          ...data.members.map((m) => ({ value: `member:${m.userId}`, label: m.name })),
          ...(extraMember !== null ? [{ value: `member:${extraMember.userId}`, label: F.formerMember(extraMember.name) }] : []),
        ]}
        groups={[{ label: F.noAccountGroup, options: OUTSIDE_ROLES.map((r) => ({ value: `role:${r}`, label: OUTSIDE_ROLE_LABELS[r] })) }]}
        onChange={(e) => set({ decidedBy: deciderFrom(e.target.value) })}
      />

      <DateField
        idPrefix="decision" legend={F.fields.declaredDate} required aria-describedby="decision-date-hint" value={value.date} disabled={disabled}
        error={err('declaredDate')} errorId="decision-declaredDate-error" showToday shortcuts={shortcuts}
        onChange={(date) => set({ date })}
      />
      </div>
      {/* Lead's ruling D3: the date's hint under the row, one line of small type; every box names it. */}
      <p id="decision-date-hint" className="decision-fields__date-hint">{F.dateHelp}</p>
    </div>
  );
}
