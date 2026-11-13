import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SavedMark } from '@/components/ui/SavedMark';
import { LocalTime } from '@/components/ui/LocalTime';
import { formatDayTime } from '@/lib/format/dates';

/**
 * Plan 1A Task 3, spec 7.3: the saved mark. Instants carry milliseconds, the only form a UtcInstant has
 * (types/record.ts; lib/format/dates.ts rejects any other), so the brief's '2026-11-11T08:23:00Z' is written with '.000'.
 */

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, ''));
const text = (el: React.ReactElement) => textOf(renderToStaticMarkup(el));

describe('SavedMark (spec 7.3)', () => {
  it('7.3: the saved mark', () => {
    const empty = renderToStaticMarkup(<SavedMark saved={null} />);
    expect(empty).toMatch(/role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/); expect(textOf(empty)).toBe('');
    const v2 = text(<SavedMark saved={{ version: 2, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02-11' }} historyHref="/h" />);
    expect(v2).toContain('Saved as version 2');
    expect(v2).toContain('Decided on 11 Feb 2026 · Saved 11 Nov 2026, 08:23 UTC');   // server render
    expect(v2).toContain('This decision is saved on the platform. Version 1 is kept in the history.');
    expect(text(<SavedMark saved={{ version: 1, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: null }} />)).not.toContain('kept in the history');
    expect(renderToStaticMarkup(<SavedMark saved={null} live={false} />)).not.toMatch(/role=|aria-live|aria-atomic/);
  });

  it('the history words link to historyHref, and stay plain words without it', () => {
    const saved = { version: 3, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02' };
    expect(renderToStaticMarkup(<SavedMark saved={saved} historyHref="/h" />)).toContain('Version 2 is kept in <a href="/h">the history</a>.');
    const plain = renderToStaticMarkup(<SavedMark saved={saved} />);
    expect(plain).not.toContain('<a ');
    expect(textOf(plain)).toContain('Decided on Feb 2026 · Saved 11 Nov 2026, 08:23 UTC');
  });

  it('with no decided date the line names only the save', () => {
    expect(text(<SavedMark saved={{ version: 1, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: null }} />))
      .toBe('Saved as version 1Saved 11 Nov 2026, 08:23 UTCThis decision is saved on the platform.');
  });

  it('live={false} keeps the same content without the live-region attributes', () => {
    const saved = { version: 2, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02-11' };
    const live = renderToStaticMarkup(<SavedMark saved={saved} />);
    const quiet = renderToStaticMarkup(<SavedMark saved={saved} live={false} />);
    expect(quiet).toBe(live.replace(' role="status" aria-live="polite" aria-atomic="true"', ''));
  });

  it('the check shape is an icon hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<SavedMark saved={{ version: 1, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: null }} />);
    expect(html).toMatch(/<span class="ui-saved__shape"><svg class="ui-icon"[^>]*aria-hidden="true"/);
  });
});

describe('formatDayTime and LocalTime (voice rule 10)', () => {
  it('formatDayTime', () => expect(formatDayTime('2026-11-11T08:23:00.000Z', 'Africa/Nairobi')).toBe('11 Nov 2026, 11:23'));

  it('formatDayTime rejects what is not an instant, as the other formatters do', () => {
    expect(() => formatDayTime('2026-11-11T08:23:00Z', 'UTC')).toThrow(RangeError);
  });

  it('LocalTime renders UTC with its label on the server, and the instant in dateTime', () => {
    expect(renderToStaticMarkup(<LocalTime at="2026-11-11T08:23:00.000Z" />)).toBe('<time dateTime="2026-11-11T08:23:00.000Z">11 Nov 2026, 08:23 UTC</time>');
    expect(renderToStaticMarkup(<LocalTime at="2026-11-11T23:30:00.000Z" dateOnly />)).toBe('<time dateTime="2026-11-11T23:30:00.000Z">11 Nov 2026</time>');
  });
});
