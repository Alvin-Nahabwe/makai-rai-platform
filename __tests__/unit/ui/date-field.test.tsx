import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';
import { textOf } from '@/__tests__/helpers/markup';
import { UI_COPY } from '@/lib/ui/copy';

/** Plan 1A Task 4: DateField, three boxes with "Today" and shortcuts (spec 7.5, 9.3). Never pre-filled by the component. */

const EMPTY = { day: '', month: '', year: '' };
const render = (props: Partial<DateFieldProps> = {}) =>
  renderToStaticMarkup(<DateField idPrefix="decision" legend="Decided on" value={EMPTY} onChange={() => {}} {...props} />);
const inputs = (html: string) => html.match(/<input [^>]*>/g) ?? [];

describe('DateField', () => {
  it('reads its words from UI_COPY.date', () => {
    expect(UI_COPY.date).toEqual({ day: 'Day', month: 'Month', year: 'Year', today: 'Today' });
  });

  it('three numeric boxes labelled Day, Month and Year, with ids from idPrefix, in a fieldset with its legend', () => {
    const html = render();
    expect(html).toMatch(/<fieldset class="ui-date"[^>]*>\s*<legend[^>]*>Decided on<\/legend>/);
    const ins = inputs(html);
    expect(ins.map((i) => i.match(/id="([^"]+)"/)?.[1])).toEqual(['decision-day', 'decision-month', 'decision-year']);
    expect(ins.every((i) => i.includes('inputMode="numeric"'))).toBe(true);
    for (const [part, word] of [['day', 'Day'], ['month', 'Month'], ['year', 'Year']] as const) {
      expect(html).toContain(`<label class="ui-date__label" for="decision-${part}">${word}</label>`);
      expect(html).toContain(`ui-date__part--${part}`);
    }
  });

  it('is never pre-filled when value is empty', () => {
    expect(inputs(render()).every((i) => i.includes('value=""'))).toBe(true);
  });

  it('shows the value it is given', () => {
    expect(inputs(render({ value: { day: '11', month: '2', year: '2026' } })).map((i) => i.match(/value="([^"]*)"/)?.[1])).toEqual(['11', '2', '2026']);
  });

  it('with errorId and an error, the error element has that id and the inputs reference it', () => {
    const html = render({ hint: 'Leave the day empty if you only know the month.', errorId: 'decision-declaredDate-error', error: 'Enter a real date.' });
    expect(html).toMatch(/<p class="ui-field__error"><svg [^>]*aria-hidden="true"/);
    expect(html).toMatch(/id="decision-declaredDate-error"[^>]*>Enter a real date\.</);
    // A fieldset's error follows its legend and hint, before the boxes and the buttons.
    expect(html.indexOf('ui-field__error')).toBeLessThan(html.indexOf('ui-date__parts'));
    expect(html.indexOf('ui-field__error')).toBeGreaterThan(html.indexOf('decision-hint'));
    for (const i of inputs(html)) {
      expect(i).toContain('aria-describedby="decision-hint decision-declaredDate-error"');
      expect(i).toContain('aria-invalid="true"');
    }
  });

  it('the error id defaults to idPrefix-error, and without an error the inputs do not reference it', () => {
    expect(render({ error: 'Enter a real date.' })).toContain('id="decision-error"');
    for (const i of inputs(render())) {
      expect(i).not.toContain('aria-describedby');
      expect(i).toContain('aria-invalid="false"');
    }
  });

  it('Today appears only with showToday, then the shortcuts in order; every button is type="button"', () => {
    expect(render()).not.toContain('<button');
    const html = render({
      showToday: true,
      shortcuts: [
        { label: 'Same as my last save: 3 Nov 2026', value: { day: '3', month: '11', year: '2026' } },
        { label: 'Same as version 2 (11 Feb 2026)', value: { day: '11', month: '2', year: '2026' } },
      ],
    });
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.map(textOf)).toEqual(['Today', 'Same as my last save: 3 Nov 2026', 'Same as version 2 (11 Feb 2026)']);
    expect(buttons.every((b) => /^<button [^>]*type="button"/.test(b))).toBe(true);
  });

  it('disabled sits on the fieldset; required is said after the legend, never on a box (a date may be partial)', () => {
    const html = render({ disabled: true, required: true });
    expect(html.match(/<fieldset[^>]*>/)?.[0]).toContain('disabled=""');
    expect(inputs(html).every((i) => !i.includes('disabled'))).toBe(true);
    expect(inputs(html).every((i) => !i.includes('required'))).toBe(true);
    expect(textOf(html.match(/<legend[\s\S]*?<\/legend>/)?.[0] ?? '')).toBe('Decided on (required)');
  });
});
