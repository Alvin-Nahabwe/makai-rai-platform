import { readFileSync } from 'node:fs';

/**
 * The owner's waivers of release-check cases (the cases that run only with RELEASE_CANDIDATE=1).
 *
 * A waiver is the owner's decision to ship with a release check failing, recorded where the check reads it: the case
 * id, the owner's verbatim words, the date, the files the waiver covers, and the register row that tracks the debt.
 * Only the cases in WAIVABLE_CASES consult the file; every other release case is unchanged and cannot be waived here.
 * A case passes on a waiver only when its entry is complete and was written for the release being checked (`release`
 * equals package.json's version), so a waiver of 0.6.0 stops waiving in 0.7.0 and its case fails again until the owner
 * decides again. The file is refused whole if it holds an entry for any other case, an incomplete entry (whichever case
 * or release it is for), or two entries for one case and release, so a stray or half-written waiver fails the check
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
  /** The release (package.json's version) the owner decided this for: an entry of another release waives nothing. */
  release: string;
};

/** The version of package.json: the release being checked. */
function packageVersion(): string {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
}

function isWaivable(c: unknown): c is WaivableCase {
  return typeof c === 'string' && (WAIVABLE_CASES as readonly string[]).includes(c);
}

function problemsOf(w: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!Array.isArray(w.covers) || w.covers.length === 0 || !w.covers.every((p) => typeof p === 'string' && p.length > 0)) problems.push('covers no file');
  if (typeof w.owner_words !== 'string' || w.owner_words.trim() === '') problems.push('has no owner words');
  if (typeof w.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.date)) problems.push('has no YYYY-MM-DD date');
  if (typeof w.register_row !== 'string' || !/^D-\d+$/.test(w.register_row)) problems.push('has no register row (D-<n>)');
  if (typeof w.release !== 'string' || !/^\d+\.\d+\.\d+$/.test(w.release)) problems.push('has no release (x.y.z)');
  return problems;
}

/**
 * The complete waiver for `caseId` written for `release` (package.json's version unless given), or undefined when the
 * file has no such entry. Throws when the file is not the shape, holds an entry for a case outside WAIVABLE_CASES, an
 * incomplete entry, or a case twice for one release.
 */
export function releaseWaiver(caseId: WaivableCase | string, file: string = RELEASE_WAIVERS_FILE, release: string = packageVersion()): ReleaseWaiver | undefined {
  if (!isWaivable(caseId)) throw new Error(`${caseId} is not a waivable case (${RELEASE_WAIVERS_FILE})`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { waivers?: unknown };
  if (!Array.isArray(raw.waivers)) throw new Error(`${file}: release-waivers needs a "waivers" array`);
  const seen = new Set<string>();
  for (const w of raw.waivers as Array<Record<string, unknown>>) {
    if (!isWaivable(w?.case)) throw new Error(`${file}: release-waivers entry ${String(w?.case)} is not a waivable case`);
    const problems = problemsOf(w);
    if (problems.length > 0) throw new Error(`${file}: the release-waivers entry for ${w.case} ${problems.join(', ')}`);
    const key = `${String(w.release)} ${w.case}`;
    if (seen.has(key)) throw new Error(`${file}: release-waivers names ${w.case} twice for release ${String(w.release)}`);
    seen.add(key);
  }
  return (raw.waivers as ReleaseWaiver[]).find((w) => w.case === caseId && w.release === release);
}
