import type { Page } from '@playwright/test';
import type { Stage } from '../../types/record';

/**
 * The shared "no score" checks (FR-RM-01, FR-RM-04, UX-07 and NFR-A11Y-05 with spec 7.2), for the screens other units build
 * (S-08, S-10, S-11, S-14, S-28) and for the crawl in e2e/no-score-crawl.spec.ts. `expectStatusMarksInk` is the one
 * new symbol and replaces `expectNeutralStatusLabels`; the other names and signatures are unchanged.
 *
 * Markup the checks read:
 *   - text inside an element carrying `data-claims-allowed="<reason>"` is skipped by every text and
 *     shape check (FR-RM-01's allow-list "by element id", SRS line 451; PUB marks those elements);
 *   - a percentage inside an element carrying `data-source-note` (a cited study's note, ReferencesList) is not a
 *     finding: SRS 7.5.3 bans a percentage "next to the team's items", and a cited figure is not one (coordinator
 *     ruling 2, unit/cnt). Only the percentage check skips it; score words there are still checked;
 *   - a status mark is any `.ui-mark`, `.ui-mark__shape` or `[data-mark-kind]` element; a legacy status label is a
 *     `.status-label` element, read until its screen is rebuilt (expectStatusMarksInk);
 *   - an upload's own `<progress>` carries `data-upload-progress` itself or sits directly in an element that does, and
 *     is one of two progress elements allowed (never inside a route row); the other is a per-stage bar: a `<progress>`
 *     or a proportional fill inside an element carrying `data-stage-bar`, on the project page only
 *     (`/orgs/<slug>/projects/<id>`, an id and not "new"; owner, 19 Nov 2026: "Allow progress display"), whose count is in words beside
 *     it ("N of M questions recorded"). A percentage inside it is still a finding. A route row's proportional fill is any element
 *     in `.ui-route-row` with an inline style value in per cent (a custom property too) or a `width` attribute in per
 *     cent, and is a progress element too (spec 7.2).
 * Computed values are read, not source. The status-mark check (expectStatusMarksInk) compares colours with the tokens
 * `--color-mark`, `--color-ink`, `--color-ink-muted`, `--color-saved`, `--color-tint` and `--color-action-text` as
 * `:root` resolves them; its rules are listed at that function.
 *
 * Every check reads the `<main>` landmark and refuses a page that has none, because a page with no
 * `<main>` would otherwise pass for having nothing in it. A check that finds nothing to examine
 * (no status mark or label, no sentinel on the page) fails for the same reason.
 */

/**
 * SRS line 451's regex with one change (owner default B39). Written as the SRS has it, the `score:`
 * alternative sat inside `\b(...)\b`, where the closing `\b` needs a word character after the colon:
 * it matched `Score:3` and not `Score: 3`. It now stands outside that group and allows a space before
 * the colon, so `Score: 3`, `score:3` and `Score : 3` match. The other alternatives are the SRS's.
 */
export const SCORE_WORDS: RegExp = /\b(maturity|overall score|readiness score|assessment scores?|band|level [1-5])\b|\bscore\s*:/i;

/** A percentage next to a number: FR-RM-01 ("no element shows a percentage next to a count"). */
const PERCENT = /\d+(?:[.,]\d+)?\s?%/g;
/** FR-RM-04 (SRS line 469): no element is labelled as a total. */
const TOTAL_WORDS = /\b(total|overall|in all)\b/gi;
/** Elements that draw a progress bar, a gauge or a meter. A `<canvas>` or an undecorated `<svg>` is a drawn chart. */
const PROGRESS_KINDS: readonly string[] = ['<progress>', '<meter>', 'role=progressbar', 'role=meter', 'proportional fill'];

type Shape = { kind: string; html: string };
type MainSnapshot = {
  /** Text nodes of every <main>, outside data-claims-allowed elements, joined by one space. */
  text: string;
  /** The same, without the text inside data-source-note elements: what the percentage check reads. */
  percentText: string;
  /** aria-label values of elements outside data-claims-allowed elements. */
  ariaLabels: string[];
  shapes: Shape[];
};

/**
 * Reads the page once. The text includes text that is in the DOM but not shown (hidden panels,
 * `hidden`, a closed <details>): a score left in a collapsed panel is still score code.
 */
