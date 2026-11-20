import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The working report on screen never renders a PDF (design §5: the on-screen report must not load the renderer, so a workshop of
 * readers opening the page at once costs no PDF work; controller's ruling, conflict 3 (a); ruling: no direct or transitive render import).
 * So the report page, its view and lib/data/workingReport.ts import none of `@react-pdf`, anything under `lib/documents/render` or
 * `@/lib/data/workingReportPdf`, and neither does any module they reach.
 *
 * The three named files are read strictly, with `ts.preProcessFile`: every specifier it finds, dynamic `import()` and `import type`
 * included. From them the import graph is followed to a fixed point through every `@/` (and relative) specifier that resolves to a
 * project file, and each module reached is read for its RUNTIME imports only (a static, non-type import or re-export): a type-only
 * import is erased, and the dynamic `import('@/lib/documents/render')` of lib/data/documents.ts is how the issue path loads the
 * renderer lazily (`rendererFor`), which is exactly what keeps it off this page. Any module under lib/documents/render that the
 * walk reaches is itself a failure, even when it is reached through a chain.
 */
const PAGE = 'app/(authenticated)/orgs/[slug]/projects/[id]/report/page.tsx';
const VIEW = 'components/report/WorkingReportView.tsx';
const DATA = 'lib/data/workingReport.ts';

const BANNED = [/^@react-pdf(\/|$)/, /^@\/lib\/documents\/render(\/|$)/, /^@\/lib\/data\/workingReportPdf$/, /^\.\.?\/(?:.*\/)?render(\/|$)/, /^\.\/workingReportPdf$/];
const banned = (spec: string): boolean => BANNED.some((re) => re.test(spec));

const read = (file: string): string => readFileSync(file, 'utf8');
/** The project file a specifier names (`@/` from the root, `./` and `../` from the importing file), or null for a package or a non-code file. */
const resolveAt = (spec: string, from: string): string | null => {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec);
  else return null;
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(existsSync) ?? null;
};

/** Every specifier of a source, as the compiler's own pre-processor finds them (static, dynamic and type-only alike). */
const allSpecifiers = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);

/** The specifiers a module loads at run time when it is first imported: static imports and re-exports that are not type-only. */
function runtimeSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && clause.namedBindings !== undefined
        && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/** Every project module the files load at run time, transitively (the files themselves included), each with the module that first reached it. */
function runtimeClosure(files: readonly string[]): Map<string, string> {
  const reached = new Map<string, string>(files.map((f) => [f, f]));
  const queue = [...files];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const spec of runtimeSpecifiers(read(file))) {
      const next = resolveAt(spec, file);
      if (next === null || reached.has(next)) continue;
      reached.set(next, file);
      queue.push(next);
    }
  }
  return reached;
}

const RENDER_MODULE = /^lib\/documents\/render(\/|\.tsx?$)/;

/** What breaks the rule for these files, as lines naming the file and the specifier or module. */
function problems(files: readonly string[]): string[] {
  const out: string[] = [];
  // The named files, strictly: a type-only or lazy import of the renderer is a fault there too.
  for (const file of files) for (const spec of allSpecifiers(read(file))) if (banned(spec)) out.push(`${file} imports ${spec}`);
  // Everything they reach at run time, to any depth.
  for (const [file, via] of runtimeClosure(files)) {
    for (const spec of runtimeSpecifiers(read(file))) if (banned(spec) && !files.includes(file)) out.push(`${via} -> ${file} imports ${spec}`);
    if (RENDER_MODULE.test(file) || file === 'lib/data/workingReportPdf.ts') out.push(`${file} is reached (via ${via})`);
  }
  return out;
}

describe('the working report on screen never loads the PDF renderer (design §5)', () => {
  it('the report page, its view and lib/data/workingReport.ts import neither @react-pdf nor @/lib/documents/render nor @/lib/data/workingReportPdf', () => {
    for (const f of [PAGE, VIEW, DATA]) expect(existsSync(f), `${f} exists`).toBe(true);
    expect(problems([PAGE, VIEW, DATA])).toEqual([]);
  });

  it('the walk is transitive and real: it reaches modules many levels down, and the renderer is not among them', () => {
    const reached = [...runtimeClosure([PAGE, VIEW, DATA]).keys()];
    expect(reached.length, 'the closure is a real import graph, not the three files').toBeGreaterThan(30);
    expect(reached).toContain('lib/documents/workingReport.ts');
    expect(reached.filter((f) => RENDER_MODULE.test(f) || f === 'lib/data/workingReportPdf.ts')).toEqual([]);
    expect(reached, 'lib/data/documents.ts is reached, and its renderer imports are lazy').toContain('lib/data/documents.ts');
  });

  it('(self-test) the reader sees a banned static import, a dynamic one in a named file, and a banned import one level down in lib/data', () => {
    expect(allSpecifiers("import { renderToBuffer } from '@react-pdf/renderer';\nconst m = await import('@/lib/documents/render');").filter(banned))
      .toEqual(['@react-pdf/renderer', '@/lib/documents/render']);
    expect(allSpecifiers("import type { Renderer } from '@/lib/documents/render';").filter(banned)).toEqual(['@/lib/documents/render']);
    expect(runtimeSpecifiers("import { renderToBuffer } from '@react-pdf/renderer';").filter(banned)).toEqual(['@react-pdf/renderer']);
    expect(runtimeSpecifiers("export * from '@/lib/documents/render';").filter(banned)).toEqual(['@/lib/documents/render']);
  });

  it('(self-test) lib/data/documents.ts is clean at run time: its render import is type-only and its dynamic ones are lazy', () => {
    const source = read('lib/data/documents.ts');
    expect(allSpecifiers(source).filter(banned), 'the compiler sees the type import and both lazy ones (rendererFor, documentSummaries)').toHaveLength(3);
    expect(runtimeSpecifiers(source).filter(banned)).toEqual([]);
    expect(runtimeSpecifiers("import type { A } from '@/lib/documents/render';\nimport { type B } from '@/lib/documents/render';")).toEqual([]);
  });
});
