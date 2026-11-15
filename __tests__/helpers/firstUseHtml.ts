import { firstUseViolations, type TextNodeInfo } from '@/lib/vocabulary/firstUse';
import * as terms from '@/lib/vocabulary/terms';

/**
 * The first-use rule (lib/vocabulary/firstUse.ts) applied to markup a unit test rendered with renderToStaticMarkup, so a
 * component test can show its placement passes the rule the browser spec applies (e2e/vocabulary-first-use.spec.ts).
 * The markup is parsed into a small tree and read as the spec's collector reads `main`: text nodes in document order,
 * none inside `nav`, `script`, `style` or `[data-definition]`; each with the `data-term` ids above it; its block (the
 * closest `p, li, dt, dd, label, legend, th, td, h1-h6, .ui-field, .ui-callout`); and the definitions beside that block,
 * by the spec's relations: inside the block (nearest block ancestor), the element right after the block or its first
 * element child, a direct child of the block's closest field or callout, or an id named by `aria-describedby` on the
 * block, on an element inside it, or on a label's control. Not modelled: visibility (React markup has no layout; a
 * select's options are left out, as a closed select hides them, and the crawl lists none), and the text the browser
 * spec skips as team-typed (pass `skip`).
 */

type El = { tag: string; attrs: Record<string, string>; children: Node[]; parent: El | null };
type Text = { text: string; parent: El };
type Node = El | Text;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK_TAGS = new Set(['p', 'li', 'dt', 'dd', 'label', 'legend', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Never read: the spec's skipped tags, and a select's options, which a closed select does not show (checkVisibility). */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'option', 'optgroup']);

const decode = (s: string): string => s
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

function parse(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[1] !== undefined) { if (cur.parent !== null) cur = cur.parent; continue; }
    if (m[2] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '');
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [], parent: cur };
      cur.children.push(el);
      if (!VOID.has(el.tag) && m[4] !== '/') cur = el;
      continue;
    }
    if (m[5] !== undefined) cur.children.push({ text: decode(m[5]), parent: cur });
  }
  return root;
}

const isEl = (n: Node): n is El => 'tag' in n;
const classes = (el: El): string[] => (el.attrs.class ?? '').split(/\s+/);
const isBlock = (el: El): boolean => BLOCK_TAGS.has(el.tag) || classes(el).some((c) => c === 'ui-field' || c === 'ui-callout');
const closest = (el: El | null, test: (e: El) => boolean): El | null => {
  for (let e = el; e !== null; e = e.parent) if (test(e)) return e;
  return null;
};
const elements = (el: El): El[] => el.children.filter(isEl).flatMap((c) => [c, ...elements(c)]);
const nextElementSibling = (el: El): El | null => {
  const sibs = el.parent?.children.filter(isEl) ?? [];
  return sibs[sibs.indexOf(el) + 1] ?? null;
};

/** The text nodes of `html` as the browser spec's collector reads them (see the module comment). */
export function textNodesOf(html: string): TextNodeInfo[] {
  const root = parse(html);
  const all = elements(root);
  const byId = new Map(all.filter((e) => e.attrs.id !== undefined).map((e) => [e.attrs.id, e]));
  const near = (owner: El, directChild: boolean): El[] => [owner, ...elements(owner).filter((d) => d.attrs['data-definition'] !== undefined)]
    .filter((d) => d === owner || closest(d.parent, isBlock) === owner || (directChild && d.parent === owner));
  const describedBy = (block: El): Array<El | undefined> => {
    const owners = [block, ...elements(block).filter((e) => e.attrs['aria-describedby'] !== undefined)];
    if (block.tag === 'label' && block.attrs.for !== undefined) { const c = byId.get(block.attrs.for); if (c) owners.push(c); }
    return owners.flatMap((e) => (e.attrs['aria-describedby'] ?? '').split(/\s+/).filter(Boolean)).map((id) => byId.get(id));
  };
  const out: TextNodeInfo[] = [];
  const walk = (n: Node): void => {
    if (isEl(n)) {
      if (n.tag === 'nav' || SKIPPED.has(n.tag) || n.attrs['data-definition'] !== undefined) return;
      n.children.forEach(walk);
      return;
    }
    const text = n.text.replace(/\s+/g, ' ').trim();
    if (text === '') return;
    const termIds: string[] = [];
    for (let e: El | null = n.parent; e !== null; e = e.parent) if (e.attrs['data-term']) termIds.push(e.attrs['data-term']);
    const block = closest(n.parent, isBlock);
    const ids = new Set<string>();
    if (block !== null) {
      const next = nextElementSibling(block);
      const field = closest(block, (e) => classes(e).some((c) => c === 'ui-field' || c === 'ui-callout'));
      const candidates = [...near(block, false), next, next?.children.find(isEl), ...(field ? near(field, true) : []), ...describedBy(block)];
      for (const d of candidates) if (d && d.attrs['data-definition']) ids.add(d.attrs['data-definition']);
    }
    out.push({ text, termIds, blockKey: '', definitionIdsInBlock: [...ids], inRoleChoice: closest(n.parent, (e) => e.attrs['data-role-choice'] !== undefined) !== null, inDecisionVersion: closest(n.parent, (e) => e.attrs['data-decision-version'] !== undefined) !== null });
  };
  walk(root);
  return out;
}

/** The first-use violations of rendered markup: every checked term whose first use is not marked or has no definition beside it. */
export function firstUseProblems(html: string, skip: readonly string[] = []): Array<{ id: string; text: string }> {
  return firstUseViolations(textNodesOf(html), Object.values(terms), new Set(skip));
}
