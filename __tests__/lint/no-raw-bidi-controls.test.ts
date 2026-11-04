import { readdirSync, readFileSync } from 'node:fs';
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.auth') return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(tsx?|mjs|json)$/.test(e.name) ? [p] : [];
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

  it('NFR-SEC-11 E14: no file under app, lib, components, __tests__ or e2e holds a raw U+202A to U+202E or U+2066 to U+2069', () => {
    const hits = ['app', 'lib', 'components', '__tests__', 'e2e'].flatMap((d) =>
      sourceFiles(d).flatMap((f) => rawBidiLines(f, readFileSync(f, 'utf8'))));
    expect(hits).toEqual([]);
  });
});
