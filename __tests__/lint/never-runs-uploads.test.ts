import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { inspect } from '@/lib/evidence/inspect';

/**
 * FR-PUB-04: the platform never runs evaluations, models, notebooks or
 * uploaded files, and never computes metrics from a team's data. The About
 * page says so (S-28, `app/(public)/about/page.tsx`); this test keeps it true.
 *
 * Two properties, each checked from a different side:
 *   1. No module under `app` or `lib` can start a process, a script, a worker,
 *      a VM context or a notebook runner. Code only: a comment that names a
 *      notebook does not count, an import of `child_process` does.
 *   2. The only code that looks inside an uploaded file, `lib/evidence/inspect.ts`,
 *      reads at most the first 16 bytes and parses nothing.
 *
 * What this cannot prove: that a future route which streams a file to another
 * service is harmless. It proves the application itself has no way to run one.
 */

const RUNNERS =
  /from\s*['"](node:)?(child_process|vm|worker_threads)['"]|\b(require|import)\(\s*['"](node:)?(child_process|vm|worker_threads)['"]\s*\)|\bFunction\s*\(|\beval\s*\(|jupyter|nbconvert|papermill|pyodide|python-shell/;

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|mts|cjs)$/;

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : codeFiles(path);
    return CODE_FILE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * The code of a file with its comments left out. Each token keeps its own text; the
 * trivia before it (spaces, newlines, comments) becomes one space, or nothing when there
 * was none, so `new Function(` stays one piece and a comment never reaches the pattern.
 */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let out = '';
  const visit = (n: ts.Node): void => {
    // A doc comment is a node of its own in the tree; it is a comment, not code.
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (n.getChildCount(sf) === 0) {
      if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
      out += (n.getStart(sf) > n.getFullStart() ? ' ' : '') + n.getText(sf);
    } else {
      n.getChildren(sf).forEach(visit);
    }
  };
  visit(sf);
  return out;
}

/** `file` of every code file under `roots` whose code matches `re`. */
function grepTs(roots: string[], re: RegExp): string[] {
  return roots.flatMap((root) =>
    codeFiles(root)
      .filter((f) => re.test(codeOf(f)))
      .map((f) => relative(process.cwd(), f)),
  );
}

/** The magic byte strings in `lib/evidence/inspect.ts`, read from its source: the table is not exported. */
function signatureLengths(): number[] {
  const src = readFileSync('lib/evidence/inspect.ts', 'utf8');
  return [...src.matchAll(/Buffer\.from\('([0-9a-f]+)',\s*'hex'\)/g)].map((m) => m[1].length / 2);
}

describe('uploads are never executed or parsed', () => {
  it('FR-PUB-04: no module under app or lib can run a process, a script or a notebook', () => {
    // A scan that read nothing would pass: both roots must hold code, and the evidence module must be in it.
    for (const root of ['app', 'lib']) expect(codeFiles(root).length, `no code found under ${root}`).toBeGreaterThan(0);
    expect(codeFiles('lib')).toContain(join('lib', 'evidence', 'inspect.ts'));
    expect(grepTs(['app', 'lib'], RUNNERS)).toEqual([]);
  });

  it('FR-PUB-04: the scan flags a process import in code and ignores a comment that names a notebook', () => {
    // The sources below are text written to a temporary directory and scanned. Nothing here executes them.
    const dir = mkdtempSync(join(tmpdir(), 'never-runs-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'run.ts'), "import { exec } from 'node:child_process';\nexport const r = exec;\n");
      writeFileSync(join(dir, 'lib', 'req.js'), "const cp = require('child_process');\nmodule.exports = cp;\n");
      writeFileSync(join(dir, 'lib', 'dyn.ts'), "export const f = new Function('return 1');\nexport const e = eval('1');\n");
      writeFileSync(join(dir, 'lib', 'nb.ts'), "export const url = 'https://example.org/jupyter/lab';\n");
      writeFileSync(join(dir, 'lib', 'dynimport.ts'), "export const load = () => import('node:child_process');\n");
      writeFileSync(join(dir, 'lib', 'worker.js'), "const w = require('worker_threads');\nmodule.exports = w;\n");
      writeFileSync(join(dir, 'lib', 'fn.ts'), "export const g = Function('return 1');\n");
      writeFileSync(
        join(dir, 'lib', 'comment.ts'),
        [
          '// Never import child_process or run a jupyter notebook here.',
          '/* papermill, pyodide */',
          '/** Never run a jupyter notebook. Never call eval( or new Function( on a file. */',
          'export const ok = 1;',
          '/**',
          ' * @returns nothing; python-shell is not used.',
          ' */',
          'export function f(): void {}',
          '',
        ].join('\n'),
      );
      const flagged = grepTs([join(dir, 'lib')], RUNNERS).map((f) => f.split('/').pop());
      expect(flagged.sort()).toEqual(['dyn.ts', 'dynimport.ts', 'fn.ts', 'nb.ts', 'req.js', 'run.ts', 'worker.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-04: the evidence check reads at most the first 16 bytes and parses nothing', () => {
    const lengths = signatureLengths();
    const entries = (readFileSync('lib/evidence/inspect.ts', 'utf8').match(/\bmagic:(?!\s*Buffer;)/g) ?? []).length; // not the type annotation
    expect(lengths.length, 'a signature in lib/evidence/inspect.ts is not written as Buffer.from(hex, "hex")').toBe(entries);
    expect(lengths.length, 'no signature found in lib/evidence/inspect.ts').toBeGreaterThanOrEqual(4);
    for (const s of lengths) expect(s).toBeLessThanOrEqual(16);

    // Whatever follows byte 16 cannot change the answer: replace the tail with zeros and compare.
    const magics = [...readFileSync('lib/evidence/inspect.ts', 'utf8').matchAll(/Buffer\.from\('([0-9a-f]+)',\s*'hex'\)/g)].map(
      (m) => m[1],
    );
    for (const hex of magics) {
      const buf = Buffer.concat([Buffer.from(hex, 'hex'), randomBytes(4096)]);
      const headOnly = Buffer.concat([buf.subarray(0, 16), Buffer.alloc(buf.length - 16)]);
      expect(headOnly.length).toBe(buf.length);
      expect(inspect(buf)).toEqual(inspect(headOnly));
      expect(inspect(buf).ok, hex).toBe(true);
    }

    expect(readFileSync('lib/evidence/inspect.ts', 'utf8')).not.toMatch(/\.toString\(|JSON\.parse|import\(|require\(/);
  });
});
