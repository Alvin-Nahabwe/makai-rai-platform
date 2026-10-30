import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * NFR-SEC-11 (unit H0). Team-written text is rendered as text, never as markup, and escaping carries the
 * weight because the nginx content security policy allows inline scripts. React escapes everything except
 * what is passed through `dangerouslySetInnerHTML`, so the one use in `app` and `components` is the fixed
 * theme script in `app/layout.tsx`, which holds no team text.
 */

/**
 * A use of the property: the JSX attribute (`dangerouslySetInnerHTML=`), an object key (`dangerouslySetInnerHTML:`)
 * or a quoted key. A comment that only names it (`dangerouslySetInnerHTML;`) is not a use.
 */
const USE = /dangerouslySetInnerHTML\s*[=:]|['"`]dangerouslySetInnerHTML['"`]/;

/** The tracked or not-yet-tracked source files under `dirs` that use the property. */
function occurrences(dirs: string[], needle: RegExp): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...dirs], { encoding: 'utf8' });
  const files = out.split('\n').filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && existsSync(f));
  // A scan over no files would pass for nothing.
  expect(files.length, 'source files under app and components').toBeGreaterThan(50);
  return files.filter((f) => needle.test(readFileSync(f, 'utf8'))).sort();
}

it('NFR-SEC-11: no dangerouslySetInnerHTML in app or components outside the theme script', () => {
  expect(occurrences(['app', 'components'], USE)).toEqual(['app/layout.tsx']);
});

it('NFR-SEC-11 (harness): the pattern recognises each spelling of a use and ignores a comment that names it', () => {
  for (const use of [
    '<div dangerouslySetInnerHTML={{ __html: x }} />',
    '<div dangerouslySetInnerHTML = {{ __html: x }} />',
    'createElement("div", { dangerouslySetInnerHTML: { __html: x } })',
    'const props = { "dangerouslySetInnerHTML": y }',
  ])
    expect(use, use).toMatch(USE);
  for (const mention of ["Never dangerouslySetInnerHTML; see this file's own tests", 'no dangerouslySetInnerHTML here'])
    expect(mention, mention).not.toMatch(USE);
});

it('NFR-SEC-11: the one use passes a fixed constant that holds no team text', () => {
  const src = readFileSync('app/layout.tsx', 'utf8');
  expect(src.match(/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html:\s*([^}]*?)\s*\}\}/)?.[1]).toBe('themeInitScript');
  const declaration = src.match(/const themeInitScript\s*=\s*`([^`]*)`;/);
  expect(declaration, 'themeInitScript is a template literal constant').not.toBeNull();
  expect(declaration![1], 'no interpolation in the constant').not.toContain('${');
  expect(src.match(/themeInitScript/g)).toHaveLength(2); // the declaration and the one use
});
