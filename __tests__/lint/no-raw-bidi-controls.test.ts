import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * NFR-SEC-11, E14 (Trojan Source, CVE-2021-42574): a raw bidirectional control in source makes the code read
 * differently from how it runs. Written as `\uXXXX` escapes, a character class or a test string is checkable by eye.
 * This file builds its pattern from escapes, so it holds no raw control itself.
 */
const RAW_BIDI = /[\u202A-\u202E\u2066-\u2069]/;

/** `path:line` of every line of `text` that holds a raw control. */
export function rawBidiLines(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => (RAW_BIDI.test(line) ? [`${file}:${i + 1}`] : []));
}

/** Every regular file under `dir`, binaries (fonts, images, archives) and build output left out. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.auth') return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(woff2?|png|jpe?g|gif|ico|pdf|zip)$/i.test(e.name) ? [] : [p];
  });
}

describe('no raw bidirectional control characters in source', () => {
  it('NFR-SEC-11: the scanner finds a raw control in a fixture string and ignores the escaped form', () => {
    const raw = `const name = 'invoice${String.fromCharCode(0x202e)}fdp.exe.pdf';`;
    expect(rawBidiLines('fixture.ts', raw)).toEqual(['fixture.ts:1']);
    expect(rawBidiLines('fixture.ts', "const name = 'invoice\\u202Efdp.exe.pdf';")).toEqual([]);
    expect(rawBidiLines('fixture.ts', `x${String.fromCharCode(0x2066)}\nok`)).toEqual(['fixture.ts:1']);
    expect(rawBidiLines('fixture.ts', `a${String.fromCharCode(0x200f)}b`)).toEqual([]);   // marks outside the two ranges are not flagged
  });

  it('NFR-SEC-11: the tree scan reads every regular file, a .js and a .sh included, and skips only binaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'bidi-lint-'));
    mkdirSync(join(root, 'e2e'));
    const control = String.fromCharCode(0x202e);
    writeFileSync(join(root, 'e2e', 'b.js'), `const a = 'x${control}y';\n`);
    writeFileSync(join(root, 'e2e', 'c.sh'), `echo x${control}y\n`);
    writeFileSync(join(root, 'e2e', 'font.woff2'), `x${control}y`);
    const hits = sourceFiles(root).flatMap((f) => rawBidiLines(f.replace(root, ''), readFileSync(f, 'utf8')));
    expect(hits.sort()).toEqual(['/e2e/b.js:1', '/e2e/c.sh:1']);
  });

  it('NFR-SEC-11 E14: no file under app, lib, components, __tests__ or e2e holds a raw U+202A to U+202E or U+2066 to U+2069', () => {
    const hits = ['app', 'lib', 'components', '__tests__', 'e2e'].flatMap((d) =>
      sourceFiles(d).flatMap((f) => rawBidiLines(f, readFileSync(f, 'utf8'))));
    expect(hits).toEqual([]);
  });
});
