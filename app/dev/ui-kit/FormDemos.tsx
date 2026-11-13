'use client';

import { useRef, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup } from '@/components/ui/Checkbox';
import { DateField } from '@/components/ui/DateField';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { RadioCards } from '@/components/ui/RadioCards';
import { TextArea } from '@/components/ui/TextArea';
import { TextInput } from '@/components/ui/TextInput';
import type { DateParts } from '@/components/ui/types';
import { STATUS_OPTIONS } from '@/lib/decision/copy';
import { parseDateParts } from '@/lib/ui/dateParts';

/**
 * The gallery's live form controls (plan 1A Task 4): each holds its own state, so the browser spec can type, tick,
 * choose with the arrow keys and press Today. Once the page has hydrated nothing is sent anywhere: the one form has
 * no action, and its submit handler prevents the browser's submit and only counts. Before hydration (or without
 * JavaScript) that form would post its one sample field to this development-only page, which reads no request body.
 */

const EMPTY: DateParts = { day: '', month: '', year: '' };
const MARKS = { done: 'done', partly: 'partly', not_yet: 'not_yet', not_applicable: 'not_applicable' } as const;

/** Sample count words; a real caller passes its own sentence (M-11's "4,000"). */
const sampleCount = (n: number, max: number) => (n > max ? `${n - max} characters too many. Shorten the text to ${max} characters.` : `${n} of ${max} characters`);

export function StatusDemo(): ReactElement {
  const [status, setStatus] = useState<string | undefined>(undefined);
  return (
    <div>
      <RadioCards
        name="kit-status" legend="Status" value={status ?? ''} onChange={setStatus}
        options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, help: o.help, mark: MARKS[o.value] }))}
      />
      <p data-demo-output="status">Chosen: {status ?? 'nothing yet'}</p>
    </div>
  );
}

export function ReasonDemo(): ReactElement {
  const [text, setText] = useState('');
  return (
    <TextArea
      id="kit-reason" name="kit-reason" label="Reason" hint="Say what was checked and what it showed." required maxLength={40}
      count={sampleCount} value={text} onChange={(e) => setText(e.target.value)}
    />
  );
}

export function InPlaceDemo(): ReactElement {
  const [values, setValues] = useState<string[]>([]);
  return (
    <div>
      <CheckboxGroup
        name="kit-in-place" legend="Which of these are in place?" legendHint="Tick all that apply." values={values} onChange={setValues}
        options={[
          { value: 'policy', label: 'A written policy', id: 'kit-in-place-policy' },
          { value: 'owner', label: 'A named owner', hint: 'One person, named by role.' },
          { value: 'review', label: 'A yearly review' },
        ]}
      />
      <p data-demo-output="in-place">Ticked: {values.length === 0 ? 'none' : values.join(', ')}</p>
    </div>
  );
}

export function DecidedOnDemo(): ReactElement {
  const [date, setDate] = useState<DateParts>(EMPTY);
  const parsed = parseDateParts(date);
  return (
    <div>
      <DateField
        idPrefix="kit-decided" legend="Decided on" hint="The day, the month and the year, for example 11, 2 and 2026." value={date} onChange={setDate}
        required showToday shortcuts={[
          { label: 'Same as my last save: 3 Nov 2026', value: { day: '3', month: '11', year: '2026' } },
          { label: 'Same as version 2 (11 Feb 2026)', value: { day: '11', month: '2', year: '2026' } },
        ]}
      />
      <p data-demo-output="decided-on">Reads as: {parsed.ok ? parsed.value ?? 'no date' : parsed.error}</p>
    </div>
  );
}

/** The date field's other states, which need a client parent for their (unused) onChange. */
export function DateStates(): ReactElement {
  const ignore = () => {};
  return (
    <div>
      <DateField idPrefix="kit-date-error" legend="Decided on, with an error" value={{ day: '31', month: '2', year: '2026' }} onChange={ignore}
        error="Enter a date that exists. February 2026 has 28 days." errorId="kit-date-error-message" />
      <DateField idPrefix="kit-date-disabled" legend="Decided on, while saving" value={{ day: '11', month: '2', year: '2026' }} onChange={ignore}
        showToday disabled />
    </div>
  );
}

/** The text area's other states. A TextArea is controlled only, so each holds its text here. */
export function TextAreaStates(): ReactElement {
  const [over, setOver] = useState('We assessed effects on adolescent mothers and on women with no recorded education.');
  const [missing, setMissing] = useState('');
  return (
    <div>
      <TextArea id="kit-reason-over" name="kit-reason-over" label="Reason, over the limit" maxLength={40} count={sampleCount}
        value={over} onChange={(e) => setOver(e.target.value)} />
      <TextArea id="kit-reason-error" name="kit-reason-error" label="Reason, with an error" maxLength={40} count={sampleCount}
        value={missing} onChange={(e) => setMissing(e.target.value)}
        error="Write a reason. Say what was checked and what it showed." describedBy={['kit-reason-note']} required />
      <p id="kit-reason-note">A further description the area points to, between its count and its error.</p>
      <TextArea id="kit-reason-readonly" name="kit-reason-readonly" label="Reason, read only" maxLength={40} count={sampleCount}
        value="Checked the consent forms." readOnly />
      <TextArea id="kit-reason-disabled" name="kit-reason-disabled" label="Reason, while saving" maxLength={40} count={sampleCount}
        value="Checked the consent forms." disabled />
    </div>
  );
}

/**
 * A form whose submit button is busy: a click, Space or Enter on the button, or Enter in its field, must not submit.
 * The submit handler prevents the browser's submit in any case and counts the submits that reach it.
 */
export function BusySubmitDemo(): ReactElement {
  const [submits, setSubmits] = useState(0);
  return (
    <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); setSubmits((n) => n + 1); }} aria-label="A form while it saves">
      <TextInput id="kit-busy-field" name="kit-busy-field" label="Project name, in a form that is saving" defaultValue="Maternal health triage" />
      <Button variant="primary" type="submit" busy>Saving the project</Button>
      <p data-demo-output="busy-submits">Submits: {submits}</p>
    </form>
  );
}

/** The error summary, and the script focus a form gives it after a failed submit. */
export function ErrorSummaryDemo(): ReactElement {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <div>
      <Button variant="secondary" onClick={() => title.current?.focus()}>Move focus to the summary</Button>
      <ErrorSummary ref={title} title="There is a problem" errors={[
        { fieldId: 'kit-error', message: "Enter the organisation's name." },
        { fieldId: 'kit-decided-day', message: 'Enter the day, month and year the decision was made.' },
      ]} />
    </div>
  );
}