async function snapshotMain(page: Page, who: string): Promise<MainSnapshot> {
  const snap = await page.evaluate(() => {
    const mains = Array.from(document.querySelectorAll('main'));
    if (mains.length === 0) return null;
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const outside = (el: Element) => el.closest('[data-claims-allowed]') === null;
    // The per-stage bar is allowed on the project page only: /orgs/<slug>/projects/<id> (an id, not "new").
    const onProjectPage = /^\/orgs\/[^/]+\/projects\/(?!new\/?$)[^/]+\/?$/.test(window.location.pathname);
    const inStageBar = (el: Element) => onProjectPage && el.closest('[data-stage-bar]') !== null;
    const texts: string[] = [];
    const percentTexts: string[] = [];
    const ariaLabels: string[] = [];
    const shapes: Array<{ kind: string; html: string }> = [];
    for (const main of mains) {
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || skipTags.has(parent.tagName) || !outside(parent)) continue;
        const t = (node.nodeValue ?? '').trim();
        if (t) texts.push(t);
        if (t && parent.closest('[data-source-note]') === null) percentTexts.push(t);
      }
      for (const el of [main, ...Array.from(main.querySelectorAll('*'))]) {
        if (!outside(el)) continue;
        const label = el.getAttribute('aria-label');
        if (label) ariaLabels.push(label);
        const tag = el.localName;
        const inRouteRow = el.closest('.ui-route-row') !== null;
        const kind =
          tag === 'progress' ? (((el.matches('[data-upload-progress]') || el.parentElement?.matches('[data-upload-progress]')) && !inRouteRow) || inStageBar(el) ? null : '<progress>')
          : tag === 'meter' ? '<meter>'
          : el.getAttribute('role') === 'progressbar' ? 'role=progressbar'
          : el.getAttribute('role') === 'meter' ? 'role=meter'
          : tag === 'canvas' ? '<canvas>'
          : tag === 'svg' && el.closest('svg[aria-hidden="true"]') === null ? '<svg> without aria-hidden="true"'
          : null;
        if (kind) shapes.push({ kind, html: el.outerHTML.slice(0, 90) });
        if (inRouteRow) {
          // Any inline value in per cent (a custom property too), or a width attribute in per cent, is a drawn fill.
          const style = 'style' in el ? (el as HTMLElement).style : null;
          let percent = (el.getAttribute('width') ?? '').includes('%');
          for (let i = 0; style && i < style.length; i += 1) {
            if (style.getPropertyValue(style[i]).includes('%')) percent = true;
          }
          if (percent && !inStageBar(el)) shapes.push({ kind: 'proportional fill', html: el.outerHTML.slice(0, 90) });
        }
      }
    }
    return { text: texts.join(' '), percentText: percentTexts.join(' '), ariaLabels, shapes };
  });
  if (!snap) throw new Error(`${who}: no <main> element, so there is nothing to check`);
  return snap;
}

function around(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 25), index + length + 25).replace(/\s+/g, ' ').trim();
}

function fail(who: string, findings: string[]): void {
  if (findings.length > 0) throw new Error(`${who}: ${findings.length} finding(s)\n  - ${findings.join('\n  - ')}`);
}

function shapeFindings(s: MainSnapshot, kinds: readonly string[]): string[] {
  return s.shapes.filter((x) => kinds.includes(x.kind) || (kinds.includes('<svg>') && x.kind.startsWith('<svg>')))
    .map((x) => `${x.kind} in ${x.html}`);
}

