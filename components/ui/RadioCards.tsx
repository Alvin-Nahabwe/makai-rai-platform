'use client';

import { useState, type ReactElement, type ReactNode } from 'react';
import { termPattern } from '@/lib/vocabulary/firstUse';
import { MarkShape } from '@/components/ui/StatusMark';
import { describedBy, FieldError, given } from '@/components/ui/TextInput';
import type { StatusMarkKind } from '@/components/ui/types';
import './formStyles';
import './RadioCards.css';

export type RadioCardsProps = {
  name: string;
  legend: string;
  /** Rendered after the legend, outside it, so the legend's text stays the group's name alone. */
  legendHint?: ReactNode;
  /**
   * `term` (lane 2 T3c item 10a, additive): the vocabulary id whose word the label is and whose definition the help is (spec 6
   * first use): the label's words carry `data-term` and the help sentence `data-definition`. Absent: markup unchanged.
   * `helpWord` and `definition` (per-question wording, content 5.2.0): for an option whose label is the question's own, the
   * shared word inside `help` and the vocabulary's own sentence for it. The definition follows the help as its own
   * `data-definition` element, named by the radio's `aria-describedby`; the term mark sits on the word where the label holds
   * it as whole words, else on the word in `help`. Without them (or if `help` lacks the word): as above.
   */
  options: ReadonlyArray<{ value: string; label: string; help?: string; mark?: StatusMarkKind; id?: string; term?: string; helpWord?: string; definition?: string }>;
  /** Pass `value` (controlled, with `onChange`) or `defaultValue`, never both. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  error?: string;
  /**
   * Native `required` on each radio. No marker is drawn: the legend holds its own text alone, so a caller that wants
   * the group to say it is required says so in `legendHint`.
   */
  required?: boolean;
  columns?: 1 | 2;
  /** On the fieldset: it disables every radio. */
  disabled?: boolean;
  /** On the fieldset, after the legend hint and before the error. */
  'aria-describedby'?: string;
  /**
   * The decision card's layout (owner's ruling R3, 15 Nov 2026): each option's help sentence is rendered after the grid,
   * in option order, with the same id and class, instead of inside its card, so the caller's stylesheet can show one
   * under the grid. Each radio still names its sentence in aria-describedby. Off by default: every other caller's
   * markup is unchanged.
   */
  helpBelow?: boolean;
};

/**
 * A choice of one, as cards (plan 1A Task 4, spec 7.5): the whole card selects, and the selection is a thicker border
 * in the selected colour plus the mark. Each card draws one control (critique P1 4): an empty ring while it is not chosen,
 * and its option's mark once it is (a ring with a dot where the option has no mark). The mark is drawn only on the chosen
 * card, so no unchosen answer shows Done's green check. The native radio stays for its semantics and its arrow keys as a
 * transparent hit area over that control; its focus ring is the page's.
 *
 * The radio's accessible name is exactly its option's `label`: the `<label>` holds only the radio, the mark (hidden from
 * assistive technology) and the label's words. The `help` sentence sits outside the label and describes the radio
 * (`aria-describedby`), and a click on it still reaches the radio through the label's stretched ::after. Protected
 * browser tests find a radio by `getByRole('radio', { name, exact: true })` (e2e/helpers/session.ts:147).
 */
