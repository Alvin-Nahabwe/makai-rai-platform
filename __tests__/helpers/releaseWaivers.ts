import { readFileSync } from 'node:fs';

/**
 * The owner's waivers of release-check cases (the cases that run only with RELEASE_CANDIDATE=1).
 *
 * A waiver is the owner's decision to ship with a release check failing, recorded where the check reads it: the case
 * id, the owner's verbatim words, the date, the files the waiver covers, and the register row that tracks the debt.
 * Only the cases in WAIVABLE_CASES consult the file; every other release case is unchanged and cannot be waived here.
 * A case passes on a waiver only when its entry is complete, and the file is refused whole if it holds an entry for any
 * other case, an incomplete entry, or two entries for one case, so a stray or half-written waiver fails the check
 * rather than passing it.
 */

export const RELEASE_WAIVERS_FILE = 'docs/releases/release-waivers.json';

/** The release cases a waiver may cover: the owner's decisions of 6 Nov 2026 on A4 and UX-03. */
export const WAIVABLE_CASES = ['FR-ACC-02 legal-placeholder', 'UX-03 help-contact-pending'] as const;
export type WaivableCase = (typeof WAIVABLE_CASES)[number];

export type ReleaseWaiver = {
  case: WaivableCase;
  /** Repository paths the waiver covers: the check still fails for any other file. */
  covers: string[];
  /** The owner's words, verbatim. */
  owner_words: string;
  /** YYYY-MM-DD, the day the owner decided. */
  date: string;
  /** The register row (D-<n>) that tracks what was shipped unfinished. */
  register_row: string;
};

function isWaivable(c: unknown): c is WaivableCase {
  return typeof c === 'string' && (WAIVABLE_CASES as readonly string[]).includes(c);
}

function problemsOf(w: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!Array.isArray(w.covers) || w.covers.length === 0 || !w.covers.every((p) => typeof p === 'string' && p.length > 0)) problems.push('covers no file');
  if (typeof w.owner_words !== 'string' || w.owner_words.trim() === '') problems.push('has no owner words');
  if (typeof w.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.date)) problems.push('has no YYYY-MM-DD date');
  if (typeof w.register_row !== 'string' || !/^D-\d+$/.test(w.register_row)) problems.push('has no register row (D-<n>)');
  return problems;
}

/**
 * The complete waiver for `caseId`, or undefined when the file has no entry for it. Throws when the file is not the
 * shape, holds an entry for a case outside WAIVABLE_CASES, holds a case twice, or the entry asked for is incomplete.
 */
export function releaseWaiver(caseId: WaivableCase | string, file: string = RELEASE_WAIVERS_FILE): ReleaseWaiver | undefined {
  if (!isWaivable(caseId)) throw new Error(`${caseId} is not a waivable case (${RELEASE_WAIVERS_FILE})`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { waivers?: unknown };
  if (!Array.isArray(raw.waivers)) throw new Error(`${file}: release-waivers needs a "waivers" array`);
  const seen = new Set<string>();
  for (const w of raw.waivers as Array<Record<string, unknown>>) {
    if (!isWaivable(w?.case)) throw new Error(`${file}: release-waivers entry ${String(w?.case)} is not a waivable case`);
    if (seen.has(w.case)) throw new Error(`${file}: release-waivers names ${w.case} twice`);
    seen.add(w.case);
  }
  const entry = (raw.waivers as Array<Record<string, unknown>>).find((w) => w.case === caseId);
  if (!entry) return undefined;
  const problems = problemsOf(entry);
  if (problems.length > 0) throw new Error(`${file}: the release-waivers entry for ${caseId} ${problems.join(', ')}`);
  return entry as ReleaseWaiver;
}
