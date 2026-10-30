import type { Page } from '@playwright/test';
import type { Stage } from '../../types/record';

/**
 * The shared "no score" checks (FR-RM-01, FR-RM-04, UX-06, UX-07), for the screens other units build
 * (S-08, S-10, S-11, S-14, S-28) and for the crawl in e2e/no-score-crawl.spec.ts. The names and
 * signatures are contract symbols (00-contract.md, "Further cross-unit symbols", row `e2e/helpers/noScore.ts`).
 *
 * Markup the checks read:
 *   - text inside an element carrying `data-claims-allowed="<reason>"` is skipped by every text and
 *     shape check (FR-RM-01's allow-list "by element id", SRS line 451; PUB marks those elements);
 *   - a status label is an element with class `status-label`;
 *   - the warning tint is the class `status-label--warning`.
 * They read computed values only. RM adds no style rule for either class; UI owns the tokens.
 *
 * Every check reads the `<main>` landmark and refuses a page that has none, because a page with no
 * `<main>` would otherwise pass for having nothing in it. A check that finds nothing to examine
 * (no status label, no sentinel on the page) fails for the same reason.
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
/** UX-06 (SRS line 2296): the warning tint is allowed on these three labels only. */
const WARNING_LABELS: ReadonlySet<string> = new Set(['overdue', 'owner cannot act', 'no agreement recorded']);

type Shape = { kind: string; html: string };
type MainSnapshot = {
  /** Text nodes of every <main>, outside data-claims-allowed elements, joined by one space. */
  text: string;
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
    const texts: string[] = [];
    const ariaLabels: string[] = [];
    const shapes: Array<{ kind: string; html: string }> = [];
    for (const main of mains) {
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || skipTags.has(parent.tagName) || !outside(parent)) continue;
        const t = (node.nodeValue ?? '').trim();
        if (t) texts.push(t);
      }
      for (const el of [main, ...Array.from(main.querySelectorAll('*'))]) {
        if (!outside(el)) continue;
        const label = el.getAttribute('aria-label');
        if (label) ariaLabels.push(label);
        const tag = el.localName;
        const kind =
          tag === 'progress' ? '<progress>'
          : tag === 'meter' ? '<meter>'
          : el.getAttribute('role') === 'progressbar' ? 'role=progressbar'
          : tag === 'svg' && el.closest('svg[aria-hidden="true"]') === null ? '<svg> without aria-hidden="true"'
          : null;
        if (kind) shapes.push({ kind, html: el.outerHTML.slice(0, 90) });
      }
    }
    return { text: texts.join(' '), ariaLabels, shapes };
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
  for (const m of s.text.matchAll(PERCENT)) {
    const key = `p:${m[0]}`;
    if (!seen.has(key)) { seen.add(key); findings.push(`percentage "${m[0].replace(/\s+/g, ' ')}" in "${around(s.text, m.index, m[0].length)}"`); }
  }
  findings.push(...shapeFindings(s, ['<progress>', '<meter>', 'role=progressbar', '<svg>']));
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

