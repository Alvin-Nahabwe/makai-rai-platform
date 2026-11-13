import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Stepper, type StepperProps } from '@/components/ui/Stepper';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5: Stepper. A labelled <ol>; the current step says aria-current="step"; a done step is a filled disc and
 * the visually hidden word "(done)", never a tick. A list of steps, never a filled track or a progress element.
 */

const STEPS: StepperProps['steps'] = [
  { label: 'Data card', href: '/s/1', state: 'done' },
  { label: 'Model card', href: '/s/2', state: 'current' },
  { label: 'Stage review', state: 'upcoming' },
];

describe('Stepper', () => {
  const html = renderToStaticMarkup(<Stepper label="Stage documents" steps={STEPS} />);

  it('is a labelled ordered list, one item per step, with its state class', () => {
    expect(html).toMatch(/^<ol class="ui-stepper" role="list" aria-label="Stage documents">/);
    expect([...html.matchAll(/<li class="([^"]*)">/g)].map((m) => m[1])).toEqual([
      'ui-stepper__step ui-stepper__step--done', 'ui-stepper__step ui-stepper__step--current', 'ui-stepper__step',
    ]);
  });

  it('done steps contain the visually hidden "(done)" and no circle-check icon (no tick)', () => {
    const done = /<li class="ui-stepper__step ui-stepper__step--done">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? '';
    expect(done).toMatch(/Data card <span class="visually-hidden">\(done\)<\/span>/);
    expect(html.match(/\(done\)/g)).toHaveLength(1);
    expect(html).not.toMatch(/<svg|circle-check|<path/);
    expect(textOf(html)).toBe('Data card (done)Model cardStage review');
  });

  it('aria-current="step" on the current step only, on its link', () => {
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<a class="ui-stepper__label" aria-current="step" href="\/s\/2">Model card<\/a>/);
  });

  it('a step with no address is text; the disc is drawn by CSS and hidden', () => {
    expect(html).toMatch(/<li class="ui-stepper__step"><span class="ui-stepper__disc" aria-hidden="true"><\/span><span class="ui-stepper__label">Stage review<\/span><\/li>/);
    expect(html.match(/<span class="ui-stepper__disc" aria-hidden="true"><\/span>/g)).toHaveLength(3);
  });

  it('no progress element, no percentage, no mark classes', () => {
    expect(html).not.toMatch(/<progress|role="progressbar"|role="meter"|%|style=|ui-mark|data-mark-kind/);
  });

  it('done is a disc filled by its own border (forced colours keep borders, not backgrounds); no line joins the steps', () => {
    const css = readFileSync('components/ui/Stepper.css', 'utf8');
    expect(css).toMatch(/\.ui-stepper__step--done \.ui-stepper__disc\s*\{[^}]*border-width:\s*8px/);
    expect(css).not.toMatch(/background(-color)?:\s*currentColor/);
  });

  it('the links never prefetch', () => {
    expect(readFileSync('components/ui/Stepper.tsx', 'utf8')).not.toMatch(/from 'next\/link'/);
  });
});
