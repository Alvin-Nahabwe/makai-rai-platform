import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `verbatim(kind, text)` (lib/vocabulary/verbatim.ts) is the only way past the vocabulary lint
 * (__tests__/lint/vocabulary.test.ts). Its first argument must be the string LITERAL 'legal-text' or 'giz-credit':
 * the parameter's type alone does not bind it, since a variable, a cast or a template satisfies the type. Every call in
 * tracked .ts and .tsx files outside __tests__/ and e2e/ is found however verbatim was imported (named, aliased or
 * namespace import), and listed, so a reviewer sees each one. Passing verbatim around as a value, or re-exporting it
 * under another name, is a failure: either would hide calls from this test.
 */

const ROOT = join(__dirname, '../..');
const KINDS = ['legal-text', 'giz-credit'];
const MODULE = /(?:^@\/|\/)lib\/vocabulary\/verbatim$|^\.{1,2}\/(?:.*\/)?verbatim$/;

type Report = { calls: string[]; failures: string[] };

export function verbatimUses(file: string, source: string): Report {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const report: Report = { calls: [], failures: [] };
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const isDeclaringFile = /(?:^|\/)lib\/vocabulary\/verbatim\.ts$/.test(file);
  if (isDeclaringFile) names.add('verbatim');

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && MODULE.test(st.moduleSpecifier.text)) {
      const b = st.importClause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'verbatim') names.add(el.name.text);
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const from = (el.propertyName ?? el.name).text;
        if ((from === 'verbatim' || names.has(from)) && el.name.text !== 'verbatim') {
          report.failures.push(`${at(el)}: verbatim re-exported as ${el.name.text}`);
        }
      }
    }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    const viaNamespace = ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && namespaces.has(n.expression.text) && n.name.text === 'verbatim';
    const viaName = ts.isIdentifier(n) && names.has(n.text);
    if (viaName && isDeclaringFile && ts.isFunctionDeclaration(n.parent) && n.parent.name === n) return;
    if (viaName && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return; // x.verbatim on some other object
    if (viaName && (ts.isPropertyAssignment(n.parent) || ts.isPropertySignature(n.parent)) && n.parent.name === n) return; // a key
    if (viaNamespace || viaName) {
      const call = n.parent;
      if (ts.isCallExpression(call) && call.expression === n) {
        const a = call.arguments[0];
        const kind = a && ts.isStringLiteral(a) ? a.text : null;
        if (kind && KINDS.includes(kind)) report.calls.push(`${at(call)} ${kind}`);
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

describe('verbatim is called only with the two reasons', () => {
  it('every call in tracked source passes a literal legal-text or giz-credit; the calls are listed', () => {
    const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => f && !f.startsWith('__tests__/') && !f.startsWith('e2e/') && !f.endsWith('.d.ts'));
    expect(files.length).toBeGreaterThan(100);
    const all: Report = { calls: [], failures: [] };
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      if (!src.includes('verbatim')) continue;
      const r = verbatimUses(f, src);
      all.calls.push(...r.calls);
      all.failures.push(...r.failures);
    }
    console.log(`verbatim calls (${all.calls.length}):${all.calls.map((c) => `\n  ${c}`).join('')}`);
    expect(all.failures).toEqual([]);
  });

  describe('on fixtures', () => {
    const imp = "import { verbatim } from '@/lib/vocabulary/verbatim';\n";
    it('a literal legal-text or giz-credit is listed and passes', () => {
      expect(verbatimUses('a.ts', `${imp}verbatim('legal-text', 'x'); verbatim("giz-credit", 'y');`))
        .toEqual({ calls: ['a.ts:2 legal-text', 'a.ts:2 giz-credit'], failures: [] });
    });
    it('another literal, a variable, a cast or a template fails', () => {
      const src = `${imp}const k = 'legal-text' as const;\nverbatim('other' as never, 'x');\nverbatim(k, 'x');\nverbatim('legal-text' as 'legal-text', 'x');\nverbatim(\`legal-text\`, 'x');\nverbatim('other', 'x');`;
      expect(verbatimUses('a.ts', src).failures).toHaveLength(5);
    });
    it('an aliased import and a namespace import are resolved', () => {
      expect(verbatimUses('a.ts', "import { verbatim as v } from '@/lib/vocabulary/verbatim';\nv(k, 'x');").failures).toHaveLength(1);
      expect(verbatimUses('a.ts', "import * as V from '../vocabulary/verbatim';\nV.verbatim(k, 'x');\nV.verbatim('giz-credit', 'y');"))
        .toEqual({ calls: ['a.ts:3 giz-credit'], failures: [expect.stringContaining('a.ts:2: first argument is k')] });
    });
    it('a re-export under another name fails, and so does passing verbatim as a value', () => {
      expect(verbatimUses('a.ts', "export { verbatim as quote } from '@/lib/vocabulary/verbatim';").failures).toEqual(['a.ts:1: verbatim re-exported as quote']);
      expect(verbatimUses('a.ts', `${imp}const q = verbatim;`).failures).toEqual(['a.ts:2: verbatim used as a value, not called']);
    });
    it('the declaring file itself is not a call', () => {
      const src = readFileSync(join(ROOT, 'lib/vocabulary/verbatim.ts'), 'utf8');
      expect(verbatimUses('lib/vocabulary/verbatim.ts', src)).toEqual({ calls: [], failures: [] });
    });
  });
});
