import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';

/**
 * UX-37 and UX-40 (SRS 7.6.4 rules 4 and 9, lines 2708 and 2714): the six
 * long-list pages do not prefetch their links when they scroll into view, and
 * they show a page of the list at a time through `pageOf` and `ShowMoreLink`.
 *
 * This reads the source, with the TypeScript parser and not with regular
 * expressions, because a `<Link` tag can hold `>` inside an arrow function or a
 * template string and a regular expression would end the tag early. It looks at
 * each page and at every file the page imports from `components/` or from its own
 * directory tree, since a page usually hands its rows to a component.
 *
 * The pieces are K0b's (`ListLink`, `ShowMoreLink`, `pageOf` and the two
 * constants, contract row `components/ui/ListLink.tsx`); this file only names
 * them. Nothing here imports one, so UI waits for no one.
 *
 * Two of the six files exist at the base and do not yet use the pieces: S-32
 * (PRJ converts it) and S-22 (MEM converts it). They are listed in
 * `PENDING_CONVERSION` so the merge keeps release/0.6.0 green (contract rule 7).
 * The list shrinks and never grows: a file that already conforms must be taken
 * off it in the same commit (the case below fails otherwise), and a release
 * candidate run (RELEASE_CANDIDATE=1) fails while the list is not empty or any
 * of the six files is missing, the pattern of contract rule 6.
 *
 * The same reasoning covers the shell's own navigation (owner ruling on the sidebar
 * and the footer): every page view carries those links, and a background fetch for
 * each spends the data of a person on a slow, paid connection. They also point at
 * pages other units build, and in a production build a Link prefetch of an address
 * that answers 404 never settles (Next 16.4.2), which leaves `networkidle` in
 * e2e/csp.spec.ts waiting on every signed-in page. So the sidebar and the footer set
 * `prefetch={false}` on every `next/link` Link, permanently.
 */

const LONG_LISTS = [
  'app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page.tsx',
  'app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/history/page.tsx',
  'app/(authenticated)/orgs/[slug]/projects/[id]/findings/page.tsx',
  'app/(authenticated)/orgs/[slug]/settings/members/page.tsx',
  'app/(authenticated)/admin/accounts/page.tsx',
  'app/(authenticated)/orgs/[slug]/projects/page.tsx',
] as const;

/** The history page shows 20 versions; the others show 50 (UX-40). */
const HISTORY_PAGE = LONG_LISTS[1];

/**
 * Files that exist but have not been converted yet, by check and with the unit
 * that converts them. An entry is deleted in the commit that converts the file.
 */
const PENDING_CONVERSION: { prefetch: Record<string, string>; paging: Record<string, string> } = {
  prefetch: {
    'app/(authenticated)/orgs/[slug]/projects/page.tsx': 'PRJ',
  },
  paging: {
    'app/(authenticated)/orgs/[slug]/projects/page.tsx': 'PRJ',
    'app/(authenticated)/orgs/[slug]/settings/members/page.tsx': 'MEM',
  },
};

// ── reading source ──────────────────────────────────────────────────────

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Names bound to the default export of `next/link` in this file. */
function nextLinkNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === 'next/link') {
      if (stmt.importClause?.name) names.add(stmt.importClause.name.text);
    }
  }
  return names;
}

function jsxTags(sf: ts.SourceFile): Array<{ name: string; node: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> {
  const out: Array<{ name: string; node: ts.JsxOpeningElement | ts.JsxSelfClosingElement }> = [];
  walk(sf, (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) out.push({ name: n.tagName.getText(sf), node: n });
  });
  return out;
}

function hasPrefetchFalse(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return node.attributes.properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      p.name.getText() === 'prefetch' &&
      !!p.initializer &&
      ts.isJsxExpression(p.initializer) &&
      p.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword,
  );
}

/** Lines of every `next/link` Link in `text` that does not set `prefetch={false}`. */
export function prefetchingLinks(file: string, text: string): string[] {
  const sf = parse(file, text);
  const names = nextLinkNames(sf);
  return jsxTags(sf)
    .filter((t) => names.has(t.name) && !hasPrefetchFalse(t.node))
    .map((t) => `${file}:${sf.getLineAndCharacterOfPosition(t.node.getStart(sf)).line + 1}`);
}

