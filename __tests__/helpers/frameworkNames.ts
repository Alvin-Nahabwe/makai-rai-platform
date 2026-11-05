/**
 * The framework's own area and control names, exempt from the claims pattern where they appear verbatim in a text
 * (coordinator ruling, 5 Nov 2026, on the owner's sitting 2 answer T4 "allow"). A name such as "Model Robustness
 * Failure" is framework source text, unchanged under ruling 2, so a "why this is asked" may end by naming it
 * (SRS 7.5.5). Only the exact name is exempt: a match of the pattern that is not wholly inside one occurrence of a
 * name is still a claim, so any other "failure" in the same text is still caught.
 *
 * Used by the content tests (`__tests__/content/qc-5.0.0.test.ts`), PUB's claims lint
 * (`__tests__/lint/no-product-claims.test.ts`) and PUB's rendered-page crawl (`e2e/claims-crawl.spec.ts`).
 */
import { readFileSync } from 'node:fs';

// Relative, not '@/', so the Playwright crawl (e2e/claims-crawl.spec.ts) can import this file as it imports the pattern.
import { claimMatches } from '../../lib/claims/pattern';

/** The 5.0.0 framework file the names are read from when no other is given. */
export const FRAMEWORK_FILE = 'data/content/5.0.0/assessmentAreas.json';

/** Every non-empty `name` of the file's `areas` and `controls`, in file order. Anything else in the file is ignored. */
export function frameworkNames(areasFile: unknown): string[] {
  const f = (areasFile ?? {}) as { areas?: unknown; controls?: unknown };
  const items = [...(Array.isArray(f.areas) ? f.areas : []), ...(Array.isArray(f.controls) ? f.controls : [])] as Array<{ name?: unknown }>;
  return items.flatMap((x) => (x !== null && typeof x === 'object' && typeof x.name === 'string' && x.name.trim() !== '' ? [x.name] : []));
}

/** The names of `path`, read now (at test time). */
export function readFrameworkNames(path: string = FRAMEWORK_FILE): string[] {
  return frameworkNames(JSON.parse(readFileSync(path, 'utf8')));
}

const WORD = /[\p{L}\p{N}_]/u;

/** The [start, end) spans of every exact, case-sensitive occurrence of a name that is not part of a longer word. */
function nameSpans(text: string, names: readonly string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const n of names) {
    for (let at = text.indexOf(n); at !== -1; at = text.indexOf(n, at + 1)) {
      const end = at + n.length;
      if ((at > 0 && WORD.test(text[at - 1])) || (end < text.length && WORD.test(text[end]))) continue;
      spans.push([at, end]);
    }
  }
  return spans;
}

/** The claim matches of `text` (`claimMatches`) minus those lying wholly inside an occurrence of a framework name. */
export function claimsOutsideNames(text: string, names: readonly string[]): Array<{ text: string; index: number }> {
  const spans = nameSpans(text, names);
  return claimMatches(text).filter((m) => !spans.some(([s, e]) => m.index >= s && m.index + m.text.length <= e));
}

/** True when `text` holds a claim once the framework names in it are set aside. */
export function isClaimOutsideNames(text: string, names: readonly string[]): boolean {
  return claimsOutsideNames(text, names).length > 0;
}
