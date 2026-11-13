import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TextArea } from '@/components/ui/TextArea';
import { decode } from '@/__tests__/helpers/markup';

/** Plan 1A Task 4: TextArea with a count (spec 7.5). The count is plain text, not a live region. */

const count = (n: number, max: number) => (n > max ? `${n - max} characters too many` : `${n} of ${max} characters`);
const areaOf = (html: string) => html.match(/<textarea [^>]*>/)?.[0] ?? '';

describe('TextArea', () => {
  it('shows count(n, max) and links it through aria-describedby, after the hint', () => {
    const html = renderToStaticMarkup(<TextArea id="reason" name="reason" label="Reason" hint="Say why." maxLength={10} count={count} value="abc" onChange={() => {}} />);
    expect(html).toMatch(/<p class="ui-count" id="reason-count">3 of 10 characters<\/p>/);
    expect(areaOf(html)).toContain('aria-describedby="reason-hint reason-count"');
    expect(html).not.toMatch(/aria-live|role="status"/);
  });

  it('marks the count --over past the limit, and keeps the text over it (no native maxlength)', () => {
    const html = renderToStaticMarkup(<TextArea id="r" name="r" label="Reason" maxLength={3} count={count} defaultValue="abcde" />);
    expect(html).toMatch(/<p class="ui-count ui-count--over" id="r-count">2 characters too many<\/p>/);
    expect(areaOf(html)).not.toMatch(/maxlength/i);
    expect(decode(html)).toContain('>abcde</textarea>');
  });

  it('counts code points, so an emoji counts once (the unit of the 4,000 limit)', () => {
    expect(renderToStaticMarkup(<TextArea id="r" name="r" label="Reason" maxLength={10} count={count} value={'ok \u{1F600}'} onChange={() => {}} />))
      .toContain('>4 of 10 characters<');
  });

  it('is not --over at the limit', () => {
    expect(renderToStaticMarkup(<TextArea id="r" name="r" label="Reason" maxLength={3} count={count} defaultValue="abc" />)).not.toContain('ui-count--over');
  });

  it('with describedBy and an error, aria-describedby is hint, count, each id, then the error', () => {
    const html = renderToStaticMarkup(
      <TextArea id="reason" name="reason" label="Reason" hint="Say why." maxLength={10} count={count} defaultValue="" describedBy={['x']} error="Write a reason." />,
    );
    const area = areaOf(html);
    expect(area).toContain('aria-describedby="reason-hint reason-count x reason-error"');
    expect(area).toContain('aria-invalid="true"');
    expect(area).toContain('ui-textarea--invalid');
    expect(html).toMatch(/<p class="ui-field__error" id="reason-error">/);
  });

  it('without an error, aria-invalid is false; rows, required, readOnly and disabled reach the textarea', () => {
    const area = areaOf(renderToStaticMarkup(<TextArea id="r" name="r" label="Reason" maxLength={10} count={count} rows={6} required readOnly disabled />));
    expect(area).toContain('aria-invalid="false"');
    expect(area).toContain('rows="6"');
    expect(area).toContain('required=""');
    expect(area).toContain('readOnly=""');
    expect(area).toContain('disabled=""');
  });
});