export function RadioCards({
  name, legend, legendHint, options, value, defaultValue, onChange, error, required = false, columns = 1, disabled = false,
  'aria-describedby': callerDescribedBy, helpBelow = false,
}: RadioCardsProps): ReactElement {
  // The chosen value, so the one drawn mark follows the choice whether the group is controlled or not.
  const [own, setOwn] = useState(defaultValue);
  const chosen = value ?? own;
  const helpIdOf = (o: RadioCardsProps['options'][number]) => (o.help === undefined ? undefined : `${o.id ?? `${name}-${o.value}`}-help`);
  type Option = RadioCardsProps['options'][number];
  // An option whose label is the question's own and which names the shared word it counts as (`helpWord` in `help`, with the
  // vocabulary's `definition`); one condition decides the label, the help and the description alike.
  const countsAsOf = (o: Option): { word: string; definition: string; at: number } | null =>
    o.term !== undefined && o.help !== undefined && o.helpWord !== undefined && o.definition !== undefined && o.help.includes(o.helpWord)
      ? { word: o.helpWord, definition: o.definition, at: o.help.indexOf(o.helpWord) } : null;
  const definitionIdOf = (o: Option) => `${helpIdOf(o)}-definition`;
  const describedOf = (o: Option) => (countsAsOf(o) === null ? helpIdOf(o) : `${helpIdOf(o)} ${definitionIdOf(o)}`);
  // The label's words. The term sits on the label (or, for a question's own label, on the shared word when the label holds it
  // as whole words); a label without the word leaves the mark to the help line.
  const labelOf = (o: Option): ReactNode => {
    if (o.term === undefined) return o.label;
    const c = countsAsOf(o);
    if (c === null) return <span data-term={o.term}>{o.label}</span>;
    const m = termPattern(c.word).exec(o.label);
    if (m === null) return o.label;
    return <>{o.label.slice(0, m.index)}<span data-term={o.term}>{m[0]}</span>{o.label.slice(m.index + m[0].length)}</>;
  };
  // The help's words. With a shared word the definition is its own element, named by the radio, so a use of the word in the
  // label has its definition too; the term sits on the word here only when the label does not hold it.
  const helpOf = (o: Option, id: string | undefined, key?: string): ReactElement | null => {
    if (o.help === undefined) return null;
    const c = countsAsOf(o);
    if (c === null) return <p key={key} className="ui-radio-card__help" id={id} data-definition={o.term}>{o.help}</p>;
    const inLabel = termPattern(c.word).test(o.label);
    const word = inLabel ? c.word : <span data-term={o.term}>{c.word}</span>;
    return (
      <p key={key} className="ui-radio-card__help" id={id}>
        {o.help.slice(0, c.at)}{word}{o.help.slice(c.at + c.word.length)} <span id={definitionIdOf(o)} data-definition={o.term}>{c.definition}</span>
      </p>
    );
  };
  const hintId = given(legendHint) ? `${name}-hint` : undefined;
  const errorId = `${name}-error`;
  return (
    <fieldset
      className={columns === 2 ? 'ui-radio-cards ui-radio-cards--columns-2' : 'ui-radio-cards'} disabled={disabled}
      aria-describedby={describedBy(hintId, callerDescribedBy, given(error) && errorId)}
    >
      <legend className="ui-radio-cards__legend">{legend}</legend>
      {hintId === undefined ? null : <div className="ui-radio-cards__hint" id={hintId}>{legendHint}</div>}
      {given(error) ? <FieldError id={errorId} message={error} /> : null}
      <div className="ui-radio-cards__list">
        {options.map((o) => {
          const inputId = o.id ?? `${name}-${o.value}`;
          const helpId = helpIdOf(o);
          return (
            <div key={o.value} className="ui-radio-card">
              <label className="ui-radio-card__label" htmlFor={inputId}>
                <input
                  type="radio" className="ui-radio-card__input" id={inputId} name={name} value={o.value} required={required}
                  checked={value === undefined ? undefined : value === o.value}
                  defaultChecked={value === undefined ? defaultValue === o.value : undefined}
                  onChange={() => { setOwn(o.value); onChange?.(o.value); }}
                  aria-describedby={describedOf(o)}
                />
                {chosen === o.value && o.mark !== undefined
                  ? <MarkShape kind={o.mark} size={20} />
                  : <span className="ui-radio-card__ring" data-on={chosen === o.value ? 'true' : undefined} aria-hidden="true" />}
                {labelOf(o)}
              </label>
              {helpId === undefined || helpBelow ? null : helpOf(o, helpId)}
            </div>
          );
        })}
      </div>
      {helpBelow ? (
        <div className="ui-radio-cards__helps">
          {options.map((o) => helpOf(o, helpIdOf(o), o.value))}
        </div>
      ) : null}
    </fieldset>
  );
}