/** FR-RM-01 (SRS line 451): no score word, no percentage, no progress bar, meter, gauge or drawn chart. */
export async function expectNoScoreShapes(page: Page, where: string): Promise<void> {
  const s = await snapshotMain(page, where);
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const m of s.text.matchAll(new RegExp(SCORE_WORDS.source, 'gi'))) {
    const key = `w:${m[0].toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); findings.push(`score word "${m[0]}" in "${around(s.text, m.index, m[0].length)}"`); }
  }
  for (const m of s.percentText.matchAll(PERCENT)) {
    const key = `p:${m[0]}`;
    if (!seen.has(key)) { seen.add(key); findings.push(`percentage "${m[0].replace(/\s+/g, ' ')}" in "${around(s.percentText, m.index, m[0].length)}"`); }
  }
  findings.push(...shapeFindings(s, [...PROGRESS_KINDS, '<svg>', '<canvas>']));
  fail(where, findings);
}

/** A whole number: not part of a longer digit run, and not the integer part of a decimal. */
function wholeNumber(n: number): RegExp {
  return new RegExp(`(?<![0-9.,])${n}(?![0-9]|[.,][0-9])`);
}

/**
 * The sentinels of a fixture (SRS line 469): per stage, positive integers that are never zero, differ
 * between the three stages, and whose sum is not itself a sentinel. Returns, for each measure, the sum
 * of its three sentinels, which must appear nowhere. A set that breaks these cannot tell the stages
 * apart or would match unrelated text, so it is refused before the page is read.
 */
function sentinelSums(sentinels: Record<Stage, number[]>): number[] {
  const stages = Object.keys(sentinels) as Stage[];
  if (stages.length !== 3) throw new Error(`sentinel set must name the three stages, got ${stages.join(', ')}`);
  const measures = sentinels[stages[0]].length;
  if (measures === 0) throw new Error('sentinel set is empty');
  const all = stages.flatMap((st) => sentinels[st]);
  for (const st of stages) {
    if (sentinels[st].length !== measures) throw new Error(`sentinel set: ${st} has ${sentinels[st].length} measures, expected ${measures}`);
  }
  for (const n of all) {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`sentinel ${n} must be a positive integer, never zero`);
  }
  const sums: number[] = [];
  for (let i = 0; i < measures; i += 1) {
    const values = stages.map((st) => sentinels[st][i]);
    if (new Set(values).size !== values.length) throw new Error(`sentinel set: measure ${i} repeats a value across stages (${values.join(', ')})`);
    const sum = values.reduce((a, b) => a + b, 0);
    if (all.includes(sum)) throw new Error(`sentinel set: the sum ${sum} of measure ${i} is itself a sentinel`);
    sums.push(sum);
  }
  return sums;
}

function sentinelFindings(s: MainSnapshot, sentinels: Record<Stage, number[]>, sums: number[], own: readonly string[]): string[] {
  const text = withoutOwnText(s.text, own);
  const findings: string[] = [];
  for (const [stage, values] of Object.entries(sentinels) as Array<[Stage, number[]]>) {
    for (const n of values) {
      if (!wholeNumber(n).test(text)) findings.push(`sentinel ${n} (${stage}) does not appear as a whole number in text`);
    }
  }
  for (const sum of sums) {
    const m = wholeNumber(sum).exec(text);
    if (m) findings.push(`the sum ${sum} of three stages' counts appears: "${around(text, m.index, String(sum).length)}"`);
  }
  return findings;
}

/**
 * `ownText`: text the test itself wrote into its fixture and the page prints back, such as the organisation's name.
 * The sentinel and sum checks do not read it, because digits in it are not a count the page shows. buildOrg names an
 * organisation 'Fixture Org <LABEL> <run id>' with a random run id (__tests__/helpers/recordFixture.ts), S-10 prints the
 * name in its breadcrumb, and an id such as 'mwdfwl83-ffa0ab' would otherwise read as the sum 83 shown, or stand in for
 * a count of 83 the page does not show. The percentage, progress and total-label checks read the whole text.
 */
export type CountCheckOptions = { ownText?: readonly string[] };

/**
 * The own text as the checks use it: white space collapsed, longest first so that a name goes before a shorter text it
 * contains. Each must hold a letter: it is a name or an address, and a bare number would hand the check the total to
 * look away from. Refused before the page is read, as a bad sentinel set is.
 */
function ownTextOf(opts: CountCheckOptions, who: string): string[] {
  const own = (opts.ownText ?? []).map((t) => t.replace(/\s+/g, ' ').trim());
  for (const t of own) {
    if (!/\p{L}/u.test(t)) throw new Error(`${who}: own text ${JSON.stringify(t)} must be a name or an address with a letter in it, not a number or nothing`);
  }
  return own.sort((a, b) => b.length - a.length);
}

/**
 * `text` without the own text. An occurrence counts only where it stands whole, with no letter or digit running on from
 * either side of it: 'Org 83' inside 'Org 8341' is the page's text, not the test's. Each occurrence becomes one space.
 */
