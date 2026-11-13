import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, CheckboxGroup, type CheckboxGroupProps } from '@/components/ui/Checkbox';

/** Plan 1A Task 4: Checkbox and CheckboxGroup (modern-web-guidance checkbox: appearance none, currentColor, 44 px row). */

const inputs = (html: string) => html.match(/<input [^>]*>/g) ?? [];

describe('Checkbox', () => {
  it('a labelled checkbox; its hint and error describe it', () => {
    const html = renderToStaticMarkup(<Checkbox id="agree" name="agree" label="I agree" hint="You can change this later." error="Tick this to go on." />);
    const [input] = inputs(html);
    expect(input).toMatch(/type="checkbox"/);
    expect(input).toContain('id="agree"');
    expect(input).toContain('aria-describedby="agree-hint agree-error"');
    expect(input).toContain('aria-invalid="true"');
    expect(html).toMatch(/<label class="ui-checkbox__label" for="agree">I agree<\/label>/);
    expect(html).toMatch(/<p class="ui-field__error"><svg [^>]*aria-hidden="true"[\s\S]*?<span id="agree-error">Tick this to go on\.<\/span><\/span><\/p>/);
  });

  it('passes checked, defaultChecked and value', () => {
    expect(inputs(renderToStaticMarkup(<Checkbox id="c" name="c" label="C" value="x" defaultChecked />))[0]).toMatch(/value="x"[^>]*checked=""|checked=""[^>]*value="x"/);
    expect(inputs(renderToStaticMarkup(<Checkbox id="c" name="c" label="C" checked={false} onChange={() => {}} />))[0]).not.toContain('checked');
  });
});

describe('CheckboxGroup', () => {
  const OPTIONS = [
    { value: 'a', label: 'A written policy', id: 'decision-option-0' },
    { value: 'b', label: 'A named owner', hint: 'One person, by role.' },
  ];

  it('options[].id is the input id (default name-index); disabled and aria-describedby sit on the fieldset', () => {
    const html = renderToStaticMarkup(
      <CheckboxGroup name="inPlace" legend="Which of these are in place?" legendHint="Tick all that apply." options={OPTIONS}
        defaultValues={['b']} disabled aria-describedby="note" error="Tick at least one." />,
    );
    const ins = inputs(html);
    expect(ins[0]).toContain('id="decision-option-0"');
    expect(ins[1]).toContain('id="inPlace-1"');
    expect(ins[1]).toContain('checked=""');
    expect(ins.every((i) => i.includes('name="inPlace"'))).toBe(true);
    expect(ins.every((i) => !i.includes('disabled'))).toBe(true);
    const fieldset = html.match(/<fieldset[^>]*>/)?.[0] ?? '';
    expect(fieldset).toContain('class="ui-checkbox-group"');
    expect(fieldset).toContain('disabled=""');
    expect(fieldset).toContain('aria-describedby="inPlace-hint note inPlace-error"');
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Which of these are in place\?<\/legend>/);
    expect(html).toContain('id="inPlace-1-hint"');
  });

  it('a group with an error marks every box invalid', () => {
    const html = renderToStaticMarkup(<CheckboxGroup name="g" legend="G" options={OPTIONS} error="Tick at least one." />);
    expect(inputs(html).every((i) => i.includes('aria-invalid="true"'))).toBe(true);
    expect(inputs(renderToStaticMarkup(<CheckboxGroup name="g" legend="G" options={OPTIONS} />)).every((i) => i.includes('aria-invalid="false"'))).toBe(true);
  });

  /** Changes box `index` of a group to `checked` and returns what onChange received. `page` is the page's checked values. */
  function change(props: Omit<CheckboxGroupProps, 'onChange' | 'name' | 'legend'>, index: number, checked: boolean, page: string[] = []): string[] {
    const onChange = vi.fn();
    const group = CheckboxGroup({ name: 'g', legend: 'G', ...props, onChange }) as ReactElement<{ children: unknown[] }>;
    const boxes = (group.props.children[3] as Array<ReactElement<{ value: string; onChange: (e: unknown) => void }>>);
    const box = boxes[index];
    const fieldset = { querySelectorAll: () => page.map((value) => ({ value })) };
    box.props.onChange({ target: { checked, value: box.props.value, closest: () => fieldset } });
    return onChange.mock.calls[0][0] as string[];
  }

  it('onChange gives values in the options\' order in both modes; values not among the options are kept, last', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
    expect(change({ options, values: ['c'] }, 0, true)).toEqual(['a', 'c']);
    expect(change({ options, values: ['legacy', 'c'] }, 1, true)).toEqual(['b', 'c', 'legacy']);
    expect(change({ options, values: ['a', 'c'] }, 0, false)).toEqual(['c']);
    // Uncontrolled: the page's boxes, read after the change, in the options' order.
    expect(change({ options, defaultValues: ['c'] }, 0, true, ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('controlled values check exactly those options', () => {
    const html = renderToStaticMarkup(<CheckboxGroup name="g" legend="G" options={OPTIONS} values={['a']} onChange={() => {}} />);
    expect(inputs(html).map((i) => i.includes('checked=""'))).toEqual([true, false]);
  });

  it('the stylesheet draws the box with appearance none in currentColor, and the tick as a border', () => {
    const css = readFileSync('components/ui/Checkbox.css', 'utf8');
    expect(css).toMatch(/\.ui-checkbox__input\s*\{[^}]*appearance:\s*none[^}]*border:\s*2px solid currentColor/);
    expect(css).toMatch(/\.ui-checkbox__input:checked::before\s*\{[^}]*border-(?:width|style|color|block-end|inline-end)/);
  });
});
