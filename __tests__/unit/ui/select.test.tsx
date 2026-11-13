import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';

/** Plan 1A Task 4: Select (decision B11: a styled closed control, base-select where supported). */

const selectOf = (html: string) => html.match(/<select [^>]*>/)?.[0] ?? '';

describe('Select', () => {
  it('labels the select, puts the placeholder first, then options or groups, and draws a hidden chevron', () => {
    const html = renderToStaticMarkup(
      <Select id="by" name="by" label="Decided by" placeholder="Choose a person" defaultValue=""
        groups={[{ label: 'Members', options: [{ value: 'u1', label: 'Amina' }] }, { label: 'Outside the team', options: [{ value: 'role:dpo', label: 'Data protection officer' }] }]} />,
    );
    expect(html).toMatch(/<label class="ui-field__label" for="by">Decided by<\/label>/);
    expect(html).toMatch(/<select [^>]*><option value="" selected="">Choose a person<\/option><optgroup label="Members"><option value="u1">Amina<\/option><\/optgroup><optgroup label="Outside the team">/);
    expect(html).toMatch(/<span class="ui-select__icon"><svg [^>]*aria-hidden="true"/);
    expect(html).toContain('class="ui-select__wrap"');
  });

  it('flat options; disabled and required reach the native select; error sets aria-invalid and the description', () => {
    const html = renderToStaticMarkup(
      <Select id="s" name="s" label="Status" hint="Pick one." disabled required error="Choose a status." defaultValue="a"
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />,
    );
    const select = selectOf(html);
    expect(select).toContain('disabled=""');
    expect(select).toContain('required=""');
    expect(select).toContain('aria-invalid="true"');
    expect(select).toContain('aria-describedby="s-hint s-error"');
    expect(select).toContain('class="ui-select ui-select--invalid"');
    expect(html).toContain('<option value="a" selected="">A</option>');
  });

  it('without an error, aria-invalid is false', () => {
    expect(selectOf(renderToStaticMarkup(<Select id="s" name="s" label="S" options={[]} />))).toContain('aria-invalid="false"');
  });

  it('the stylesheet removes the native look and opts into base-select only where it is supported (B11)', () => {
    const css = readFileSync('components/ui/Select.css', 'utf8');
    expect(css).toMatch(/\.ui-select\s*\{[^}]*appearance:\s*none/);
    expect(css).toMatch(/@supports \(appearance: base-select\)\s*\{[\s\S]*appearance:\s*base-select/);
  });
});