function withoutOwnText(text: string, own: readonly string[]): string {
  if (own.length === 0) return text;
  let out = text.replace(/\s+/g, ' ');
  for (const t of own) {
    const literal = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, 'gu'), ' ');
  }
  return out;
}

function totalLabelFindings(s: MainSnapshot): string[] {
  const findings: string[] = [];
  for (const m of s.text.matchAll(TOTAL_WORDS)) findings.push(`an element is labelled "${m[0]}" in "${around(s.text, m.index, m[0].length)}"`);
  for (const label of s.ariaLabels) {
    if (new RegExp(TOTAL_WORDS.source, 'i').test(label)) findings.push(`an element has aria-label "${label}"`);
  }
  return findings;
}

/**
 * FR-RM-04 (SRS line 469): every sentinel count is a whole number in text; no `%` in main; no progress
 * element; no element labelled "total", "overall" or "in all"; and the sum of any measure's three
 * sentinels appears nowhere. Which column a count sits in is the screen owner's own test. The sentinels and their sums
 * are looked for outside `opts.ownText`.
 */
export async function expectCountsAsWholeNumbersPerStage(page: Page, sentinels: Record<Stage, number[]>, opts: CountCheckOptions = {}): Promise<void> {
  const who = `expectCountsAsWholeNumbersPerStage(${page.url()})`;
  const sums = sentinelSums(sentinels);
  const own = ownTextOf(opts, who);
  const s = await snapshotMain(page, who);
  const findings = [
    ...sentinelFindings(s, sentinels, sums, own),
    ...(s.text.includes('%') ? [`"%" appears in "${around(s.text, s.text.indexOf('%'), 1)}"`] : []),
    ...shapeFindings(s, PROGRESS_KINDS),
    ...totalLabelFindings(s),
  ];
  fail(who, findings);
}

/**
 * UX-07: no screen shows a count summed across stages. The sentinel counts must be on the page (a page
 * that shows none of them says nothing about their sum), their sums must not be, and nothing is labelled
 * as a total. The sentinels and their sums are looked for outside `opts.ownText`.
 */
export async function expectNoCrossStageTotal(page: Page, sentinels: Record<Stage, number[]>, opts: CountCheckOptions = {}): Promise<void> {
  const sums = sentinelSums(sentinels);
  const who = `expectNoCrossStageTotal(${page.url()})`;
  const own = ownTextOf(opts, who);
  const s = await snapshotMain(page, who);
  fail(who, [...sentinelFindings(s, sentinels, sums, own), ...totalLabelFindings(s)]);
}

/** The characters that draw a tick: U+2713, U+2714, U+2705, U+2611 and U+1F5F8. */
const TICK_CHARACTERS = /[\u2713\u2714\u2705\u2611\u{1F5F8}]/u;

type Point = { x: number; y: number };

/** Three points a, b, c of an open run: b is lower on the screen than both ends and strictly between them across. */
function isTick(a: Point, b: Point, c: Point): boolean {
  return b.y > a.y && b.y > c.y && Math.min(a.x, c.x) < b.x && b.x < Math.max(a.x, c.x);
}

/** Drops a point equal to the one before it, so that a repeated point does not hide a tick. */
function withoutRepeats(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
}

const NUMBER = String.raw`[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?`;
const PATH_TOKEN = new RegExp(`[a-zA-Z]|${NUMBER}`, 'g');
const isLetter = (t: string): boolean => /^[a-zA-Z]$/.test(t);

/**
 * Whether a path's `d` draws a tick: a subpath of exactly two straight segments, open, whose middle point is lower than
 * both ends and between them (a point repeated in a row counts once). `'unreadable'` when a command needs a current
 * point that a curve or arc left unknown. A chevron pointing down is a tick by this test.
 */
