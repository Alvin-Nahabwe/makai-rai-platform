import fs from 'node:fs';
import path from 'node:path';

/**
 * The page-file functions of e2e/claims-crawl.spec.ts, moved here unchanged (plan 1A Task 9, fix round 1) so that
 * e2e/vocabulary-first-use.spec.ts starts from the same files and holds itself to the same coverage gate, and both
 * specs tell S-06's legal routes the same way.
 */

/** A page file: its route template (route groups removed, `/` for the root) and the group it sits in, if any. */
export type PageFile = { template: string; group: string | null };

/** Every page file under `app/`, from the files themselves (the source `e2e/csp.spec.ts` reads its routes from). */
export function pageFiles(): PageFile[] {
  const root = path.join(process.cwd(), 'app');
  const files: PageFile[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A parallel-route slot (`@name`) mirrors pages that already have an address; it is not one.
        if (entry.name.startsWith('@')) continue;
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        const group = segments.find((s) => /^\(.+\)$/.test(s)) ?? null;
        const route = segments.filter((s) => !/^\(.+\)$/.test(s));
        files.push({ template: `/${route.join('/')}`, group });
      }
    }
  };
  walk(root, []);
  return files.sort((a, b) => a.template.localeCompare(b.template));
}

/** The page files with no dynamic segment in a route group: the pages a crawl can be told to visit. */
export function staticPagesIn(group: string): string[] {
  return pageFiles().filter((f) => f.group === group && !f.template.includes('[')).map((f) => f.template);
}

/** A regular expression for the paths a route template covers: each `[segment]` stands for one path segment. */
export function templateRegExp(template: string): RegExp {
  const body = template.split('/').map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}$`);
}

/** True when some visited `pathname + search` is a path the template covers. */
export function reachedBy(template: string, visited: string[]): boolean {
  return visited.some((v) => templateRegExp(template).test(new URL(v, 'http://path.invalid').pathname));
}

/**
 * The page files of `group` that no visited path matches and that `notCrawled` does not name, plus the
 * `notCrawled` keys that are not page files or that a visited path matches (a stale or reached entry).
 */
export function unaccounted(group: string, visited: string[], notCrawled: Record<string, string>): string[] {
  const files = pageFiles();
  const templates = files.filter((f) => f.group === group).map((f) => f.template);
  const problems: string[] = [];
  for (const t of templates) {
    if (!reachedBy(t, visited) && !(t in notCrawled)) problems.push(`${t}: no crawl reached this page file and NOT_CRAWLED does not name it`);
  }
  for (const key of Object.keys(notCrawled)) {
    if (!files.some((f) => f.template === key)) problems.push(`${key}: NOT_CRAWLED names a page file that does not exist`);
    else if (templates.includes(key) && reachedBy(key, visited)) problems.push(`${key}: NOT_CRAWLED names a page a crawl reached; remove the entry`);
  }
  return problems;
}

/** The two route templates on which S-06 shows a legal text (app/(public)/legal/[kind] and [kind]/[version]). */
export const LEGAL_TEXT_ROUTES: readonly string[] = ['/legal/[kind]', '/legal/[kind]/[version]'];

/** True when `pathname` is a path one of S-06's two route templates covers; any other path, `''` included, is not. */
export function isLegalTextRoute(pathname: string): boolean {
  return LEGAL_TEXT_ROUTES.some((template) => templateRegExp(template).test(pathname));
}
