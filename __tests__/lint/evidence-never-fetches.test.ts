import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/** Every file under the given files and directories (a directory is walked), as relative paths. */
function filesUnder(paths: string[]): string[] {
  return paths.flatMap((p) => (statSync(p).isDirectory()
    ? filesUnder(readdirSync(p).map((n) => join(p, n)))
    : [p]));
}

/** `path:line` of each line of those files that matches, comment-only lines left out. */
function grepFiles(paths: string[], pattern: RegExp): string[] {
  return filesUnder(paths).flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((text, i) => {
    const t = text.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || !pattern.test(text) ? [] : [`${file}:${i + 1}`];
  }));
}

const SERVER = [
  'lib/data/evidence.ts', 'lib/evidence',
  'app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts', 'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts',
];

describe('the platform never fetches a link (FR-EVD-03)', () => {
  it('FR-EVD-03 NFR-SEC-10: no evidence module can fetch', () => {
    expect(grepFiles(SERVER, /\bfetch\(|XMLHttpRequest|from ['"](node:)?(http|https|net|undici)['"]|require\(['"](node:)?(http|https)['"]\)/)).toEqual([]);
    expect(grepFiles(['components/evidence'], /from ['"]next\/link['"]|\bfetch\(/)).toEqual([]);
    // The browser module posts only to the url its caller built with evidenceUploadUrl.
    // (?!\s) stops the engine backtracking into the spaces and so past the lookahead.
    expect(grepFiles(['lib/client/evidenceUpload.ts'], /\.open\(\s*['"]POST['"]\s*,\s*(?!\s)(?!a\.url\b)/)).toEqual([]);
  });
});
