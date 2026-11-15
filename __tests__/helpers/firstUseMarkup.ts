import * as terms from '@/lib/vocabulary/terms';
import { firstUseViolations, type TextNodeInfo } from '@/lib/vocabulary/firstUse';

/**
 * The first-use rule (lib/vocabulary/firstUse.ts) over server-rendered markup, for component tests that have no browser. It builds
 * a tree from `renderToStaticMarkup` output and collects text nodes the way e2e/vocabulary-first-use.spec.ts does: the whole markup
 * stands for `main`; a node under `hidden` or inside `[data-definition]` is not read; a node's block is its closest
 * `p, li, dt, dd, label, legend, th, td, h1-h6, .ui-field, .ui-callout`; a definition counts when it is in the block (its nearest
 * block ancestor is the block), the element right after the block or that element's first element child, a direct child of the
 * block's closest field or callout, or named by `aria-describedby` on the block, a control inside it, or a label's control.
 * Approximations, stated: visibility is the `hidden` attribute only (no CSS), and `<option>` text is read like any other.
 */

type El = { tag: string; attrs: Record<string, string>; children: Node[]; parent: El | null };
type Text = { text: string; parent: El };
type Node = El | Text;
const isEl = (n: Node): n is El => 'tag' in n;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK_TAGS = new Set(['p', 'li', 'dt', 'dd', 'label', 'legend', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const decode = (s: string): string => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

function parse(html: string): El {
  const root: El = { tag: 'main', attrs: {}, children: [], parent: null };
  let at = root;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g)) {
    if (m[1] !== undefined) { if (at.parent !== null) at = at.parent; continue; }
    if (m[2] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '');
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [], parent: at };
      at.children.push(el);
      if (!VOID.has(el.tag) && !m[0].endsWith('/>')) at = el;
      continue;
    }
    if (m[4] !== undefined) at.children.push({ text: decode(m[4]), parent: at });
  }
  return root;
}

const isBlock = (e: El): boolean => BLOCK_TAGS.has(e.tag) || /(^|\s)ui-(field|callout)(\s|$)/.test(e.attrs.class ?? '');
const isFieldOrCallout = (e: El): boolean => /(^|\s)ui-(field|callout)(\s|$)/.test(e.attrs.class ?? '');
function closest(e: El | null, test: (x: El) => boolean): El | null {
  for (let x = e; x !== null; x = x.parent) if (test(x)) return x;
  return null;
}
function all(e: El, out: El[] = []): El[] {
  for (const c of e.children) if (isEl(c)) { out.push(c); all(c, out); }
  return out;
}
const elementChildren = (e: El): El[] => e.children.filter(isEl);
function nextElement(e: El): El | null {
  if (e.parent === null) return null;
  const sibs = elementChildren(e.parent);
  return sibs[sibs.indexOf(e) + 1] ?? null;
}
const shownDefinition = (e: El | null | undefined): e is El => e != null && 'data-definition' in e.attrs && closest(e, (x) => 'hidden' in x.attrs) === null;

/** The text nodes of `html` as the browser crawl would collect them. */
export function collectTextNodes(html: string): TextNodeInfo[] {
  const root = parse(html);
  const everyEl = all(root);
  const byId = new Map(everyEl.filter((e) => e.attrs.id !== undefined).map((e) => [e.attrs.id, e]));
  const near = (owner: El, directChild: boolean): El[] => [owner, ...all(owner).filter((d) => 'data-definition' in d.attrs)]
    .filter((d) => d === owner || closest(d.parent, isBlock) === owner || (directChild && d.parent === owner));
  const describedBy = (block: El): Array<El | undefined> => {
    const owners = [block, ...all(block).filter((e) => e.attrs['aria-describedby'] !== undefined)];
    if (block.tag === 'label' && block.attrs.for !== undefined) { const c = byId.get(block.attrs.for); if (c) owners.push(c); }
    return owners.flatMap((e) => (e.attrs['aria-describedby'] ?? '').split(/\s+/).filter(Boolean)).map((id) => byId.get(id));
  };
  const blockKeys = new Map<El, string>();
  const nodes: TextNodeInfo[] = [];
  const walk = (e: El): void => {
    for (const c of e.children) {
      if (isEl(c)) { walk(c); continue; }
      const parent = c.parent;
      if (closest(parent, (x) => 'hidden' in x.attrs || 'data-definition' in x.attrs || x.tag === 'nav') !== null) continue;
      const text = c.text.replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      const termIds: string[] = [];
      for (let x: El | null = parent; x !== null; x = x.parent) if (x.attrs['data-term']) termIds.push(x.attrs['data-term']);
      const block = closest(parent, isBlock);
      let blockKey = `none-${nodes.length}`;
      const ids = new Set<string>();
      if (block !== null) {
        if (!blockKeys.has(block)) blockKeys.set(block, `block-${blockKeys.size}`);
        blockKey = blockKeys.get(block) as string;
        const next = nextElement(block);
        const field = closest(block, isFieldOrCallout);
        const candidates = [...near(block, false), next, next === null ? null : elementChildren(next)[0], ...(field ? near(field, true) : []), ...describedBy(block)];
        for (const d of candidates) if (shownDefinition(d)) ids.add(d.attrs['data-definition']);
      }
      nodes.push({
        text, termIds, blockKey, definitionIdsInBlock: [...ids],
        inRoleChoice: closest(parent, (x) => 'data-role-choice' in x.attrs) !== null,
        inDecisionVersion: closest(parent, (x) => 'data-decision-version' in x.attrs) !== null,
      });
    }
  };
  walk(root);
  return nodes;
}

/** The first uses in `html` that break the rule, over every concept of the vocabulary (as the crawl checks them). */
export function firstUseProblems(html: string): Array<{ id: string; text: string }> {
  return firstUseViolations(collectTextNodes(html), Object.values(terms));
}
