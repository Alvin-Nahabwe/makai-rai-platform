import type { Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';

/**
 * NFR-A11Y-01 (checker): axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA rule tags reports no
 * violation of impact "serious" or "critical" in the page's current state. `state` names that
 * state (for example "S-10, error, narrow") in the failure, so a journey that checks many states
 * says which one broke.
 *
 * axe-core is injected from `node_modules` (a direct dev dependency, exact version), never from a
 * CDN: the run needs no network. Only rule ids, impacts, help text and selectors enter the
 * message, never the HTML of a node, so a record's text cannot reach a log through it.
 */
const AXE_SOURCE = require.resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);

interface Blocking {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

export async function expectNoSeriousA11yViolations(page: Page, state: string): Promise<void> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const found = await page.evaluate(async (tags): Promise<AxeResults['violations']> => {
    const axe = (window as unknown as { axe: { run(ctx: Document, opts: object): Promise<AxeResults> } }).axe;
    return (await axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations;
  }, TAGS);
  const blocking: Blocking[] = found
    .filter((v) => v.impact && BLOCKING.has(v.impact))
    .map((v) => ({
      id: v.id,
      impact: v.impact as string,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));
  if (blocking.length === 0) return;
  const lines = blocking.map((b) => `- ${b.id} (${b.impact}): ${b.help}; at ${b.targets.slice(0, 5).join(' | ')}${b.targets.length > 5 ? ` and ${b.targets.length - 5} more` : ''}`);
  throw new Error(`${state}: ${blocking.length} serious or critical accessibility violation(s)\n${lines.join('\n')}`);
}

/**
 * Call before an axe check that follows a click. The pointer rests where the click was, so a button that appears under it (a new list item) or
 * a control that reacts to hover starts a CSS transition, and axe reads the colours half way through it. The pointer goes to the corner and the
 * check waits for the CSS transitions that are running, at most `timeoutMs` (a transition that never ends is a defect the check should report,
 * not a hang), so axe sees the colours the controls settle on.
 */
export async function settleHover(page: Page, timeoutMs = 2000): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(async (limit) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const running = document.getAnimations().filter((a) => a instanceof CSSTransition);
    await Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, limit)),
    ]);
  }, timeoutMs);
}