export function tickShapeOf(d: string): 'tick' | 'clear' | 'unreadable' {
  const tokens = d.match(PATH_TOKEN) ?? [];
  let cur: Point | null = null;
  let start: Point | null = null;
  let sub: { points: Point[] | null; closed: boolean } | null = null;
  let found = false;
  let first = true;
  const endSub = (): void => {
    if (sub && sub.points && !sub.closed) {
      const pts = withoutRepeats(sub.points);
      if (pts.length === 3 && isTick(pts[0], pts[1], pts[2])) found = true;
    }
    sub = null;
  };
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!isLetter(cmd)) continue; // numbers before any command: nothing to draw
    const lower = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      if (sub) { sub.closed = true; endSub(); }
      cur = start;
      continue;
    }
    if ('MLHV'.includes(up)) {
      let current = up;
      while (i < tokens.length && !isLetter(tokens[i])) {
        const n1 = Number(tokens[i]);
        const arity = up === 'H' || up === 'V' ? 1 : 2;
        if (arity === 2 && (i + 1 >= tokens.length || isLetter(tokens[i + 1]))) { i = tokens.length; break; }
        const n2 = arity === 2 ? Number(tokens[i + 1]) : 0;
        i += arity;
        const relative = lower && !(first && current === 'M');
        let p: Point;
        if (up === 'H' || up === 'V') {
          if (!cur) return 'unreadable';
          p = up === 'H' ? { x: relative ? cur.x + n1 : n1, y: cur.y } : { x: cur.x, y: relative ? cur.y + n1 : n1 };
        } else if (relative) {
          if (!cur) return 'unreadable';
          p = { x: cur.x + n1, y: cur.y + n2 };
        } else {
          p = { x: n1, y: n2 };
        }
        if (current === 'M') {
          endSub();
          start = p;
          sub = { points: [p], closed: false };
        } else {
          if (!sub) sub = { points: cur ? [cur] : [], closed: false };
          sub.points?.push(p);
        }
        cur = p;
        first = false;
        if (current === 'M') current = 'L'; // further pairs after a move are lines
      }
      continue;
    }
    // Curves and arcs: the subpath is not straight and the current point is unknown until the next absolute point.
    if (!sub) sub = { points: null, closed: false };
    sub.points = null;
    cur = null;
    first = false;
    while (i < tokens.length && !isLetter(tokens[i])) i += 1;
  }
  endSub();
  return found ? 'tick' : 'clear';
}

/** A `polyline`'s `points`: three points (a point repeated in a row counts once) that pass the tick test. A `polygon` is closed and never one. */
function polylineIsTick(points: string): boolean {
  const n = (points.match(new RegExp(NUMBER, 'g')) ?? []).map(Number);
  if (n.length % 2 !== 0) return false;
  const pts: Point[] = [];
  for (let i = 0; i < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
  const run = withoutRepeats(pts);
  return run.length === 3 && isTick(run[0], run[1], run[2]);
}

/**
 * Green, as the no-tick, no-green rule means it: not transparent, and either the saved mark's colour or hue 70 to 170
 * degrees with saturation at least 0.2 (HSL from the sRGB values). Reads `rgb(...)` and `rgba(...)`; `none` and
 * `transparent` are never green; any other non-empty form throws, so that a colour the check cannot read is a finding.
 */
export function isGreenColour(value: string, saved: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'none' || v === 'transparent') return false;
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(v);
  if (!m) throw new Error(`cannot read colour ${JSON.stringify(value)}`);
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha === 0) return false;
  if (v === saved.trim().toLowerCase()) return true;
  const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return false;
  const l = (max + min) / 2;
  const saturation = d / (1 - Math.abs(2 * l - 1));
  const hue = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return hue >= 70 && hue <= 170 && saturation >= 0.2;
}

/** A computed background that paints nothing: `transparent`, or an `rgba(...)` with alpha 0. */
function isTransparent(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(v);
}

/** What one element, or one of its `::before` and `::after`, computes to. */
type ElementFacts = {
  html: string;
  tag: string;
  /** '' for the element itself. */
  pseudo: '' | '::before' | '::after';
  color: string;
  background: string;
  /** Colours of the sides whose border width is not 0px. */
  borders: string[];
  /** Set on the seven graphics elements; null elsewhere. */
  paint: { fill: string; stroke: string } | null;
  d: string | null;
  points: string | null;
  /** A pseudo-element's computed `content`; null for an element. */
  content: string | null;
  /** The two graphics of Done's filled green check (R8), or null. */
  done: 'disc' | 'check' | null;
};
type MarkFacts = {
  html: string;
  color: string;
  text: string;
  /** `.ui-mark` or `[data-mark-kind]`: its own text must hold a letter. */
  wrapper: boolean;
  isShape: boolean;
  /** Whether an ancestor is a wrapper. */
  insideWrapper: boolean;
  parentText: string;
};
type InkSnapshot = {
  tokens: Record<'mark' | 'ink' | 'muted' | 'saved' | 'tint' | 'action' | 'surface', string | null>;
  marks: MarkFacts[];
  /** Every mark element and every element inside one, with their pseudo-elements, once. */
  markTree: ElementFacts[];
  words: Array<{ html: string; color: string }>;
  labels: Array<{ html: string; text: string; color: string; tree: ElementFacts[] }>;
};

