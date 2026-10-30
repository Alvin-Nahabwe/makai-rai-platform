import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * NFR-PRIV-04 (unit FONTS). No page of the application requests anything from a third party, and no build
 * fetches from one: `next/font/google` downloads the font files from Google when the application is built,
 * and a build that cannot reach Google, or that Google's stylesheet breaks (Turbopack 16.4.2 fails on a font
 * URL that holds an `&`), fails the whole build. The two typefaces are committed under `app/fonts/` and loaded
 * with `next/font/local`, so no source file may import the Google loader.
 */

/** An import of the Google loader: static `from`, a bare `import 'x'`, dynamic `import('x')` or `require('x')`. */
const GOOGLE_LOADER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`]next\/font\/google(?:\/[^'"`]*)?['"`]/;

/** The tracked or not-yet-tracked source files the scan covers: `app/`, `components/`, `lib/` and the root `.ts` and `.tsx` files. */
function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && (/^(app|components|lib)\//.test(f) || !f.includes('/')))
    .filter((f) => existsSync(f));
}

it('NFR-PRIV-04: no file under app, components, lib or the root imports next/font/google', () => {
  const files = scannedFiles();
  // A scan over no files would pass for nothing.
  expect(files.length, 'source files in the scan').toBeGreaterThan(50);
  expect(files).toContain('app/layout.tsx');
  expect(files.filter((f) => GOOGLE_LOADER.test(readFileSync(f, 'utf8')))).toEqual([]);
});

it('NFR-PRIV-04 (harness): the pattern recognises each spelling of an import and ignores a comment that names the module', () => {
  for (const use of [
    "import { Inter } from 'next/font/google';",
    'import { Inter } from "next/font/google"',
    "import {\n  Inter,\n} from\n  'next/font/google'",
    "import 'next/font/google';",
    "const m = await import('next/font/google');",
    "const m = require('next/font/google');",
    "import { Inter } from 'next/font/google/target.css';",
  ])
    expect(use, use).toMatch(GOOGLE_LOADER);
  for (const other of [
    "import localFont from 'next/font/local';",
    '// next/font/google is not used: the files are committed under app/fonts',
    '* The Google loader (`next/font/google`) is gone.',
  ])
    expect(other, other).not.toMatch(GOOGLE_LOADER);
});
