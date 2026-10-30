import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';
import { LEGAL_KINDS } from './kinds';

/**
 * The legal text registry (FR-ACC-02, SRS 6.7): one file per kind and version
 * under `data/legal/<kind>/<version>.md`, four header lines, a line `---`, then
 * the text.
 *
 *   kind: privacy
 *   version: 2
 *   published: 2026-12-01
 *   acceptance: offered
 *   ---
 *   <text>
 *
 * `sha256` is the SHA-256 of the whole file's bytes, header included, and an
 * acceptance counts only when its (version, textHash) equals one of these
 * (FR-ACC-04). So a published file is never edited: any byte changed, header
 * or text, voids every acceptance of that version. New wording, a corrected
 * date or a changed acceptance mode is a new version file (SRS A-1, "Later
 * wording is a new version").
 *
 * Anything malformed stops the load with an error naming the file: a broken
 * image must not serve a gate built on a text nobody can show.
 */

// The four kinds and their names live in ./kinds, which reads no file, so client components can
// import them; re-exported here so every server-side caller keeps one import.
export { LEGAL_KINDS, LEGAL_KIND_NAMES } from './kinds';

const VERSION_PATTERN = /^[0-9][0-9A-Za-z.]{0,15}$/;
const HEADER_KEYS = ['kind', 'version', 'published', 'acceptance'] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const HEADER_LINE = /^([a-z]+): (\S.*)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Numeric-aware (2 before 10, 1.9 before 1.10); "1", "01" and "1A", "1a" compare equal, and equal is refused. */
const versionOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function isHeaderKey(key: string): key is HeaderKey {
  return (HEADER_KEYS as readonly string[]).includes(key);
}

const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * The first control character of a file, written "U+XXXX", or null: a C0 control other than tab and line feed,
 * DEL, a C1 control, or a bidirectional control. A bidirectional control (U+202E, say) makes S-06 show the
 * words in an order other than the hashed bytes', so the words a person sees would not be the words accepted.
 */
function controlCharacterIn(content: string): string | null {
  for (const ch of content) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || BIDI_CONTROL.test(ch)) {
      return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

function isCalendarDate(value: string): boolean {
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function parseLegalFile(kind: LegalTextKind, fileName: string, bytes: Buffer): LegalTextVersion {
  const where = `legal text ${kind}/${fileName}`;
  const version = fileName.endsWith('.md') ? fileName.slice(0, -'.md'.length) : '';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${where}: the file name is not <version>.md with a version matching ${VERSION_PATTERN}`);
  }

  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`${where}: the file is not valid UTF-8`);
  if (content.startsWith('\uFEFF')) throw new Error(`${where}: the file starts with a byte order mark`);
  if (content.includes('\r')) throw new Error(`${where}: the file holds a carriage return; save it with LF line endings`);
  const control = controlCharacterIn(content);
  if (control !== null) throw new Error(`${where}: the file holds the control character ${control}`);

  const lines = content.split('\n');
  const separator = lines.indexOf('---');
  if (separator < 0) throw new Error(`${where}: no line holding only --- ends the header`);

  const header = new Map<HeaderKey, string>();
  for (const line of lines.slice(0, separator)) {
    const m = HEADER_LINE.exec(line);
    if (!m) throw new Error(`${where}: header line ${JSON.stringify(line)} is not "key: value"`);
    const [, key, value] = m;
    if (!isHeaderKey(key)) throw new Error(`${where}: unknown header key "${key}"`);
    if (header.has(key)) throw new Error(`${where}: header key "${key}" is given more than once`);
    header.set(key, value);
  }
  for (const key of HEADER_KEYS) {
    if (!header.has(key)) throw new Error(`${where}: the header has no "${key}" line`);
  }

  const headerKind = header.get('kind')!;
  if (headerKind !== kind) throw new Error(`${where}: header kind "${headerKind}" is not its directory's kind "${kind}"`);
  const headerVersion = header.get('version')!;
  if (headerVersion !== version) throw new Error(`${where}: header version "${headerVersion}" is not its file name's version "${version}"`);
  const publishedOn = header.get('published')!;
  if (!isCalendarDate(publishedOn)) throw new Error(`${where}: published "${publishedOn}" is not a YYYY-MM-DD calendar date`);
  const acceptance = header.get('acceptance')!;
  if (acceptance !== 'required' && acceptance !== 'offered') {
    throw new Error(`${where}: acceptance "${acceptance}" is neither "required" nor "offered"`);
  }

  const text = lines.slice(separator + 1).join('\n');
  if (text.trim() === '') throw new Error(`${where}: the text after --- is empty`);
  if (!/[\p{L}\p{N}]/u.test(text)) throw new Error(`${where}: the text after --- holds no letter or digit`);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({ kind, version, publishedOn, acceptance, sha256, text });
}

/**
 * Oldest first. Version order and publication order must agree, with no two
 * versions the order cannot tell apart and no two on one day, so "current" is
 * never a matter of which of two orders, or of two equal versions, is believed.
 * The publication date orders versions; it does not delay one: the newest file
 * in the image is current from the image's first request.
 */
function orderVersions(kind: LegalTextKind, versions: LegalTextVersion[]): readonly LegalTextVersion[] {
  const ordered = [...versions].sort((a, b) => versionOrder.compare(a.version, b.version));
  for (let i = 1; i < ordered.length; i += 1) {
    const [earlier, later] = [ordered[i - 1], ordered[i]];
    if (versionOrder.compare(earlier.version, later.version) === 0) {
      throw new Error(`legal text ${kind}: versions "${earlier.version}" and "${later.version}" are the same version`);
    }
    if (!(earlier.publishedOn < later.publishedOn)) {
      throw new Error(
        `legal text ${kind}: version ${later.version} is published ${later.publishedOn}, ` +
          `not after version ${earlier.version} (published ${earlier.publishedOn})`,
      );
    }
  }
  return Object.freeze(ordered);
}

interface RegistryReader {
  /** The entries of the registry root; throws when the root cannot be listed. */
  listRoot(): readonly Dirent[];
  /** The entries of one kind's directory. */
  listKind(kind: LegalTextKind): readonly Dirent[];
  readKindFile(kind: LegalTextKind, fileName: string): Buffer;
}

/**
 * Every entry of the root must be one of the four kind directories and every
 * entry of a kind directory a file, so a mistyped directory or a version file
 * left beside its kind is refused, not skipped. `everyKind` makes a missing
 * kind directory an error (production); otherwise that kind is absent (tests).
 */
function buildRegistry(reader: RegistryReader, everyKind: boolean): ReadonlyMap<LegalTextKind, readonly LegalTextVersion[]> {
  const present = new Set<string>();
  for (const entry of reader.listRoot()) {
    if (!(LEGAL_KINDS as readonly string[]).includes(entry.name)) {
      throw new Error(`legal text: "${entry.name}" is not one of the four kinds (${LEGAL_KINDS.join(', ')})`);
    }
    if (!entry.isDirectory()) throw new Error(`legal text: "${entry.name}" is not a directory`);
    present.add(entry.name);
  }

  const registry = new Map<LegalTextKind, readonly LegalTextVersion[]>();
  for (const kind of LEGAL_KINDS) {
    if (!present.has(kind)) {
      if (!everyKind) continue;
      throw new Error(
        `legal text: data/legal/${kind} is missing; the image must carry every Markdown file under data/legal ` +
          '(next.config.ts outputFileTracingIncludes)',
      );
    }
    const versions = reader
      .listKind(kind)
      .map((entry) => {
        if (!entry.isFile()) throw new Error(`legal text ${kind}/${entry.name}: is not a file`);
        return entry.name;
      })
      .sort()
      .map((fileName) => parseLegalFile(kind, fileName, reader.readKindFile(kind, fileName)));
    registry.set(kind, orderVersions(kind, versions));
  }
  return registry;
}

/**
 * For tests only: the registry under `root`, where a kind with no directory is
 * absent. Its computed paths carry `turbopackIgnore` so the build never traces
 * through them; the module's own registry below never calls it (contract
 * "Static read paths", finding SEC-01).
 */
export function loadLegalRegistry(root: string): ReadonlyMap<LegalTextKind, readonly LegalTextVersion[]> {
  return buildRegistry(
    {
      listRoot: () => readdirSync(/*turbopackIgnore: true*/ root, { withFileTypes: true }),
      listKind: (kind) => readdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ root, kind), { withFileTypes: true }),
      readKindFile: (kind, fileName) => readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ root, kind, fileName)),
    },
    false,
  );
}