/**
 * NFR-A11Y-05 (SC 1.4.1) with spec 7.2: a status is words, its mark is a shape, and neither is carried by colour.
 * The mark elements are every `.ui-mark`, `.ui-mark__shape` and `[data-mark-kind]` in `<main>`; every `.status-label`
 * there is read too, until its screen is rebuilt. What it holds, by rule group:
 *   - a mark element's own colour is `--color-mark`, and so is the fill and stroke of each graphic in it (a `line`'s
 *     fill paints nothing and is not read); a mark's words (`.ui-mark__words`) are `--color-ink`, and a mark has words;
 *   - on every mark element, legacy label and element inside either, and on their `::before` and `::after` that
 *     exist: no tick (a tick-shaped `path` or `polyline`, or a tick character in the text or the pseudo-element's
 *     content) and no green in text colour, background, a drawn border, fill or stroke;
 *   - on the same elements, text colour is one of `--color-mark`, `--color-ink`, `--color-ink-muted`; background is
 *     transparent or `--color-tint`; a drawn border is one of those inks or `--color-action-text`;
 *   - a legacy label has words and its own colour is `--color-ink` or `--color-ink-muted`.
 * One exception, the owner's ruling R8 (15 Nov 2026, over spec D4): Done's mark is the filled green check the kit draws,
 * a disc (`.ui-mark__done-disc`) filled with `--color-saved` and a check (`.ui-mark__done-check`) stroked with
 * `--color-surface`, inside a shape drawn for Done (`svg.ui-mark__shape[data-shape-kind="done"]`) whose nearest
 * `[data-mark-kind]`, if any, is Done too. Those two graphics, and only they, are held to exactly those paints instead of the rules above,
 * and the check's tick shape is allowed; the mark's own colour, its words and every other mark stay ink.
 * A page with neither kind of element fails (a check that found nothing must not pass). Known limits: a tick drawn
 * as a closed outline, over two subpaths or two `line` elements, with a collinear extra point or with curves is not
 * recognised, and a chevron pointing down reads as a tick.
 */