/** How many `next/link` Links the file renders (how many tags the prefetch scan looked at). */
export function linkTagCount(file: string, text: string): number {
  const sf = parse(file, text);
  const names = nextLinkNames(sf);
  return jsxTags(sf).filter((t) => names.has(t.name)).length;
}

/** What a file does about paging: imports `pageOf` from lib/ui/showMore, renders ShowMoreLink, names a page-size constant. */
export function pagingUse(file: string, text: string): { pageOf: boolean; showMoreLink: boolean; constants: string[] } {
  const sf = parse(file, text);
  let pageOf = false;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!/(^|\/)lib\/ui\/showMore$/.test(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => (e.propertyName ?? e.name).text === 'pageOf')) pageOf = true;
  }
  const showMoreLink = jsxTags(sf).some((t) => t.name === 'ShowMoreLink');
  const constants = ['LIST_PAGE_SIZE', 'HISTORY_PAGE_SIZE'].filter((c) => new RegExp(`\\b${c}\\b`).test(text));
  return { pageOf, showMoreLink, constants };
}

/** Relative or `@/` imports that resolve to a file under app/ or components/. */
function localImports(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    let base: string | undefined;
    if (spec.startsWith('@/')) base = spec.slice(2);
    else if (spec.startsWith('.')) base = normalize(join(dirname(file), spec));
    if (!base || !/^(app|components)\//.test(base)) continue;
    for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/** The page and every file under app/ or components/ it imports, transitively. */
function closure(page: string): Array<{ file: string; text: string }> {
  const seen = new Map<string, string>();
  const queue = [page];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    queue.push(...localImports(file, text));
  }
  return [...seen].map(([file, text]) => ({ file, text }));
}

// ── the detector is checked on source it must flag and source it must pass ──

describe('long-list detectors (helper)', () => {
  const IMPORT = "import Link from 'next/link';\nimport ListLink from '@/components/ui/ListLink';\n";

  it('UX-37 (helper): a prefetching Link is reported, a prefetch={false} Link and a ListLink are not', () => {
    const src = `${IMPORT}export default function P() { return (<ul>
      <li><Link href="/a">a</Link></li>
      <li><Link href="/b" prefetch={false} className="x">b</Link></li>
      <li><Link href="/c" onClick={() => go(a > b)}>c</Link></li>
      <li><ListLink href="/d">d</ListLink></li></ul>); }`;
    const lines = prefetchingLinks('x.tsx', src);
    expect(lines).toEqual(['x.tsx:4', 'x.tsx:6']);
  });

  it('UX-37 (helper): prefetch={true} and a bare prefetch do not count as turning it off', () => {
    const src = `${IMPORT}export default function P() { return (<><Link href="/a" prefetch={true}>a</Link><Link href="/b" prefetch>b</Link></>); }`;
    expect(prefetchingLinks('x.tsx', src)).toHaveLength(2);
  });

  it('UX-37 (helper): a Link imported under another name is still found', () => {
    const src = "import NextLink from 'next/link';\nexport default function P() { return <NextLink href=\"/a\">a</NextLink>; }";
    expect(prefetchingLinks('x.tsx', src)).toEqual(['x.tsx:2']);
  });

  it('UX-40 (helper): paging is detected from the import, the element and the constant', () => {
    const paged = "import { pageOf, LIST_PAGE_SIZE } from '@/lib/ui/showMore';\nimport ShowMoreLink from '@/components/ui/ShowMoreLink';\nexport default function P() { const p = pageOf([], null, LIST_PAGE_SIZE); return <ShowMoreLink href=\"?shown=50\" label=\"Show more\" />; }";
    expect(pagingUse('x.tsx', paged)).toEqual({ pageOf: true, showMoreLink: true, constants: ['LIST_PAGE_SIZE'] });
    const unpaged = "export default function P() { return <p>all of them</p>; }";
    expect(pagingUse('x.tsx', unpaged)).toEqual({ pageOf: false, showMoreLink: false, constants: [] });
  });
});

// ── the six pages ───────────────────────────────────────────────────────

const present = LONG_LISTS.filter((f) => existsSync(f));

describe('long-list pages', () => {
  it('UX-37: the long-list pages and the components they import use no prefetching Link', () => {
    for (const page of present) {
      const found = closure(page).flatMap(({ file, text }) => prefetchingLinks(file, text));
      if (page in PENDING_CONVERSION.prefetch) {
        // Not converted yet: this is the entry that must be deleted when it is.
        expect(found.length, `${page} now conforms; delete it from PENDING_CONVERSION.prefetch (owner ${PENDING_CONVERSION.prefetch[page]})`).toBeGreaterThan(0);
      } else {
        expect(found, `${page} prefetches these links; use ListLink or prefetch={false}`).toEqual([]);
      }
    }
  });

  it('UX-40: the long-list pages page their lists with pageOf and ShowMoreLink', () => {
    for (const page of present) {
      const uses = closure(page).map(({ file, text }) => pagingUse(file, text));
      const pageOf = uses.some((u) => u.pageOf);
      const showMore = uses.some((u) => u.showMoreLink);
      const constants = new Set(uses.flatMap((u) => u.constants));
      const conforms = pageOf && showMore && constants.has(page === HISTORY_PAGE ? 'HISTORY_PAGE_SIZE' : 'LIST_PAGE_SIZE');
      if (page in PENDING_CONVERSION.paging) {
        expect(conforms, `${page} now conforms; delete it from PENDING_CONVERSION.paging (owner ${PENDING_CONVERSION.paging[page]})`).toBe(false);
      } else {
        expect(pageOf, `${page} does not import pageOf from lib/ui/showMore`).toBe(true);
        expect(showMore, `${page} does not render ShowMoreLink`).toBe(true);
        expect([...constants], `${page} passes the wrong page size`).toContain(page === HISTORY_PAGE ? 'HISTORY_PAGE_SIZE' : 'LIST_PAGE_SIZE');
        if (page !== HISTORY_PAGE) expect([...constants], `${page} must not use the history size`).not.toContain('HISTORY_PAGE_SIZE');
      }
    }
  });

  it('UX-37 UX-40: every pending conversion names a file that is one of the six', () => {
    for (const list of [PENDING_CONVERSION.prefetch, PENDING_CONVERSION.paging]) {
      for (const page of Object.keys(list)) expect(LONG_LISTS as readonly string[], page).toContain(page);
    }
  });

  // RELEASE_CANDIDATE=1 is set by V and RC. The integration branch does not run these.
  it.runIf(process.env.RELEASE_CANDIDATE === '1')('UX-37 UX-40: for the release candidate every one of the six files exists and none is pending', () => {
    expect(LONG_LISTS.filter((f) => !existsSync(f)), 'missing long-list pages').toEqual([]);
    expect(PENDING_CONVERSION, 'pending conversions').toEqual({ prefetch: {}, paging: {} });
  });
});

// ── the shell's navigation ──────────────────────────────────────────────

/** The two components that carry the shell's navigation links on every page. The footer is Task U1's and may not exist yet. */
const SHELL_NAV = ['components/layout/Sidebar.tsx', 'components/layout/Footer.tsx'] as const;

describe('shell navigation', () => {
  it('UX-37 (shell): the sidebar and footer links do not prefetch', () => {
    const files = SHELL_NAV.filter((f) => existsSync(f));
    expect(files, 'the sidebar must exist').toContain('components/layout/Sidebar.tsx');
    // Non-vacuity: the scan sees the sidebar's Link elements (the mapped item and My account), so a parse that found none cannot pass.
    expect(linkTagCount('components/layout/Sidebar.tsx', readFileSync('components/layout/Sidebar.tsx', 'utf8'))).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(prefetchingLinks(file, readFileSync(file, 'utf8')), `${file} prefetches these links; set prefetch={false}`).toEqual([]);
    }
  });

  it('UX-37 (helper): the shell scan flags a Link without prefetch={false} and counts the tags it read', () => {
    const src = "import Link from 'next/link';\nexport default function S() { return <nav><Link href=\"/a\">a</Link><Link href=\"/b\" prefetch={false}>b</Link></nav>; }";
    expect(prefetchingLinks('x.tsx', src)).toEqual(['x.tsx:2']);
    expect(linkTagCount('x.tsx', src)).toBe(2);
  });

  it.runIf(process.env.RELEASE_CANDIDATE === '1')('UX-37 (shell): for the release candidate the sidebar and the footer both exist', () => {
    expect(SHELL_NAV.filter((f) => !existsSync(f)), 'missing shell components').toEqual([]);
  });
});
