import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RouteRow, type RouteRowProps } from '@/components/ui/RouteRow';

/** Plan 1A Task 3, spec 7.2: a stage is a row of marks, one per question in question order; no fill, no percentage, no total. */

const STOPS: RouteRowProps['stops'] = [
  { id: 'q1', kind: 'done', title: 'Data sources are recorded', href: '/q/1' },
  { id: 'q2', kind: 'partly', title: 'Consent covers this use', href: '/q/2' },
  { id: 'q3', kind: 'not_yet', title: 'A data protection impact assessment exists', href: '/q/3', current: true },
  { id: 'q4', kind: 'no_decision', title: 'Retention is set' },
];
const TALLY = { done: 1, partly: 1, not_yet: 1, no_decision: 1 };

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('RouteRow', () => {
  it('RouteRow: one stop per item in order, no progress element, no percentage', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    // The brief's pattern was /class="ui-route-row__stop/; it also matched the list's own class "ui-route-row__stops".
    expect(html.match(/class="ui-route-row__stop[ "]/g)).toHaveLength(STOPS.length);
    expect(html).not.toMatch(/<progress|role="progressbar"|role="meter"|%|style="[^"]*width/);
    expect(html).toContain('aria-current="step"');
  });

  it('the list is labelled, and each stop says its title and its status in words, in question order', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html).toMatch(/<ol class="ui-route-row__stops" aria-label="Pre-processing">/);
    const spoken = [...html.matchAll(/<span class="visually-hidden">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
    expect(spoken).toEqual([
      'Data sources are recorded: Done', 'Consent covers this use: Partly',
      'A data protection impact assessment exists: Not yet', 'Retention is set: No decision',
    ]);
  });

  it('only the current stop carries aria-current and the current class, and a stop with an address is a link', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="ui-route-row__stop ui-route-row__stop--current"[^>]*><a [^>]*aria-current="step"[^>]*href="\/q\/3"/);
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it('the tally follows the row in words', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html).toMatch(/<\/ol><p class="ui-route-row__tally">1 done, 1 partly, 1 not yet, 1 no decision<\/p>/);
  });
});
