/**
 * How the claims checks read the questions of a content bundle: one reader for PUB's lint
 * (`__tests__/lint/no-product-claims.test.ts`) and the rendered-page crawl (`e2e/claims-crawl.spec.ts`), so both
 * resolve an allow-list `{ id, reason }` entry (AL-7) against the same bundle the same way (coordinator ruling,
 * 5 Nov 2026, on the crawl's stage-page entries). Imports are relative, so Playwright loads it as it loads the pattern.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Question objects (an `id` starting `Q-`) with their JSON path, found at any depth, so a check does not depend on how a bundle nests its stages. */
export function questionsIn(value: unknown, at = '', out: Array<{ q: Record<string, unknown>; path: string }> = []): Array<{ q: Record<string, unknown>; path: string }> {
  if (Array.isArray(value)) value.forEach((v, i) => questionsIn(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('Q-')) out.push({ q: value as Record<string, unknown>, path: at });
    else for (const [k, v] of Object.entries(value)) questionsIn(v, at === '' ? k : `${at}.${k}`, out);
  }
  return out;
}

/** The running version named by `<contentRoot>/index.json`; throws when it cannot be read. */
export function runningVersion(contentRoot: string): string {
  const file = path.join(contentRoot, 'index.json');
  const index = JSON.parse(fs.readFileSync(file, 'utf8')) as { running?: unknown };
  if (typeof index.running !== 'string' || index.running === '') throw new Error(`${file} names no running version`);
  return index.running;
}

/** The whitespace clean-up the crawl's word reader applies to a text node. */
export const cleanText = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The question texts the allow-list's `{ id, reason }` entries name, cleaned, from every version `<contentRoot>/index.json`
 * lists: the owner-reviewed wordings of those questions, as the lint exempts the id in every version directory. The
 * running version must hold every id (an id that names no question there, or a question with no `text` string, throws:
 * an entry that resolves to nothing would exempt nothing without anyone noticing); an older version adds its wording
 * where it holds the id.
 */
export function allowListedQuestionTexts(entries: readonly unknown[], contentRoot: string): string[] {
  const bankOf = (version: string) => {
    const file = path.join(contentRoot, version, 'questionBank.json');
    return { file, byId: new Map(questionsIn(JSON.parse(fs.readFileSync(file, 'utf8'))).map(({ q }) => [q.id as string, q])) };
  };
  const ids = entries.flatMap((e) => {
    const id = (e as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
  const running = runningVersion(contentRoot);
  const { file: bankFile, byId } = bankOf(running);
  const out = new Set<string>();
  for (const id of ids) {
    const q = byId.get(id);
    if (q === undefined) throw new Error(`claim-allowlist.json: id ${id} names no question in ${bankFile}`);
    if (typeof q.text !== 'string') throw new Error(`claim-allowlist.json: question ${id} in ${bankFile} has no text`);
    out.add(cleanText(q.text));
  }
  const index = JSON.parse(fs.readFileSync(path.join(contentRoot, 'index.json'), 'utf8')) as { versions?: unknown };
  const versions = Array.isArray(index.versions) ? index.versions.filter((v): v is string => typeof v === 'string') : [];
  for (const version of versions) {
    if (version === running) continue;
    const { byId: older } = bankOf(version);
    for (const id of ids) {
      const text = older.get(id)?.text;
      if (typeof text === 'string') out.add(cleanText(text));
    }
  }
  return [...out];
}
