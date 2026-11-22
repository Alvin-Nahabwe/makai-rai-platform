'use client';

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup } from '@/components/ui/Checkbox';
import { DateField } from '@/components/ui/DateField';
import { RadioCards } from '@/components/ui/RadioCards';
import { Select } from '@/components/ui/Select';
import { TextArea } from '@/components/ui/TextArea';
import { OUTSIDE_ROLE_LABELS, REASON_OPTIONAL, SCOPE_OPTIONS, STATUS_OPTIONS, WHO_WHEN_COPY, deciderLabel, reasonCount, whoWhenSummary } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { REASON_MAX, declaredDateFromParts } from '@/lib/decision/rules';
import { formatDeclaredDate } from '@/lib/format/dates';
import { dateParts, isDecision, patchDraft, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '@/lib/vocabulary/terms';
import { OUTSIDE_ROLES, type DecisionStatus, type Decider, type FieldError } from '@/types/record';
import './DecisionFields.css';

const F = DECISION_FORM_COPY;

/**
 * Lane 6's first-use rule (lane 2 T3c item 10a): each status card's word is the status's term and its help sentence is
 * the status's definition (STATUS_OPTIONS' help is the vocabulary's own sentence), so the card is the term's first use with
 * its definition beside it, and the Not applicable sentence is not read as a use of "Does not apply".
 */
const STATUS_TERMS: Readonly<Record<DecisionStatus, { id: string }>> = { done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE };

export interface DecisionFieldsProps {
  data: QuestionPanelData; value: DecisionDraft; errors: FieldError[]; disabled: boolean;
  onChange: (v: DecisionDraft) => void;
  /**
   * Whether "Decided by" and "Decided on" are open for editing. The form keeps it, so it stays open once opened; a field
   * error on either opens them here too, so the M-11 summary's link has a control to reach.
   */
  whoWhenOpen: boolean;
  /** The Change button's press. It opens the fields and moves focus into them; it edits nothing (the next edit to who or when does). */
  onOpenWhoWhen: () => void;
}

/** The field errors that point into Decided by or Decided on: they need those fields on the page (M-11's links). */
export const isWhoWhenError = (e: FieldError): boolean => e.field === 'decidedBy' || e.field === 'declaredDate';

/**
 * Whether the draft's who or when is one the one-line summary cannot state truly: the person changed them (`whoWhenChanged`)
 * and the decider is none or the date is not a date (empty, or half typed, as a restored draft can hold). The line says
 * "today" only for a date that is still the default, so these open the fields instead.
 */
export const whoWhenUnreadable = (v: DecisionDraft): boolean => v.whoWhenChanged && (v.decidedBy === null || 'field' in declaredDateFromParts(v.date));

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

/** How the summary line names the decider: "you" for the viewer, a member by name, an outside role by its label (M-03's words). */
function deciderName(d: Decider | null, data: QuestionPanelData, extra: { userId: string; name: string } | null): string {
  if (d === null) return WHO_WHEN_COPY.noDecider;
  if (d.kind === 'outside_role') return deciderLabel({ kind: 'outside_role', role: d.role }, data.viewer.userId, 'confirmation');
  const former = extra !== null && extra.userId === d.userId;
  const known = d.userId === data.viewer.userId ? data.viewer : data.members.find((m) => m.userId === d.userId) ?? (former ? extra : null);
  return known === null ? WHO_WHEN_COPY.formerMember : deciderLabel({ kind: 'member', user: { userId: known.userId, name: known.name, formerMember: former } }, data.viewer.userId, 'confirmation');
}

/**
 * The fields of S-12's "Record a decision" (W-3, SRS lines 1835-1942; UX-09 to UX-12; FR-DEC-01, FR-DEC-10), on the
 * kit's fields (plan 1A Task 17): RadioCards for the status and the personal data question's answer, CheckboxGroup for
 * a checklist, Select for the main reason and Decided by, TextArea for the reason and DateField for the date. Every
 * control keeps its id and name, and each error and help is linked by `aria-describedby`. A controlled component: every
 * change goes to `onChange` with the whole draft, and the parent keeps the draft. Who and when open as one line, "Decided
 * by you, 22 Nov 2026" with a Change button, and Change opens the two fields in place: the owner's rulings of 22 Nov 2026,
 * "Default who and when", "Prefill today" and "Keep earlier decider" (design 2026-11-22 section 2 item 1; they replace
 * FR-DEC-10's empty date and OQ1 (a)'s empty decider). Today and the two "Same date as" shortcuts still fill the boxes when pressed.
 */
export function DecisionFields({ data, value, errors, disabled, onChange, whoWhenOpen, onOpenWhoWhen }: DecisionFieldsProps): ReactElement {
  const q = data.question;
  const err = (field: string) => errors.find((e) => e.field === field)?.message;
  // A patch to who or when is recorded in the draft (lib/question/draft.ts `patchDraft`), so a restore keeps the person's own.
  const set = (patch: Partial<DecisionDraft>) => onChange(patchDraft(value, patch));
  const current = isDecision(data.current) ? data.current : null;

  // R3 (owner, 15 Nov 2026): four short cards in two columns, each the radio, the mark and the word; each card's sentence
  // shows under the grid for the card that has focus, or else the chosen one (DecisionFields.css). What the status will do
  // is the consequence line before Save (R2), not a hint under the legend.
  const statusGroup = (
    <RadioCards
      name="status" legend={F.fields.status} disabled={disabled} error={err('status')} columns={2} helpBelow
      value={value.status ?? ''}
      options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, help: o.help, mark: o.value, id: `decision-status-${o.value}`, term: STATUS_TERMS[o.value].id }))}
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
  // A field error on who or when needs the fields on the page, whatever the form holds; so does a who or when the line cannot state.
  const open = whoWhenOpen || errors.some(isWhoWhenError) || whoWhenUnreadable(value);
  const lastOwn = data.lastOwnSaveDate;
  const shortcuts = [
    ...(lastOwn !== null ? [{ label: F.sameAsMyLast(formatDeclaredDate(lastOwn)), value: dateParts(lastOwn) }] : []),
    ...(current?.declaredDate ? [{ label: F.sameAsCurrent(formatDeclaredDate(current.declaredDate)), value: dateParts(current.declaredDate) }] : []),
  ];

  // The one line: who and when as the form holds them ("you" for the viewer, as M-03 names them), and "today" while no date is set.
  const parsedDate = declaredDateFromParts(value.date);
  const summary = whoWhenSummary(deciderName(value.decidedBy, data, extraMember), 'date' in parsedDate ? parsedDate.date : null);

  return (
    <div className="decision-fields">
      {current !== null ? <p className="decision-fields__note">{F.startingNote}</p> : null}
      {checklist}
      <div className="decision-fields__choice">{q.type === 'gate' ? scopeGroup : statusGroup}</div>
      {reasonCode}

      <div className="decision-fields__reason">
        <TextArea
          id="decision-reason" name="reason" label={`${F.fields.reason} ${REASON_OPTIONAL}`} value={value.reason} disabled={disabled} rows={4}
          maxLength={REASON_MAX} count={(n) => reasonCount(n)} error={err('reason')}
          describedBy={erased === null ? ['decision-reason-help'] : ['decision-reason-help', 'decision-reason-erased']}
          onChange={(e) => set({ reason: e.target.value })}
        />
        <p id="decision-reason-help" className="decision-fields__help">{reasonHelp}</p>
        {/* The current version's reason was erased on the organisation's instruction: the box opens empty, and says why
            (review round 1, A-I1; the reading view says the same, CurrentDecision). */}
        {erased === null ? null : <p id="decision-reason-erased" className="decision-fields__help">{textErasedLine(erased)}</p>}
      </div>

      {open ? (
        <>
      {/* One row (the sketch's .row): Decided by beside Decided on; the date's shortcuts wrap under its boxes, and below 42rem
          of the fields the two stack (DecisionFields.css: the row wraps by its own width). */}
      <div className="decision-fields__row">
      {/* Opens as the viewer on a first answer and the earlier decider on a change (the owner's "Default who and when" and
          "Keep earlier decider", 22 Nov 2026); the empty first option stays for a person who clears the choice. */}
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

      {/* The date opens at the device's today (the owner's "Prefill today", 22 Nov 2026, which replaces I5's empty boxes);
          the group's hint still names the current version's date at its precision (a withdrawal has none). */}
      <DateField
        idPrefix="decision" legend={F.fields.declaredDate} required aria-describedby="decision-date-hint" value={value.date} disabled={disabled}
        hint={current?.declaredDate ? F.lastDecidedOn(formatDeclaredDate(current.declaredDate)) : undefined}
        error={err('declaredDate')} errorId="decision-declaredDate-error" showToday shortcuts={shortcuts}
        onChange={(date) => set({ date })}
      />
      </div>
      {/* Lead's ruling D3: the date's hint under the row, one line of small type; every box names it. */}
      <p id="decision-date-hint" className="decision-fields__date-hint">{F.dateHelp}</p>
        </>
      ) : (
        <p className="decision-fields__who-when">
          <span id="decision-who-when-summary">{summary}</span>
          <span aria-hidden="true"> · </span>
          <Button variant="quiet" size="compact" disabled={disabled} aria-expanded={false} aria-describedby="decision-who-when-summary" onClick={onOpenWhoWhen}>
            {WHO_WHEN_COPY.change}
          </Button>
        </p>
      )}
    </div>
  );
}
