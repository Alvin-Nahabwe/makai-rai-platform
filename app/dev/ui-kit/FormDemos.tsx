'use client';

import { useState, type ReactElement } from 'react';
import { CheckboxGroup } from '@/components/ui/Checkbox';
import { DateField } from '@/components/ui/DateField';
import { RadioCards } from '@/components/ui/RadioCards';
import { TextArea } from '@/components/ui/TextArea';
import type { DateParts } from '@/components/ui/types';
import { STATUS_OPTIONS } from '@/lib/decision/copy';
import { parseDateParts } from '@/lib/ui/dateParts';

/**
 * The gallery's live form controls (plan 1A Task 4): each holds its own state, so the browser spec can type, tick,
 * choose with the arrow keys and press Today. Nothing here is a form, and nothing is sent anywhere.
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
