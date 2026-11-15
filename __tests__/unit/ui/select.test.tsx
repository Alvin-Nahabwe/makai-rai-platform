import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';

/** Plan 1A Task 4: Select (decision B11: a styled closed control, base-select where supported). */

/** Select's markup at c1c933b6 for `base` below (no aria-describedby prop): rendered from that commit's file, 15 Nov 2026. */
const SELECT_AT_070 = "<div class=\"ui-field\"><label class=\"ui-field__label\" for=\"s\">Main reason</label><div class=\"ui-field__hint\" id=\"s-hint\">h</div><div class=\"ui-select__wrap\"><select class=\"ui-select\" id=\"s\" name=\"s\" aria-invalid=\"false\" aria-describedby=\"s-hint\"><option value=\"a\">A</option></select><span class=\"ui-select__icon\"><svg class=\"ui-icon\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path d=\"m6 9 6 6 6-6\"></path></svg></span></div></div>";

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

  it('aria-describedby (additive): the caller\'s ids follow the hint and come before the error; without it the markup is the one of release 0.7.0', () => {
    const base = { id: 's', name: 's', label: 'Main reason', hint: 'h', options: [{ value: 'a', label: 'A' }] } as const;
    expect(selectOf(renderToStaticMarkup(<Select {...base} aria-describedby="s-use" error="Choose one." />))).toContain('aria-describedby="s-hint s-use s-error"');
    expect(selectOf(renderToStaticMarkup(<Select {...base} aria-describedby="s-use" hint={undefined} />))).toContain('aria-describedby="s-use"');
    // Without the prop, the markup the kit's Select produced before the prop existed (release 0.7.0, c1c933b6), pinned.
    expect(renderToStaticMarkup(<Select {...base} />)).toBe(SELECT_AT_070);
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
