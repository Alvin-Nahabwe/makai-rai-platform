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

/** Where a file can sit and still be built into the application or served by it: these directories and the root. */
const SCANNED = /^(app|components|lib|types|data|public)\//;

/** The tracked or not-yet-tracked files whose name matches `ext`, under the scanned directories and in the root. */
function sourceFiles(ext: RegExp): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => ext.test(f) && (SCANNED.test(f) || !f.includes('/')))
    .filter((f) => existsSync(f));
}

/** A Google fonts host: where a stylesheet or a font file would be fetched from, however the page asks for it. */
const GOOGLE_FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

/** The files that can name a Google font host: stylesheets, modules and, under public/, the pages served as they are. */
const HOST_FILES = /\.(css|ts|tsx|mjs|html)$/;

it('NFR-PRIV-04: no file under app, components, lib, types, data, public or the root imports next/font/google', () => {
  const files = sourceFiles(/\.(ts|tsx)$/);
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

it('NFR-PRIV-04: no css, ts, tsx, mjs or html file under app, components, lib, types, data, public or the root names fonts.googleapis.com or fonts.gstatic.com', () => {
  const files = sourceFiles(HOST_FILES);
  // A scan over no files would pass for nothing.
  expect(files.length, 'files in the scan').toBeGreaterThan(50);
  expect(files.some((f) => f.endsWith('.css')), 'a stylesheet is in the scan').toBe(true);
  expect(files.filter((f) => GOOGLE_FONT_HOSTS.test(readFileSync(f, 'utf8')))).toEqual([]);
});

it('NFR-PRIV-04 (harness): the hosts are recognised in a CSS @import, a link tag and a URL string, and a local font URL is not', () => {
  for (const use of [
    "@import url('https://fonts.googleapis.com/css2?family=Inter&display=swap');",
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />',
    'const u = "https://fonts.gstatic.com/s/inter/v13/x.woff2";',
  ])
    expect(use, use).toMatch(GOOGLE_FONT_HOSTS);
  for (const other of ["src: url('/_next/static/media/a.woff2')", '<link rel="icon" href="/favicon.png" />'])
    expect(other, other).not.toMatch(GOOGLE_FONT_HOSTS);
});

it('NFR-PRIV-04: the scans cover types/, data/ and the pages under public/ that are served as they are', () => {
  // The build reaches types/ and data/ through the `@/*` alias, and public/templates/*.html is served unchanged: a
  // Google loader import or font link in any of them would otherwise pass every case above.
  expect(sourceFiles(/\.(ts|tsx)$/)).toEqual(expect.arrayContaining(['types/api.ts', 'data/constants.ts']));
  expect(sourceFiles(HOST_FILES)).toEqual(expect.arrayContaining(['types/api.ts', 'data/constants.ts', 'public/templates/C-01_alternatives-analysis.html']));
});
