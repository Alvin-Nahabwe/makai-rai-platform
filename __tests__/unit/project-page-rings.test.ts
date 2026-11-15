import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner's ruling, 15 Nov 2026 13:33: the ring at the end of each stage line is navy like the other stops, so orange
 * appears only on the one primary action. The line, its rings and the head disc all take --color-mark.
 */
const CSS = readFileSync(join(process.cwd(), 'components/project/ProjectPage.css'), 'utf8');
const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
};

describe('S-10 stage line rings (owner 13:33)', () => {
  it('the last stop ring is drawn in --color-mark, not the action orange', () => {
    const last = rule('.stage-line__stop--last::after');
    expect(last).toMatch(/border:\s*4px solid var\(--color-mark\)/);
    expect(last).not.toMatch(/--color-action/);
  });

  it('no stop marker or line segment uses an action colour', () => {
    for (const selector of ['.stage-line__stop::before', '.stage-line__stop::after', '.stage-line__stop--head::after', '.stage-line__stop--last::before', '.stage-line__stop--last::after']) {
      expect(rule(selector), selector).not.toMatch(/--color-action/);
    }
  });
});

/**
 * I4 round 2 (lead's rulings 2 and 6): on S-10 the marks of "Recorded so far" are drawn compactly, with no connector between
 * them (M8: the 2 px dash read as a mark of its own), so a stage's marks take at most two rows at 1440 px. Scoped to the
 * stage line: the kit's RouteRow keeps its 28 px boxes and its connector everywhere else.
 */
describe('S-10 compact route row (I4 round 2)', () => {
  const ROW = readFileSync(join(process.cwd(), 'components/ui/RouteRow.css'), 'utf8');

  it('drops the connector and draws 16 px marks on the stage line only', () => {
    expect(rule('.stage-line .ui-route-row__stop:not(:last-child)::after')).toMatch(/content:\s*none/);
    expect(rule('.stage-line .ui-route-row__point')).toMatch(/inline-size:\s*16px/);
  });

  it('leaves the kit row as it is', () => {
    expect(ROW).toMatch(/\.ui-route-row__stop:not\(:last-child\)::after \{[^}]*border-block-start: 2px solid var\(--color-mark\)/);
    expect(ROW).toMatch(/\.ui-route-row__point \{[^}]*inline-size: 28px/);
  });
});
