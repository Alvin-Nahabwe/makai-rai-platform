import { posix } from 'node:path';
import ts from 'typescript';

/**
 * The one resolver of `verbatim` (lib/vocabulary/verbatim.ts), shared by the vocabulary lint, which skips the text of
 * an allowed call, and by the verbatim-reasons test, which lists every call and fails every way around it.
 * A binding counts only when it is imported from lib/vocabulary/verbatim (by `@/lib/vocabulary/verbatim` or by a
 * relative path that resolves to it): a named or aliased import, or a namespace import used as `ns.verbatim`.
 */

export const VERBATIM_KINDS = ['legal-text', 'giz-credit'] as const;
export const DECLARING_FILE = 'lib/vocabulary/verbatim.ts';

/** True when an import or export specifier written in `file` names lib/vocabulary/verbatim. */
export function isVerbatimModule(specifier: string, file: string): boolean {
  const spec = specifier.replace(/\.(?:ts|js)$/, '');
  if (spec === '@/lib/vocabulary/verbatim') return true;
  return spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(file), spec)) === 'lib/vocabulary/verbatim';
}

export type Bindings = { names: Set<string>; namespaces: Set<string> };

export function verbatimBindings(sf: ts.SourceFile, file: string): Bindings {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isVerbatimModule(st.moduleSpecifier.text, file)) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'verbatim') names.add(el.name.text);
  }
  return { names, namespaces };
}

/** The node is a reference to verbatim through one of the file's bindings. */
export function refersToVerbatim(n: ts.Node, b: Bindings): boolean {
  if (ts.isIdentifier(n)) {
    if (!b.names.has(n.text)) return false;
    const p = n.parent;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return false; // other.verbatim
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n) return false; // a key
    return true;
  }
  return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && b.namespaces.has(n.expression.text) && n.name.text === 'verbatim';
}

/** The kind of a call's first argument when it is the string literal of an allowed kind, otherwise null. */
export function allowedKind(call: ts.CallExpression): string | null {
  const a = call.arguments[0];
  return a && ts.isStringLiteral(a) && (VERBATIM_KINDS as readonly string[]).includes(a.text) ? a.text : null;
}

export const isAllowedVerbatimCall = (n: ts.Node, b: Bindings): n is ts.CallExpression =>
  ts.isCallExpression(n) && refersToVerbatim(n.expression, b) && allowedKind(n) !== null;

const DECLARES = (p: ts.Node) => ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) ||
  ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) ||
  ts.isImportEqualsDeclaration(p) || ts.isEnumDeclaration(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);

export type Report = { calls: string[]; failures: string[] };

/**
 * Every call of verbatim in one file (`file:line kind`), and every failure: a first argument that is not the literal
 * of an allowed kind; verbatim used as a value; any declaration, parameter or binding named `verbatim` outside the
 * declaring file (including an import of that name from another module); any re-export of verbatim or of its module
 * (named, renamed or `export *`); a dynamic import or require of the module.
 */
export function verbatimReport(file: string, source: string): Report {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const b = verbatimBindings(sf, file);
  const declaring = file === DECLARING_FILE;
  const report: Report = { calls: [], failures: [] };
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const fromModule = ts.isStringLiteral(n.moduleSpecifier) && isVerbatimModule(n.moduleSpecifier.text, file);
      const c = n.importClause;
      if (!fromModule && c) {
        const locals = [c.name, ...(c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.map((e) => e.name) : []),
          c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? c.namedBindings.name : undefined];
        for (const l of locals) if (l?.text === 'verbatim') report.failures.push(`${at(l)}: a binding named verbatim that is not imported from lib/vocabulary/verbatim`);
      }
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const fromModule = !!n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && isVerbatimModule(n.moduleSpecifier.text, file);
      if (fromModule) report.failures.push(`${at(n)}: re-export of lib/vocabulary/verbatim`);
      else if (n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const el of n.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          if (b.names.has(from) || (from === 'verbatim' && !declaring)) report.failures.push(`${at(el)}: verbatim re-exported as ${el.name.text}`);
        }
      }
      return;
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteralLike(a) && isVerbatimModule(a.text, file)) report.failures.push(`${at(n)}: dynamic import of lib/vocabulary/verbatim`);
    }
    if (ts.isIdentifier(n) && n.text === 'verbatim' && !declaring && DECLARES(n.parent) && (n.parent as ts.NamedDeclaration).name === n) {
      report.failures.push(`${at(n)}: a declaration named verbatim outside ${DECLARING_FILE}`);
    }
    if (refersToVerbatim(n, b)) {
      const call = n.parent;
      if (ts.isCallExpression(call) && call.expression === n) {
        const kind = allowedKind(call);
        const a = call.arguments[0];
        if (kind) report.calls.push(`${at(call)} ${kind}`);
        else report.failures.push(`${at(call)}: first argument is ${a ? a.getText(sf) : 'missing'}, not the literal 'legal-text' or 'giz-credit'`);
      } else {
        report.failures.push(`${at(n)}: verbatim used as a value, not called`);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return report;
}
