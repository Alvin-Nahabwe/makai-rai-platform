import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusMark } from '@/components/ui/StatusMark';
import type { StatusMarkKind } from '@/components/ui/types';
import { text, textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 3, spec 7.2: status is a shape and a word, in ink. One exception, the owner's ruling R8 (15 Nov 2026, over
 * spec D4): done is the sketch's filled green check, a disc in the saved green with a check in the surface colour.
 */

const KINDS: readonly StatusMarkKind[] = ['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision'];

/** The drawing primitives inside the mark's <svg>, in order, each as its tag then its attributes sorted by name. */
function shapeOf(html: string): string[] {
  const svg = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(html);
  if (!svg) throw new Error('no <svg> in the mark');
  return [...svg[1].matchAll(/<(\w+)([^>]*?)\/?>/g)].map(([, tag, attrs]) =>
    [tag, ...[...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].sort((a, b) => a[1].localeCompare(b[1])).map(([, k, v]) => `${k}=${v}`)].join(' '));
}

const SLASH = 'line stroke=currentColor stroke-linecap=round stroke-width=2 x1=6.3 x2=17.7 y1=17.7 y2=6.3';
const EXPECTED_SHAPES: Record<StatusMarkKind, string[]> = {
  done: ['circle class=ui-mark__done-disc cx=12 cy=12 r=9', 'path class=ui-mark__done-check d=M8 12.5l2.7 2.7L16 9.8 fill=none stroke-linecap=round stroke-linejoin=round stroke-width=2.2'],
  partly: ['circle cx=12 cy=12 fill=none r=8 stroke=currentColor stroke-width=2', 'path d=M12 4a8 8 0 0 1 0 16z fill=currentColor'],
  not_yet: ['circle cx=12 cy=12 fill=none r=8 stroke=currentColor stroke-width=2.5'],
  not_applicable: ['circle cx=12 cy=12 fill=none r=8 stroke=currentColor stroke-width=2', SLASH],
  does_not_apply: ['circle cx=12 cy=12 fill=none r=8 stroke=currentColor stroke-dasharray=3 2.6 stroke-width=2', SLASH],
  scope_answered: ['rect fill=currentColor height=14 width=14 x=5 y=5'],
  no_decision: ['circle cx=12 cy=12 fill=currentColor r=3.5'],
};


describe('StatusMark (spec 7.2)', () => {
  it('7.2: each kind draws its shape with its colour from CSS; only done has a check (R8)', () => {
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(<StatusMark kind={kind} />);
      expect(html).toContain(`data-mark-kind="${kind}"`);
      expect(html).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|green/i);      // colour comes from CSS only
      expect(shapeOf(html)).toEqual(EXPECTED_SHAPES[kind]);        // the primitives listed in Interfaces
    }
  });

  it('7.2: words sit beside the shape', () => expect(text(<StatusMark kind="done" noEvidence />)).toBe('Done, no evidence attached'));
  it('7.2: the personal data answer', () => expect(text(<StatusMark kind="scope_answered" scopeAnswer="not_sure" />)).toBe('Answer: Not sure'));

  it('7.2: every kind has its words, and the shape is hidden from assistive technology', () => {
    const words: Record<StatusMarkKind, string> = {
      done: 'Done', partly: 'Partly', not_yet: 'Not yet', not_applicable: 'Not applicable',
      does_not_apply: 'Does not apply (from your answer to the personal data question)', scope_answered: 'Answer: Yes', no_decision: 'No decision',
    };
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(<StatusMark kind={kind} scopeAnswer="yes" />);
      expect(textOf(html)).toBe(words[kind]);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    }
  });

  it('noEvidence speaks only with done, and scopeAnswer only with scope_answered', () => {
    expect(text(<StatusMark kind="partly" noEvidence />)).toBe('Partly');
    expect(text(<StatusMark kind="done" scopeAnswer="no" />)).toBe('Done');
  });

  it('the answer mark given no answer still has words', () => expect(text(<StatusMark kind="scope_answered" />)).toBe('Answered'));

  it('sizes 16, 20 and 24 set the drawn size, 16 by default; hidden words stay readable to assistive technology', () => {
    expect(renderToStaticMarkup(<StatusMark kind="done" />)).toMatch(/<svg[^>]*width="16" height="16"/);
    for (const size of [16, 20, 24] as const) expect(renderToStaticMarkup(<StatusMark kind="done" size={size} />)).toMatch(new RegExp(`<svg[^>]*width="${size}" height="${size}"`));
    const hidden = renderToStaticMarkup(<StatusMark kind="not_yet" words="hidden" />);
    expect(hidden).toContain('class="ui-mark__words visually-hidden"');
    expect(textOf(hidden)).toBe('Not yet');
  });
});

describe('StatusMark.css: the mark is ink, never another colour, but for done\'s green check (R8)', () => {
  const css = readFileSync('components/ui/StatusMark.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('.ui-mark sets color: var(--color-mark)', () => {
    const rule = /(?:^|\})\s*\.ui-mark\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.ui-mark rule').not.toBeNull();
    expect(rule![1]).toMatch(/(^|;|\s)color:\s*var\(--color-mark\)\s*(;|$)/);
  });

  /**
   * Every rule in every tracked stylesheet whose selector names the mark (`.ui-mark`, `.ui-mark--*`, `.ui-mark__*`) or the
   * route row's stops (`.ui-route-row__stop*`, `.ui-route-row__point`), checked for the paint it sets. The mark block is
   * --color-mark, its words ink; a route stop or point may set only --color-mark or inherit; nothing sets fill or stroke but
   * done's two parts (R8): the disc filled in the saved green and the check stroked in the surface colour, and in forced
   * colours the system's text and canvas colours.
   */
  it('no stylesheet paints a mark or a route stop in any colour but the mark\'s, or sets its fill or stroke', () => {
    const sheets = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.css'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(sheets.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sheets) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const mark = /\.ui-mark(?![\w-])|\.ui-mark(?:--|__)[\w-]+/.test(selector);
        // A stop (`__stop`, `__stop--current`, ...) or a point, never the list `__stops` or another element.
        const stop = /\.ui-route-row__(?:stop(?:--[\w-]+)?|point)(?![\w-])/.test(selector);
        if (!mark && !stop) continue;
        checked += 1;
        for (const [, prop, raw] of body.matchAll(/(?:^|;)\s*(color|fill|stroke)\s*:\s*([^;]+)/g)) {
          const value = raw.trim();
          const done = /\.ui-mark__done-(disc|check)(?![\w-])/.exec(selector)?.[1];
          const allowed = done === 'disc' ? prop === 'fill' && ['var(--color-saved)', 'CanvasText'].includes(value)
            : done === 'check' ? prop === 'stroke' && ['var(--color-surface)', 'Canvas'].includes(value)
            : prop !== 'color' ? false
            : stop ? /^(var\(--color-mark\)|inherit)$/.test(value)
            : /\.ui-mark__words(?![\w-])/.test(selector) ? value === 'var(--color-ink)'
            : value === 'var(--color-mark)';
          if (!allowed) offenders.push(`${file}: ${selector.trim()} { ${prop}: ${value} }`);
        }
      }
    }
    expect(checked, 'rules that name a mark or a route stop').toBeGreaterThan(4);
    expect(offenders).toEqual([]);
  });
});