function sentinelFindings(s: MainSnapshot, sentinels: Record<Stage, number[]>, sums: number[]): string[] {
  const findings: string[] = [];
  for (const [stage, values] of Object.entries(sentinels) as Array<[Stage, number[]]>) {
    for (const n of values) {
      if (!wholeNumber(n).test(s.text)) findings.push(`sentinel ${n} (${stage}) does not appear as a whole number in text`);
    }
  }
  for (const sum of sums) {
    const m = wholeNumber(sum).exec(s.text);
    if (m) findings.push(`the sum ${sum} of three stages' counts appears: "${around(s.text, m.index, String(sum).length)}"`);
  }
  return findings;
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
 * sentinels appears nowhere. Which column a count sits in is the screen owner's own test.
 */
export async function expectCountsAsWholeNumbersPerStage(page: Page, sentinels: Record<Stage, number[]>): Promise<void> {
  const sums = sentinelSums(sentinels);
  const s = await snapshotMain(page, `expectCountsAsWholeNumbersPerStage(${page.url()})`);
  const findings = [
    ...sentinelFindings(s, sentinels, sums),
    ...(s.text.includes('%') ? [`"%" appears in "${around(s.text, s.text.indexOf('%'), 1)}"`] : []),
    ...shapeFindings(s, ['<progress>', '<meter>', 'role=progressbar']),
    ...totalLabelFindings(s),
  ];
  fail(`expectCountsAsWholeNumbersPerStage(${page.url()})`, findings);
}

/**
 * UX-07: no screen shows a count summed across stages. The sentinel counts must be on the page (a page
 * that shows none of them says nothing about their sum), their sums must not be, and nothing is labelled
 * as a total.
 */
export async function expectNoCrossStageTotal(page: Page, sentinels: Record<Stage, number[]>): Promise<void> {
  const sums = sentinelSums(sentinels);
  const who = `expectNoCrossStageTotal(${page.url()})`;
  const s = await snapshotMain(page, who);
  fail(who, [...sentinelFindings(s, sentinels, sums), ...totalLabelFindings(s)]);
}

type LabelSnapshot = {
  body: string | null;
  muted: string | null;
  labels: Array<{ text: string; colour: string; warning: boolean }>;
  warnings: string[];
};

/**
 * UX-06 (SRS line 2296) and NFR-A11Y-05 (SC 1.4.1): every `.status-label` is words, not a colour or an
 * icon; its computed colour is `--text-body` or `--text-muted` as `:root` resolves them; and
 * `.status-label--warning` is on "Overdue", "Owner cannot act" and "No agreement recorded" only (a count
 * or punctuation beside the words is ignored). A warning-tinted label is exempt from the colour check.
 * The order of the to-do counts and the recorded counts in a stage column needs S-10's markup, which is
 * PRJ's: its own test asserts that.
 */
export async function expectNeutralStatusLabels(page: Page): Promise<void> {
  const who = `expectNeutralStatusLabels(${page.url()})`;
  const snap: LabelSnapshot | null = await page.evaluate(() => {
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
    const labels: LabelSnapshot['labels'] = [];
    const warnings: string[] = [];
    for (const main of mains) {
      for (const el of Array.from(main.querySelectorAll('.status-label'))) {
        labels.push({
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          colour: getComputedStyle(el).color,
          warning: el.classList.contains('status-label--warning'),
        });
      }
      for (const el of Array.from(main.querySelectorAll('.status-label--warning'))) {
        warnings.push((el.textContent ?? '').replace(/\s+/g, ' ').trim());
      }
    }
    return { body: tokenColour('--text-body'), muted: tokenColour('--text-muted'), labels, warnings };
  });
  if (!snap) throw new Error(`${who}: no <main> element, so there is nothing to check`);
  const findings: string[] = [];
  if (snap.body === null) findings.push('--text-body is not defined on :root, so no colour can be compared with it');
  if (snap.muted === null) findings.push('--text-muted is not defined on :root, so no colour can be compared with it');
  if (findings.length > 0) fail(who, findings);
  if (snap.labels.length === 0 && snap.warnings.length === 0) fail(who, ['no .status-label element in <main>']);

  for (const l of snap.labels) {
    if (!/\p{L}/u.test(l.text)) findings.push(`.status-label "${l.text}" has no words; a status must be text, not colour or a number alone (SC 1.4.1)`);
    if (!l.warning && l.colour !== snap.body && l.colour !== snap.muted) {
      findings.push(`.status-label "${l.text}": colour ${l.colour} is neither --text-body (${snap.body}) nor --text-muted (${snap.muted})`);
    }
  }
  for (const text of snap.warnings) {
    const words = text.toLowerCase().replace(/[\d\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!WARNING_LABELS.has(words)) {
      findings.push(`warning tint on "${text}"; allowed only on Overdue, Owner cannot act and No agreement recorded`);
    }
  }
  fail(who, findings);
}