/**
 * Read once, at module load: the image's files are fixed, so this is the
 * build-time hash of SRS 6.7. The paths are literal after `process.cwd()`, so
 * the standalone trace holds `data/legal` and nothing wider; `next.config.ts`
 * also includes every Markdown file under `data/legal` explicitly.
 */
const REGISTRY = buildRegistry(
  {
    listRoot: () => readdirSync(join(process.cwd(), 'data', 'legal'), { withFileTypes: true }),
    listKind: (kind) => readdirSync(join(process.cwd(), 'data', 'legal', kind), { withFileTypes: true }),
    readKindFile: (kind, fileName) => readFileSync(join(process.cwd(), 'data', 'legal', kind, fileName)),
  },
  true,
);

/** A kind's versions, oldest first. Throws for a string that is not a kind, or a kind with no file. */
function historyOf(kind: LegalTextKind): readonly LegalTextVersion[] {
  const history = REGISTRY.get(kind);
  if (history === undefined) throw new Error(`unknown legal text kind ${JSON.stringify(kind)}`);
  if (history.length === 0) throw new Error(`no legal text of kind ${kind}`);
  return history;
}

/**
 * The kind a request names (S-06's `[kind]` segment), compared by exact equality with `LEGAL_KINDS`, never
 * looked up as an object key; null for any other string, which S-06 answers with a 404.
 */
export function legalKindFrom(value: string): LegalTextKind | null {
  return LEGAL_KINDS.find((k) => k === value) ?? null;
}

/** The newest version of a kind. Throws when the kind has no file. */
export function currentLegalText(kind: LegalTextKind): LegalTextVersion {
  const history = historyOf(kind);
  return history[history.length - 1];
}

/** One version of a kind, or null when the kind or the version does not exist (S-06 answers 404). */
export function legalTextVersion(kind: LegalTextKind, version: string): LegalTextVersion | null {
  const history = REGISTRY.get(kind);
  if (history === undefined) return null;
  return history.find((t) => t.version === version) ?? null;
}

/** Every version of a kind, oldest first. Throws when the kind has no file. */
export function legalTextHistory(kind: LegalTextKind): LegalTextVersion[] {
  return [...historyOf(kind)];
}