export async function expectStatusMarksInk(page: Page): Promise<void> {
  const who = `expectStatusMarksInk(${page.url()})`;
  const snap: InkSnapshot | null = await page.evaluate(() => {
    const mains = Array.from(document.querySelectorAll('main'));
    if (mains.length === 0) return null;
    const rootStyle = getComputedStyle(document.documentElement);
    const tokenColour = (token: string): string | null => {
      if (rootStyle.getPropertyValue(token).trim() === '') return null;
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.documentElement.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    const GRAPHICS = new Set(['circle', 'ellipse', 'path', 'polygon', 'polyline', 'rect', 'line']);
    const WRAPPER = '.ui-mark, [data-mark-kind]';
    const borderColours = (cs: CSSStyleDeclaration): string[] => {
      const out: string[] = [];
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (cs.getPropertyValue(`border-${side}-width`) !== '0px') out.push(cs.getPropertyValue(`border-${side}-color`));
      }
      return out;
    };
    const facts = (el: Element) => {
      const cs = getComputedStyle(el);
      const tag = el.localName;
      const html = el.outerHTML.slice(0, 90);
      const own = {
        html,
        tag,
        pseudo: '' as const,
        color: cs.color,
        background: cs.backgroundColor,
        borders: borderColours(cs),
        paint: GRAPHICS.has(tag) ? { fill: cs.fill, stroke: cs.stroke } : null,
        d: tag === 'path' ? (el.getAttribute('d') ?? '') : null,
        points: tag === 'polyline' ? (el.getAttribute('points') ?? '') : null,
        content: null,
        // R8: only inside a mark's shape drawn for Done, as the kit draws it (StatusMark's MarkShape writes
        // data-shape-kind="done"), and, where a mark element around it names a kind (StatusMark's data-mark-kind, RouteRow's
        // stop), only when that kind is Done too: Done's check drawn for a Partly mark is a green tick, not the ruling
        // (review round 2, A N-2).
        done: el.closest('svg.ui-mark__shape[data-shape-kind="done"]') === null
          || (el.closest('[data-mark-kind]') !== null && el.closest('[data-mark-kind]')?.getAttribute('data-mark-kind') !== 'done') ? null
          : el.matches('.ui-mark__done-disc') ? ('disc' as const) : el.matches('.ui-mark__done-check') ? ('check' as const) : null,
      };
      const out: Array<typeof own | { html: string; tag: string; pseudo: '::before' | '::after'; color: string; background: string; borders: string[]; paint: null; d: null; points: null; content: string; done: null }> = [own];
      for (const pseudo of ['::before', '::after'] as const) {
        const ps = getComputedStyle(el, pseudo);
        // A pseudo-element whose content is none or normal does not exist.
        if (ps.content === 'none' || ps.content === 'normal') continue;
        out.push({ html, tag, pseudo, color: ps.color, background: ps.backgroundColor, borders: borderColours(ps), paint: null, d: null, points: null, content: ps.content, done: null });
      }
      return out;
    };
    const treeOf = (roots: Element[]) => {
      const seen = new Set<Element>();
      for (const r of roots) for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) seen.add(el);
      return Array.from(seen).flatMap(facts);
    };
    const markEls = new Set<Element>();
    const labelEls: Element[] = [];
    const wordEls: Element[] = [];
    for (const main of mains) {
      for (const el of Array.from(main.querySelectorAll('.ui-mark, .ui-mark__shape, [data-mark-kind]'))) markEls.add(el);
      labelEls.push(...Array.from(main.querySelectorAll('.status-label')));
      wordEls.push(...Array.from(main.querySelectorAll('.ui-mark__words')));
    }
    const marks = Array.from(markEls).map((el) => ({
      html: el.outerHTML.slice(0, 90),
      color: getComputedStyle(el).color,
      text: el.textContent ?? '',
      wrapper: el.matches(WRAPPER),
      isShape: el.matches('.ui-mark__shape'),
      insideWrapper: el.parentElement?.closest(WRAPPER) != null,
      parentText: el.parentElement?.textContent ?? '',
    }));
    return {
      tokens: {
        mark: tokenColour('--color-mark'),
        ink: tokenColour('--color-ink'),
        muted: tokenColour('--color-ink-muted'),
        saved: tokenColour('--color-saved'),
        tint: tokenColour('--color-tint'),
        action: tokenColour('--color-action-text'),
        surface: tokenColour('--color-surface'),
      },
      marks,
      markTree: treeOf(Array.from(markEls)),
      words: wordEls.map((el) => ({ html: el.outerHTML.slice(0, 90), color: getComputedStyle(el).color })),
      labels: labelEls.map((el) => ({
        html: el.outerHTML.slice(0, 90),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        color: getComputedStyle(el).color,
        tree: treeOf([el]),
      })),
    };
  });
  if (!snap) throw new Error(`${who}: no <main> element, so there is nothing to check`);
  const { mark, ink, muted, saved, tint, action, surface } = snap.tokens;
  const missing = ([['--color-mark', mark], ['--color-ink', ink], ['--color-ink-muted', muted], ['--color-saved', saved], ['--color-tint', tint], ['--color-action-text', action], ['--color-surface', surface]] as Array<[string, string | null]>)
    .filter(([, v]) => v === null)
    .map(([name]) => `${name} is not defined on :root, so no colour can be compared with it`);
  if (missing.length > 0) return fail(who, missing);
  if (mark === null || ink === null || muted === null || saved === null || tint === null || action === null || surface === null) {
    throw new Error(`${who}: a token resolved to nothing after the defined-on-:root check`);
  }
  if (snap.marks.length === 0 && snap.labels.length === 0) return fail(who, ['no status mark: neither a .ui-mark, .ui-mark__shape or [data-mark-kind] nor a .status-label in <main>']);

  const inks = [mark, ink, muted];
  const findings: string[] = [];
  const green = (value: string, where: string, property: string): void => {
    try {
      if (isGreenColour(value, saved)) findings.push(`${property} ${value} is green in ${where}`);
    } catch {
      findings.push(`cannot read colour ${JSON.stringify(value)} (${property}) in ${where}`);
    }
  };
  const treeFindings = (tree: ElementFacts[]): void => {
    for (const e of tree) {
      const where = e.pseudo === '' ? e.html : `${e.html} ${e.pseudo}`;
      green(e.color, where, 'color');
      green(e.background, where, 'background-color');
      for (const b of e.borders) green(b, where, 'border colour');
      // Done's disc and check (R8) are held to their own paints below; their green and their tick are the ruling.
      if (e.paint && e.done === null) {
        green(e.paint.fill, where, 'fill');
        green(e.paint.stroke, where, 'stroke');
      }
      if (!inks.includes(e.color)) findings.push(`colour ${e.color} is not an ink (--color-mark, --color-ink, --color-ink-muted) in ${where}`);
      if (e.background !== tint && !isTransparent(e.background)) findings.push(`background-color ${e.background} is neither transparent nor --color-tint in ${where}`);
      for (const b of e.borders) {
        if (!inks.includes(b) && b !== action) findings.push(`border colour ${b} is not an ink or --color-action-text in ${where}`);
      }
      if (e.content !== null && TICK_CHARACTERS.test(e.content)) findings.push(`tick character in the content of ${where}`);
      if (e.d !== null && e.done !== 'check') {
        const verdict = tickShapeOf(e.d);
        if (verdict === 'tick') findings.push(`tick-shaped path in ${where}`);
        if (verdict === 'unreadable') findings.push(`cannot read path ${JSON.stringify(e.d)} in ${where}`);
      }
      if (e.points !== null && polylineIsTick(e.points)) findings.push(`tick-shaped polyline in ${where}`);
    }
  };

  for (const m of snap.marks) {
    if (m.color !== mark) findings.push(`${m.html}: colour ${m.color} is not --color-mark (${mark})`);
    if (TICK_CHARACTERS.test(m.text)) findings.push(`tick character in the text of ${m.html}`);
    if (m.wrapper && !/\p{L}/u.test(m.text)) findings.push(`${m.html} has no words; a status must be text, not colour or a shape alone (SC 1.4.1)`);
    if (m.isShape && !m.wrapper && !m.insideWrapper && !/\p{L}/u.test(m.parentText)) {
      findings.push(`${m.html} has no words beside it; a status must be text, not colour or a shape alone (SC 1.4.1)`);
    }
  }
  for (const e of snap.markTree) {
    if (e.paint && e.done === 'disc') {
      if (e.paint.fill !== saved) findings.push(`fill ${e.paint.fill} of Done's disc is not --color-saved (${saved}) in ${e.html}`);
      if (e.paint.stroke !== 'none') findings.push(`stroke ${e.paint.stroke} on Done's disc in ${e.html}`);
    } else if (e.paint && e.done === 'check') {
      if (e.paint.stroke !== surface) findings.push(`stroke ${e.paint.stroke} of Done's check is not --color-surface (${surface}) in ${e.html}`);
      if (e.paint.fill !== 'none') findings.push(`fill ${e.paint.fill} on Done's check in ${e.html}`);
    } else if (e.paint) {
      if (e.paint.stroke !== 'none' && e.paint.stroke !== mark) findings.push(`stroke ${e.paint.stroke} is not --color-mark (${mark}) in ${e.html}`);
      if (e.tag !== 'line' && e.paint.fill !== 'none' && e.paint.fill !== mark) findings.push(`fill ${e.paint.fill} is not --color-mark (${mark}) in ${e.html}`);
    }
  }
  treeFindings(snap.markTree);
  for (const w of snap.words) {
    if (w.color !== ink) findings.push(`${w.html}: colour ${w.color} is not --color-ink (${ink})`);
  }
  for (const l of snap.labels) {
    if (!/\p{L}/u.test(l.text)) findings.push(`.status-label "${l.text}" has no words; a status must be text, not colour or a number alone (SC 1.4.1)`);
    if (l.color !== ink && l.color !== muted) {
      findings.push(`.status-label "${l.text}": colour ${l.color} is neither --color-ink (${ink}) nor --color-ink-muted (${muted})`);
    }
    if (TICK_CHARACTERS.test(l.text)) findings.push(`tick character in the text of .status-label "${l.text}"`);
    treeFindings(l.tree);
  }
  fail(who, findings);
}
