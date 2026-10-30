import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * FR-PUB-01: the platform makes no claim of compliance, audit readiness,
 * certification, approval, accreditation or alignment with a standard about
 * itself or its outputs, and shows no score. This is the phrase test over
 * source; `e2e/claims-crawl.spec.ts` is the same pattern over rendered pages.
 *
 * `CLAIMS` is the SRS pattern (FR-PUB-01, SRS line 1103) widened to the whole of
 * SRS 7.5.3's list of words that never appear (line 2472), with their forms. The
 * SRS pattern as written misses one of the strings its own *Why* cites ("scored
 * against responsible AI principles. At the end, you get a readiness report";
 * owner question B26), and the list holds many more words than it. A word that
 * the SRS bans only in one sense ("approved" as something the platform gives,
 * "level" as a grade, "progress" or "complete" about a stage or project) is
 * matched in the forms that carry that sense; "complete the form" is not banned.
 *
 * What is let through, and nothing else:
 *   - an element carrying `data-claims-allowed` in JSX (the About page's
 *     sentences that explain why there is no score, and the exact allow-listed
 *     sentences of SRS 7.5.3);
 *   - a content item whose id is in `claim-allowlist.json`, each with its
 *     reason: question texts that ask a team about its own practice.
 *
 * Related tests (`no-score-code.test.ts` from RM, and the document tests of
 * DOC-a and DOC-b) extend this pattern to other surfaces; the pattern lives
 * here so a change to it is one visible edit.
 */
const CLAIMS_CORE =
  /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|\bscored\b|\breadiness report\b|cannot see your records/i;

/** SRS 7.5.3's list of words that never appear, in the forms that carry the banned sense, on top of `CLAIMS_CORE`. */
const NEVER_WORDS = [
  String.raw`\baudit(s|ing|or|ors)?\b`,
  String.raw`\balign(s|ing|ment)? (to|with)\b`,
  String.raw`\bcertif(ies|ications|icate|icates)\b`,
  String.raw`\bapprov(ed|al|e|es|ing)\b`,
  String.raw`\bconform(s|ed|ing|ity|ance)?\b`,
  String.raw`\bscoring\b`,
  String.raw`\brat(ing|ings|ed)\b`,
  String.raw`\bgrad(e|es|ed|ing)\b`,
  String.raw`\brank(s|ed|ing|ings)?\b`,
  String.raw`\bmaturity\b`,
  String.raw`\breadiness\b`,
  String.raw`\blevels? [1-5]\b`,
  String.raw`\brisk levels?\b`,
  String.raw`\b(?:low|medium|moderate|high|critical)[- ]risk (?:results?|levels?|ratings?|outcomes?|labels?|bands?)\b`,
  String.raw`\bbands?\b`,
  String.raw`\bpass(es|ed|ing)?\b`,
  String.raw`\bfail(s|ed|ing)?\b`,
  String.raw`\bpercentages?\b`,
  String.raw`\d\s?%`,
  String.raw`\bprogress\b`,
  String.raw`\b(stage|project|review|assessment)s? (is |are |was |were |not )?(now )?complete(d)?\b`,
  String.raw`\bmark(ed)? as complete(d)?\b`,
  String.raw`\bcomplet(ion|eness)\b`,
  String.raw`\bseverity\b`,
  String.raw`\bgate [ab]\b`,
  String.raw`\bfacilitator`,
  String.raw`\bworkshops?\b`,
  String.raw`\bai-powered\b`,
];

/**
 * What no word of the interface, a document or an email may match. The README, a developer's document that
 * records the project's own history, is held to `CLAIMS_CORE` only.
 */
const CLAIMS = new RegExp(`${CLAIMS_CORE.source}|${NEVER_WORDS.join('|')}`, 'i');

type Hit = { where: string; text: string };

/** Every line of `text` that matches, with its position. */
function matchIn(where: string, text: string, pattern: RegExp = CLAIMS): Hit[] {
  return text
    .split('\n')
    .map((line, i) => ({ where: `${where}:${i + 1}`, text: line.trim() }))
    .filter((h) => pattern.test(h.text));
}

// --- Strings a person can read in app and components -----------------------

type UserString = { where: string; text: string; insideClaimsAllowed: boolean };

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** True when the node sits inside a JSX element that carries `data-claims-allowed`. */
function insideClaimsAllowed(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
    if (
      opening?.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText() === 'data-claims-allowed',
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Strings that are code, not words on a page: module specifiers, types, and
 * the names of properties. A JSX attribute value is kept (an `aria-label` or a
 * `title` is read aloud), except the attributes that only name a style, a
 * route or an element.
 */
const NON_TEXT_ATTRIBUTES = new Set([
  'className', 'id', 'key', 'href', 'src', 'htmlFor', 'type', 'rel', 'target', 'role', 'name',
  'style', 'data-claims-allowed', 'data-testid', 'aria-labelledby', 'aria-describedby', 'aria-controls',
]);

/** A BEM class token with a modifier (`badge--in-progress`): a name for the stylesheet, not a word. */
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:(?:--|__)[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
/** A CSS value written as a string (`minmax(min(100%, 24rem), 1fr)`). */
const CSS_VALUE = /\b(?:minmax|repeat|calc|clamp|rgba?|hsla?|var|min|max)\(/;

function isCodeString(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  // A message to the console is for a developer, not a reader.
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression) && p.expression.getText().startsWith('console.')) return true;
  const own = (node as ts.StringLiteral).text;
  if (typeof own === 'string' && (CLASS_TOKEN.test(own) || CSS_VALUE.test(own))) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const callee = p.expression.getText();
    if (callee === 'require' || p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  }
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isJsxAttribute(p)) return NON_TEXT_ATTRIBUTES.has(p.name.getText());
  return false;
}

/**
 * Every StringLiteral, NoSubstitutionTemplateLiteral, template head, middle and
 * tail, and JsxText under `roots`, through the TypeScript compiler API.
 * Comments and identifiers are not in the syntax tree's string nodes, so they
 * are never scanned.
 */
function userFacingStrings(roots: string[]): UserString[] {
  const out: UserString[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        const isString =
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node);
        const isJsxText = ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces;
        if ((isString && !isCodeString(node)) || isJsxText) {
          const text = isJsxText ? node.getText() : (node as ts.StringLiteral).text;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          out.push({
            where: `${relative(process.cwd(), file)}:${line + 1}`,
            text: text.replace(/\s+/g, ' ').trim(),
            insideClaimsAllowed: insideClaimsAllowed(node),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out;
}

/**
 * Every `data-claims-allowed` attribute under `roots`, with its file and reason. The
 * reason is '' when the attribute has no string value, which the test below refuses:
 * an exemption has to say what it exempts.
 */
function claimsAllowedMarkers(roots: string[]): Array<{ file: string; reason: string }> {
  const out: Array<{ file: string; reason: string }> = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (n: ts.Node): void => {
        if (ts.isJsxAttribute(n) && n.name.getText() === 'data-claims-allowed') {
          const init = n.initializer;
          out.push({ file: relative(process.cwd(), file), reason: init && ts.isStringLiteral(init) ? init.text.trim() : '' });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return out;
}

// --- Content texts, per version directory ----------------------------------

/** Skips every string under the question, area or control with this id. */
type IdEntry = { id: string; reason: string };
/**
 * Skips one string: `path` is `<file>#<JSON path within the file>` (for example
 * `assessmentAreas.json#areas[10].references[0].citation`), and `text` is the exact string found there. For a
 * string that is a verbatim title of a cited work and cannot be reworded. The entry exempts nothing else, and it
 * is refused as stale when the path or the text no longer matches, or when the text is no longer a claim.
 */
type PathEntry = { path: string; text: string; reason: string };
type AllowEntry = IdEntry | PathEntry;
type Allow = { ids: ReadonlySet<string>; paths: readonly PathEntry[] };

const QUESTION_FIELDS = ['text', 'helpText', 'example', 'options', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples'];

/**
 * A string of a content file: where it is (`file`, JSON `path`), how a failure names it (`where`), the ids of
 * every object it sits under (`owners`, outermost first, so an id entry reaches a nested object too), and the
 * nearest of them (`id`).
 */
type Found = { file: string; path: string; where: string; text: string; id: string | null; owners: string[] };

function collectStrings(value: unknown, file: string, path: string, where: string, owners: string[], out: Found[]): void {
  if (typeof value === 'string') out.push({ file, path, where, text: value, id: owners[owners.length - 1] ?? null, owners });
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, file, `${path}[${i}]`, `${where}[${i}]`, owners, out));
  else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    const below = typeof id === 'string' ? [...owners, id] : owners;
    for (const [k, v] of Object.entries(value)) collectStrings(v, file, `${path}.${k}`, `${where}.${k}`, below, out);
  }
}

/** Question objects (an `id` starting `Q-`) with their JSON path, found at any depth, so the check does not depend on how a bundle nests its stages. */
function questionsIn(value: unknown, path = '', out: Array<{ q: Record<string, unknown>; path: string }> = []): Array<{ q: Record<string, unknown>; path: string }> {
  if (Array.isArray(value)) value.forEach((v, i) => questionsIn(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('Q-')) out.push({ q: value as Record<string, unknown>, path });
    else for (const [k, v] of Object.entries(value)) questionsIn(v, path === '' ? k : `${path}.${k}`, out);
  }
  return out;
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Reads `a.b[2].c` from parsed JSON; `undefined` when any step is missing. */
function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const m of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    if (m[1] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[1])];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, m[2])) return undefined;
      cur = (cur as Record<string, unknown>)[m[2]];
    }
  }
  return cur;
}

function allowFrom(entries: readonly AllowEntry[]): Allow {
  return {
    ids: new Set(entries.flatMap((e) => ('id' in e ? [e.id] : []))),
    paths: entries.filter((e): e is PathEntry => 'path' in e),
  };
}

function versionDirs(contentRoot: string): string[] {
  return existsSync(contentRoot) ? readdirSync(contentRoot).filter((n) => statSync(join(contentRoot, n)).isDirectory()) : [];
}

type Scan = { hits: Found[]; stale: string[]; scanned: number };

/** The file and the JSON path of a path entry. An entry with no `#` is refused, never half-read. */
function splitEntryPath(path: string): [file: string, jsonPath: string] {
  const at = path.indexOf('#');
  if (at < 1 || at === path.length - 1) throw new Error(`allow-list path "${path}" must be <file>.json#<JSON path>`);
  return [path.slice(0, at), path.slice(at + 1)];
}

/**
 * The claim hits in every `<contentRoot>/<semver>/` directory, minus what the allow-list exempts, and the entries
 * that exempted nothing (`stale`, each named with why). `scanned` counts the strings read, so a caller can refuse a
 * scan that read nothing.
 */
function scanContent(contentRoot: string, allow: Allow): Scan {
  const hits: Found[] = [];
  const usedPaths = new Set<PathEntry>();
  const usedIds = new Set<string>();
  const why = new Map<PathEntry, string>();            // why a path entry that found no claim to exempt did not
  let scanned = 0;
  for (const v of versionDirs(contentRoot)) {
    const dir = join(contentRoot, v);
    const found: Found[] = [];
    const bank = readJson(join(dir, 'questionBank.json'));
    for (const { q, path } of questionsIn(bank)) {
      for (const f of QUESTION_FIELDS) if (f in q) collectStrings(q[f], 'questionBank.json', `${path}.${f}`, `${v}/questionBank.json ${q.id}.${f}`, [q.id as string], found);
    }
    const areas = readJson(join(dir, 'assessmentAreas.json')) as { areas?: unknown; controls?: unknown } | null;
    collectStrings(areas?.areas, 'assessmentAreas.json', 'areas', `${v}/assessmentAreas.json areas`, [], found);
    collectStrings(areas?.controls, 'assessmentAreas.json', 'controls', `${v}/assessmentAreas.json controls`, [], found);
    scanned += found.length;
    for (const s of found) {
      if (!CLAIMS.test(s.text)) continue;
      const byId = s.owners.filter((id) => allow.ids.has(id));
      if (byId.length > 0) {
        byId.forEach((id) => usedIds.add(id));
        continue;
      }
      const entry = allow.paths.find((e) => e.path === `${s.file}#${s.path}` && e.text === s.text);
      if (entry) usedPaths.add(entry);
      else hits.push(s);
    }
    for (const e of allow.paths) {
      const [file, jsonPath] = splitEntryPath(e.path);
      const root = file === 'questionBank.json' ? bank : file === 'assessmentAreas.json' ? areas : undefined;
      const at = valueAt(root, jsonPath);
      if (at === undefined) why.set(e, why.get(e) ?? 'the path finds nothing');
      else if (at !== e.text) why.set(e, "the string there is not the entry's text");
      else if (!CLAIMS.test(e.text)) why.set(e, 'the text matches no claim, so the entry exempts nothing');
    }
  }
  const stale = [
    ...[...allow.ids].filter((id) => !usedIds.has(id)).map((id) => `id ${id}: no string under this id matches a claim`),
    ...allow.paths.filter((e) => !usedPaths.has(e)).map((e) => `${e.path}: ${why.get(e) ?? 'the entry exempted no claim (the string is exempted by an id, or no content version is present)'}`),
  ];
  return { hits, stale, scanned };
}

/**
 * True when the content is due to be clean: the release candidate is being cut (`RELEASE_CANDIDATE=1`), or the
 * running version has a sign-off record. The same condition as `enforce` in CNT's
 * `__tests__/unit/content-release.test.ts` (unit/cnt, not on release yet; a later pass can import one helper).
 * Content that cannot be read is an error, never "not due".
 */
function contentIsDue(contentRoot: string, env: Record<string, string | undefined>): boolean {
  if (env.RELEASE_CANDIDATE === '1') return true;
  if (!existsSync(contentRoot)) return false;
  const index = readJson(join(contentRoot, 'index.json')) as { running?: unknown } | null;
  if (index === null || typeof index.running !== 'string' || index.running === '') {
    throw new Error(`${contentRoot}/index.json is missing or names no running version, so it is not known whether the content is due`);
  }
  const signoffs = readJson(join(contentRoot, index.running, 'signoffs.json')) as { records?: unknown } | null;
  if (signoffs === null || !Array.isArray(signoffs.records)) {
    throw new Error(`${contentRoot}/${index.running}/signoffs.json is missing or holds no "records" list`);
  }
  return signoffs.records.length > 0;
}

/**
 * A content version the scan could read nothing from would pass the claim check. Each
 * version directory must hold both files, with at least one question and a non-empty
 * list of areas and of controls.
 */
function contentShapeProblems(contentRoot: string): string[] {
  const problems: string[] = [];
  const versions = existsSync(contentRoot)
    ? readdirSync(contentRoot).filter((n) => statSync(join(contentRoot, n)).isDirectory())
    : [];
  for (const v of versions) {
    const bank = readJson(join(contentRoot, v, 'questionBank.json'));
    const areas = readJson(join(contentRoot, v, 'assessmentAreas.json')) as { areas?: unknown; controls?: unknown } | null;
    if (bank === null) problems.push(`${v}/questionBank.json is missing`);
    else if (questionsIn(bank).length === 0) problems.push(`${v}/questionBank.json holds no question (an object whose id starts with "Q-")`);
    else {
      for (const { q } of questionsIn(bank)) {
        if (typeof q.text !== 'string' || q.text.trim() === '') problems.push(`${v}/questionBank.json ${q.id} has no "text" string, so its question text would go unread`);
      }
    }
    if (areas === null) problems.push(`${v}/assessmentAreas.json is missing`);
    else {
      for (const key of ['areas', 'controls'] as const) {
        if (!Array.isArray(areas[key]) || (areas[key] as unknown[]).length === 0) {
          problems.push(`${v}/assessmentAreas.json has no "${key}" list`);
        }
      }
    }
  }
  return problems;
}

function readAllowlist(path: string): AllowEntry[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of { id, reason } or { path, text, reason }`);
  return raw as AllowEntry[];
}

/** What is wrong with an allow-list, one line per problem: the shape of each entry, and a key listed twice. */
function allowlistProblems(entries: readonly unknown[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  entries.forEach((e, i) => {
    const entry = e as Record<string, unknown>;
    const name = `entry ${i} ${JSON.stringify(e)}`;
    const names = Object.keys(entry ?? {}).sort().join(',');
    if (names !== 'id,reason' && names !== 'path,reason,text') problems.push(`${name}: keys must be exactly { id, reason } or { path, text, reason }`);
    const strings = Object.values(entry ?? {});
    if (!strings.every((v) => typeof v === 'string' && v.trim().length > 0)) problems.push(`${name}: every value must be a non-blank string`);
    if (typeof entry?.path === 'string' && !/^(questionBank|assessmentAreas)\.json#[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+|\[(0|[1-9][0-9]*)\])*$/.test(entry.path)) {
      problems.push(`${name}: path must be questionBank.json# or assessmentAreas.json# and a JSON path such as areas[10].references[0].citation`);
    }
    const key = String(entry?.id ?? entry?.path);
    if (keys.has(key)) problems.push(`${name}: ${key} is listed twice`);
    keys.add(key);
  });
  return problems;
}

/**
 * INTERIM. Strings of files that other units own and rebuild, which the widened pattern (SRS 7.5.3's list) flags
 * and which PUB does not reword. Each is a known finding, not an allowance: the first case fails when an entry's
 * text is gone from its file, so the list shrinks to nothing as the owners reword. Delete an entry with its fix.
 */
const OWNED_ELSEWHERE: Array<{ file: string; text: string; owner: string }> = [
  {
    file: 'app/(authenticated)/admin/settings/page.tsx',
    text: 'Question bank editing UI is under development. You will be able to manage assessment questions, categories, and scoring rubrics from this page.',
    owner: 'the platform administrator pages (ORG)',
  },
  {
    file: 'app/(authenticated)/orgs/[slug]/projects/new/NewProjectForm.tsx',
    text: 'Failed to create project',
    owner: 'the project pages (PRJ)',
  },
  {
    file: 'app/(public)/privacy/page.tsx',
    text: 'There is no self-service export or account deletion in the interface yet. Consent records are stored with a timestamp for audit purposes.',
    owner: 'ACC-a, which replaces this text with legal\'s',
  },
];

// --- The tests ------------------------------------------------------------

describe('no product claims', () => {
  it('FR-PUB-01: no product claim in the package description, the README, or any user-facing string in app and components', () => {
    // A scan that read nothing would pass: both roots must hold code, and the About page must be among it.
    for (const root of ['app', 'components']) expect(sourceFiles(root).length, `no code found under ${root}`).toBeGreaterThan(0);
    expect(sourceFiles('app')).toContain(join('app', '(public)', 'about', 'page.tsx'));
    const hits = [
      ...matchIn('package.json description', JSON.parse(readFileSync('package.json', 'utf8')).description),
      ...matchIn('README.md', readFileSync('README.md', 'utf8'), CLAIMS_CORE),
      ...userFacingStrings(['app', 'components'])
        .filter((s) => !s.insideClaimsAllowed && CLAIMS.test(s.text))
        .map(({ where, text }) => ({ where, text })),
    ];
    const ownedHere = (h: Hit, o: (typeof OWNED_ELSEWHERE)[number]) => h.where.startsWith(`${o.file}:`) && h.text === o.text;
    expect(hits.filter((h) => !OWNED_ELSEWHERE.some((o) => ownedHere(h, o)))).toEqual([]);
    expect(
      OWNED_ELSEWHERE.filter((o) => !hits.some((h) => ownedHere(h, o))).map((o) => `${o.file}: "${o.text}" is no longer flagged; delete its entry`),
    ).toEqual([]);
  });

  it('FR-PUB-01: the fixture holding every string the requirement cites is flagged', () => {
    const lines = readFileSync('__tests__/fixtures/claims/why-strings.txt', 'utf8').trim().split('\n');
    expect(lines).toEqual([
      'audit-ready reports. Aligned to ISO/IEC 42001',
      'aligned to ISO/IEC 42001 clauses',
      'responsible AI compliance',
      'scored against responsible AI principles. At the end, you get a readiness report',
      'Assessment scores',
    ]);
    for (const l of lines) expect(CLAIMS.test(l), l).toBe(true);
  });

  // SRS 7.5.3 (line 2472): "these words and their forms never appear" in the interface, documents and emails.
  // One synthetic page per entry holds one sentence with the word; the pattern must flag it. The qualified words
  // ("approved" as something the platform gives, "level" as a grade, "progress" or "complete" about a stage or
  // project) are flagged in the forms that carry the qualifier; their bare uses ("complete the form") are not banned.
  const NEVER_LIST: Array<[word: string, sentence: string]> = [
    ['compliance', 'Our compliance guide'], ['compliant', 'This record is compliant'],
    ['audit', 'Open the audit log'], ['audits', 'Teams run audits'], ['audited', 'Every record is audited'],
    ['auditing', 'Auditing your data'], ['audit-ready', 'Audit-ready documents'], ['auditor', 'Share it with an auditor'],
    ['certified', 'A certified team'], ['certification', 'Certification of the stage'], ['certify', 'We certify the stage'],
    ['certificate', 'Download the certificate'], ['accredited', 'An accredited body'],
    ['approved', 'The stage was approved'], ['approval', 'Awaiting approval'], ['approve', 'Approve the stage'],
    ['aligned with', 'Aligned with a standard'], ['alignment with', 'Alignment with a standard'],
    ['conforms to', 'It conforms to the standard'], ['conformity', 'Conformity checks'],
    ['score', 'The score'], ['scores', 'Scores for each area'], ['scored', 'Answers are scored'], ['scoring', 'Scoring rules'],
    ['rating', 'The rating of the team'], ['ratings', 'Ratings per area'], ['rated', 'Rated high'],
    ['grade', 'A grade for each area'], ['grades', 'Grades per stage'], ['graded', 'Graded answers'], ['grading', 'Grading rules'],
    ['rank', 'Rank the areas'], ['ranks', 'It ranks teams'], ['ranked', 'Areas are ranked'], ['ranking', 'A ranking of teams'],
    ['maturity', 'Maturity of the team'], ['readiness', 'Readiness for review'],
    ['level (as a grade)', 'Level 3 reached'], ['risk level', 'Risk level: high'], ['risk level (a low-risk result)', 'A low-risk result'],
    ['band', 'Band B'], ['bands', 'Bands of answers'],
    ['pass', 'Pass'], ['passed', 'The stage passed'], ['fail', 'Fail'], ['failed', 'The review failed'],
    ['percentage', 'A percentage of items'], ['%', '40% of items have a decision'],
    ['progress (about a stage)', 'Progress through the stage'],
    ['complete (about a stage)', 'This stage is complete'], ['complete (about a project)', 'The project was completed'],
    ['mark as complete', 'Mark as complete'], ['completion', 'Completion of the stage'],
    ['severity', 'Severity of the finding'],
    ['Gate A', 'Gate A review'], ['Gate B', 'Gate B review'], ['facilitator', 'Ask your facilitator'],
    ['workshop', 'Join the workshop'], ['AI-powered', 'AI-powered checks'],
  ];
  // Words that share letters with the list and are ordinary: they must stay unflagged.
  const MAY_APPEAR = [
    'Enter your password', 'Operating hours', 'Integrated records', 'Generated from this team\'s own records', 'Migrated data',
    'Upgrade your browser', 'A gradient fill', 'Bypass the proxy', 'A branded button', 'Bandwidth', 'A passage', 'Passport photo',
    'Complete the form', 'An incomplete answer', 'Compass', 'Sign in to continue', 'Create a project', 'Save your decision',
    'Authority', 'Frank discussion', 'A progressive web app', 'Your decision is saved', 'Try again',
  ];

  it('FR-PUB-01: every word of the SRS 7.5.3 list, and its forms, is flagged on a synthetic page that holds it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-words-'));
    try {
      mkdirSync(join(dir, 'app'));
      NEVER_LIST.forEach(([, sentence], i) =>
        writeFileSync(join(dir, 'app', `w${i}.tsx`), `export default function W() { return <main><p>${sentence}</p></main>; }\n`));
      writeFileSync(join(dir, 'app', 'ok.tsx'), `export default function W() { return <main>${MAY_APPEAR.map((t) => `<p>${t.replace(/\?/g, '')}</p>`).join('')}</main>; }\n`);
      const found = userFacingStrings([join(dir, 'app')]);
      expect(found.length, 'the scan read every synthetic page').toBeGreaterThanOrEqual(NEVER_LIST.length + MAY_APPEAR.length);
      const unflagged = NEVER_LIST.filter(([, sentence]) => !found.some((f) => f.text.trim() === sentence && CLAIMS.test(f.text))).map(([w]) => w);
      expect(unflagged, 'words of the SRS 7.5.3 list the phrase test does not catch').toEqual([]);
      const wrongly = MAY_APPEAR.map((t) => t.replace(/\?/g, '')).filter((t) => found.some((f) => f.text.trim() === t && CLAIMS.test(f.text)));
      expect(wrongly, 'ordinary words the phrase test flags').toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: strings that are code are not read as words: class names with a modifier, CSS functions, and console messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-code-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(
        join(dir, 'app', 'code.tsx'),
        [
          'export const a = (ok: boolean) => (ok ? "badge--completed" : "badge--in-progress");',
          'export const b = "repeat(auto-fit, minmax(min(100%, 24rem), 1fr))";',
          'export function c() { console.error("evidence route: logSecurityEvent failed", 1); }',
          'export const d = <p>The review failed</p>;',
        ].join('\n'),
      );
      const flagged = userFacingStrings([join(dir, 'app')]).filter((s) => CLAIMS.test(s.text)).map((s) => s.text);
      expect(flagged).toEqual(['The review failed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: the patterns of the claims crawl are the patterns of the phrase test', () => {
    // e2e/claims-crawl.spec.ts cannot import this file (a spec that imports a vitest file registers its tests),
    // so it carries copies. A copy that drifted would let the crawl pass a phrase this test refuses, or the
    // reverse; the copies are read as text and compared as patterns.
    const spec = readFileSync('e2e/claims-crawl.spec.ts', 'utf8');
    for (const [name, pattern] of [['CLAIMS_CORE', CLAIMS_CORE], ['CLAIMS', CLAIMS]] as const) {
      expect(spec.match(new RegExp(`^const ${name}\\b`, 'gm')), `one definition of ${name} in the crawl`).toHaveLength(1);
      const found = spec.match(new RegExp(`^const ${name} =\\s*\\n?\\s*(\\/.*\\/[a-z]*);$`, 'm'));
      expect(found, `e2e/claims-crawl.spec.ts holds \`const ${name} = /.../flags;\``).not.toBeNull();
      const body = found![1];
      const copy = new RegExp(body.slice(1, body.lastIndexOf('/')), body.slice(body.lastIndexOf('/') + 1));
      expect(copy.source, name).toBe(pattern.source);
      expect(copy.flags, name).toBe(pattern.flags);
    }
    // The crawl must match with those constants, flags included, and not with a pattern of its own.
    expect(spec).toContain('new RegExp(pattern.source, pattern.flags');
    expect(spec).toContain('pattern: RegExp = CLAIMS');
  });

  it('FR-PUB-01: every data-claims-allowed marker states its reason, and the About page declares exactly the five it needs', () => {
    const markers = claimsAllowedMarkers(['app', 'components']);
    expect(markers.filter((m) => m.reason === '').map((m) => m.file), 'a marker with no reason').toEqual([]);
    const about = markers.filter((m) => m.file === join('app', '(public)', 'about', 'page.tsx')).map((m) => m.reason);
    expect(about.sort()).toEqual(['about-model-scores', 'about-model-scores', 'not-an-approval-service', 'why-no-score', 'why-no-score']);   // why-no-score: the heading and the explanation, not the paragraph about what a team gets instead
  });

  it('FR-PUB-01: a string inside data-claims-allowed passes and the same string outside it is a hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(
        join(dir, 'app', 'a.tsx'),
        [
          "import x from './score-bands';",
          'export const a = (',
          '  <div>',
          '    <p data-claims-allowed="why-no-score">Why there is no score</p>',
          '    <p>Why there is a score</p>',
          '    <p aria-label="audit-ready">ok</p>',
          '    <p className="score-gauge">ok</p>',
          '  </div>',
          ');',
        ].join('\n'),
      );
      const found = userFacingStrings([join(dir, 'app')]);
      const flagged = found.filter((s) => !s.insideClaimsAllowed && CLAIMS.test(s.text)).map((s) => s.text);
      expect(flagged.sort()).toEqual(['Why there is a score', 'audit-ready']);
      expect(found.some((s) => s.insideClaimsAllowed && /no score/.test(s.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: the allow-list holds only { id, reason } or { path, text, reason } entries, each with a reason', () => {
    const entries = readAllowlist('__tests__/lint/claim-allowlist.json');
    expect(allowlistProblems(entries)).toEqual([]);
    // The check itself refuses what it should.
    expect(allowlistProblems([{ id: 'Q-1' }])).toHaveLength(1);                                   // no reason
    expect(allowlistProblems([{ id: 'Q-1', reason: ' ' }]).join()).toMatch(/non-blank/);
    expect(allowlistProblems([{ id: 'Q-1', path: 'a.json#x', text: 't', reason: 'r' }]).join()).toMatch(/keys must be exactly/);
    expect(allowlistProblems([{ path: 'assessmentAreas.json#areas[0].x', reason: 'r' }]).join()).toMatch(/keys must be exactly/);
    expect(allowlistProblems([{ path: 'areas[0].x', text: 't', reason: 'r' }]).join()).toMatch(/path must be/);
    for (const bad of ['assessmentAreas.json#', 'assessmentAreas.json#areas[00].x', 'assessmentAreas.json#areas[0]x', 'assessmentAreas.json#areas..x', 'assessmentAreas.json#.areas', 'other.json#areas[0].x', 'assessmentAreas.json']) {
      expect(allowlistProblems([{ path: bad, text: 't', reason: 'r' }]).join(), bad).toMatch(/path must be/);
    }
    for (const good of ['assessmentAreas.json#areas[10].references[0].citation', 'questionBank.json#stages.pre-processing.modules[0].questions[0].text']) {
      expect(allowlistProblems([{ path: good, text: 't', reason: 'r' }]), good).toEqual([]);
    }
    expect(() => scanContent(join(process.cwd(), 'data', 'content'), allowFrom([{ path: 'assessmentAreas.json', text: 't', reason: 'r' }]))).toThrow(/must be <file>\.json#<JSON path>/);
    expect(allowlistProblems([{ id: 'Q-1', reason: 'r' }, { id: 'Q-1', reason: 'r2' }]).join()).toMatch(/listed twice/);
    expect(allowlistProblems([{ path: 'a.json#x', text: 't', reason: 'r' }, { path: 'a.json#x', text: 'u', reason: 'r' }]).join()).toMatch(/listed twice/);
  });

  // --- The content check: what it does always, and when it fails the build ------------------------------------
  //
  // Content 5.0.0 is on the release branch before C-TXT has reworded it, so the check that content holds no claim
  // is due when the content is: at the release candidate, or once the running version has a sign-off record. Two
  // cases run always: one reads the real content and reports what it finds, and one proves on a planted bundle
  // that the scan finds a banned phrase and honours the allow-list.

  const CONTENT_ROOT = join(process.cwd(), 'data', 'content');
  // If the condition cannot be read, enforce: the enforced case then calls contentIsDue again and fails with the reason.
  let dueError: unknown = null;
  const due = (() => {
    try {
      return contentIsDue(CONTENT_ROOT, process.env);
    } catch (e) {
      dueError = e;
      return true;
    }
  })();

  it('FR-PUB-01: the claim scan reads the real running content and reports what it finds', () => {
    const versions = versionDirs(CONTENT_ROOT);
    expect(versions.length, 'data/content/<semver>/ holds the running content').toBeGreaterThan(0);
    expect(contentShapeProblems(CONTENT_ROOT), 'the claim check would read nothing from these').toEqual([]);
    const { hits, stale, scanned } = scanContent(CONTENT_ROOT, allowFrom(readAllowlist('__tests__/lint/claim-allowlist.json')));
    expect(scanned, 'the scan read strings from the real content').toBeGreaterThan(0);
    const owners = [...new Set(hits.map((h) => h.id ?? h.where))];
    console.info(
      `[no-product-claims] content ${versions.join(', ')}: ${hits.length} claim hit(s) in ${owners.length} item(s)${owners.length ? `: ${owners.join(', ')}` : ''}` +
        `${stale.length ? `; stale allow-list entries: ${stale.join(' | ')}` : ''}. ` +
        (dueError !== null
          ? `Whether the content is due could not be read (${String(dueError)}), so the next case runs and fails.`
          : due
            ? 'The content is due, so the next case fails on them.'
            : 'The content is not due (no sign-off record, no RELEASE_CANDIDATE=1), so they do not fail the build yet.'),
    );
  });

  it.skipIf(!due)('FR-PUB-01: content question and area texts hold no claim, except the allow-listed (the content is due)', () => {
    expect(contentIsDue(CONTENT_ROOT, process.env), 'this case runs only when the content is due').toBe(true);
    const versions = versionDirs(CONTENT_ROOT);
    // Content 5.0.0 arrives with the content units; a release candidate without it is not a candidate.
    expect(versions.length > 0 || process.env.RELEASE_CANDIDATE !== '1', 'RELEASE_CANDIDATE=1 and no data/content/<semver>/ directory').toBe(true);
    expect(contentShapeProblems(CONTENT_ROOT), 'the claim check would read nothing from these').toEqual([]);
    const { hits, stale, scanned } = scanContent(CONTENT_ROOT, allowFrom(readAllowlist('__tests__/lint/claim-allowlist.json')));
    expect(scanned, 'the scan read strings from the content').toBeGreaterThan(0);
    expect(stale, 'allow-list entries that exempt nothing').toEqual([]);
    expect(hits.map((h) => `${h.where}: ${h.text}`)).toEqual([]);
  });

  it('FR-PUB-01: the content is due at the release candidate or once the running version has a sign-off record, and an unreadable state is an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-due-'));
    try {
      expect(contentIsDue(join(dir, 'nowhere'), {}), 'no content directory, no release candidate').toBe(false);
      expect(contentIsDue(join(dir, 'nowhere'), { RELEASE_CANDIDATE: '1' })).toBe(true);
      expect(() => contentIsDue(dir, {}), 'a directory with no index.json').toThrow(/index\.json/);
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ running: '9.9.9', versions: ['9.9.9'] }));
      expect(() => contentIsDue(dir, {}), 'a running version with no signoffs.json').toThrow(/9\.9\.9\/signoffs\.json/);
      mkdirSync(join(dir, '9.9.9'));
      writeFileSync(join(dir, '9.9.9', 'signoffs.json'), JSON.stringify({ records: [] }));
      expect(contentIsDue(dir, {}), 'no sign-off record').toBe(false);
      expect(contentIsDue(dir, { RELEASE_CANDIDATE: '0' }), 'only 1 turns it on').toBe(false);
      expect(contentIsDue(dir, { RELEASE_CANDIDATE: '1' })).toBe(true);
      writeFileSync(join(dir, '9.9.9', 'signoffs.json'), JSON.stringify({ records: [{ batch: 'pre-processing' }] }));
      expect(contentIsDue(dir, {}), 'a sign-off record').toBe(true);
      writeFileSync(join(dir, '9.9.9', 'signoffs.json'), JSON.stringify({ rows: [] }));
      expect(() => contentIsDue(dir, {}), 'a signoffs file with no records list').toThrow(/records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: a content version missing a file, or holding no question, area or control, is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-shape-'));
    try {
      mkdirSync(join(dir, '1.0.0'));
      expect(contentShapeProblems(dir)).toEqual(['1.0.0/questionBank.json is missing', '1.0.0/assessmentAreas.json is missing']);
      writeFileSync(join(dir, '1.0.0', 'questionBank.json'), JSON.stringify({ stages: {} }));
      writeFileSync(join(dir, '1.0.0', 'assessmentAreas.json'), JSON.stringify({ areas: [], controls: [{ id: 'C-1' }] }));
      expect(contentShapeProblems(dir)).toEqual([
        '1.0.0/questionBank.json holds no question (an object whose id starts with "Q-")',
        '1.0.0/assessmentAreas.json has no "areas" list',
      ]);
      writeFileSync(join(dir, '1.0.0', 'questionBank.json'), JSON.stringify({ stages: { a: { questions: [{ id: 'Q-1' }] } } }));
      writeFileSync(join(dir, '1.0.0', 'assessmentAreas.json'), JSON.stringify({ areas: [{ id: 'A-1' }], controls: [{ id: 'C-1' }] }));
      expect(contentShapeProblems(dir), 'a question with no text string').toEqual(['1.0.0/questionBank.json Q-1 has no "text" string, so its question text would go unread']);
      writeFileSync(join(dir, '1.0.0', 'questionBank.json'), JSON.stringify({ stages: { a: { questions: [{ id: 'Q-1', text: 'Fine.' }] } } }));
      expect(contentShapeProblems(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A bundle with exactly the given question texts and area descriptions; the rest of each file is clean. */
  function plantedBundle(o: { questions?: Array<Record<string, unknown>>; areas?: Array<Record<string, unknown>> }): string {
    const dir = mkdtempSync(join(tmpdir(), 'claims-content-'));
    mkdirSync(join(dir, '9.9.9'));
    writeFileSync(
      join(dir, '9.9.9', 'questionBank.json'),
      JSON.stringify({ stages: { 'pre-processing': { modules: [{ id: 'M-1', questions: o.questions ?? [{ id: 'Q-PP-01', text: 'Fine.' }] }] } } }),
    );
    writeFileSync(
      join(dir, '9.9.9', 'assessmentAreas.json'),
      JSON.stringify({ areas: o.areas ?? [{ id: 'PP-01', name: 'Fine', description: 'Fine.' }], controls: [{ id: 'C-01', name: 'Fine' }] }),
    );
    return dir;
  }

  it('FR-PUB-01: a bundle with one planted banned phrase is refused, and the same bundle with its id allow-listed is not', () => {
    const dir = plantedBundle({ questions: [{ id: 'Q-PP-01', text: 'Fine.' }, { id: 'Q-PO-22', text: 'Do you check your compliance with the law?' }] });
    try {
      const refused = scanContent(dir, allowFrom([]));
      expect(refused.scanned, 'the scan read the bundle').toBeGreaterThan(0);
      expect(refused.hits.map((h) => h.where)).toEqual(['9.9.9/questionBank.json Q-PO-22.text']);
      expect(scanContent(dir, allowFrom([{ id: 'Q-PO-22', reason: 'asks the team about its own practice' }])).hits).toEqual([]);
      // An id that is not in the bundle exempts nothing, and is reported stale.
      const missing = scanContent(dir, allowFrom([{ id: 'Q-PO-23', reason: 'x' }]));
      expect(missing.hits).toHaveLength(1);
      expect(missing.stale).toEqual(['id Q-PO-23: no string under this id matches a claim']);
      // An id whose item no longer holds a claim is stale too.
      expect(scanContent(dir, allowFrom([{ id: 'Q-PP-01', reason: 'x' }])).stale).toEqual(['id Q-PP-01: no string under this id matches a claim']);
      expect(scanContent(dir, allowFrom([{ id: 'Q-PO-22', reason: 'x' }])).stale).toEqual([]);
      // An id entry reaches a nested object that has an id of its own.
      const nested = plantedBundle({ areas: [{ id: 'PP-01', name: 'Fine', description: 'Fine.', references: [{ id: 'R-1', citation: 'Risk Scores' }] }] });
      try {
        expect(scanContent(nested, allowFrom([])).hits.map((h) => h.owners)).toEqual([['PP-01', 'R-1']]);
        expect(scanContent(nested, allowFrom([{ id: 'PP-01', reason: 'x' }])).hits).toEqual([]);
      } finally {
        rmSync(nested, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: a path entry exempts that one string and nothing else', () => {
    const citation = "Kleinberg, J. (2017). Inherent Trade-Offs in the Fair Determination of Risk Scores. ITCS '17.";
    const dir = plantedBundle({
      areas: [
        { id: 'PP-01', name: 'Fine', description: 'Fine.', references: [{ citation }, { citation: 'Second: Risk Scores.' }] },
        { id: 'PP-02', name: 'Fine', description: citation },
      ],
    });
    try {
      const entry = { path: 'assessmentAreas.json#areas[0].references[0].citation', text: citation, reason: 'verbatim title of a cited work' };
      expect(scanContent(dir, allowFrom([])).hits.map((h) => h.path)).toEqual([
        'areas[0].references[0].citation',
        'areas[0].references[1].citation',
        'areas[1].description',
      ]);
      const exempt = scanContent(dir, allowFrom([entry]));
      expect(exempt.stale).toEqual([]);
      // The sibling reference, and the same words at another path, are still hits.
      expect(exempt.hits.map((h) => h.path)).toEqual(['areas[0].references[1].citation', 'areas[1].description']);
      // A question text is reached by its real path in questionBank.json too.
      const q = plantedBundle({ questions: [{ id: 'Q-PP-01', text: 'Is the system compliant?' }] });
      try {
        const qEntry = { path: 'questionBank.json#stages.pre-processing.modules[0].questions[0].text', text: 'Is the system compliant?', reason: 'asks the team' };
        expect(scanContent(q, allowFrom([qEntry]))).toMatchObject({ hits: [], stale: [] });
      } finally {
        rmSync(q, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: a path entry whose path, text or claim no longer matches is stale, and is named', () => {
    const citation = 'Inherent Trade-Offs in the Fair Determination of Risk Scores';
    const dir = plantedBundle({ areas: [{ id: 'PP-01', name: 'Fine', description: 'Fine.', references: [{ citation }, { citation: 'A clean title.' }] }] });
    try {
      const stale = (e: PathEntry) => scanContent(dir, allowFrom([e])).stale;
      const base = { path: 'assessmentAreas.json#areas[0].references[0].citation', text: citation, reason: 'r' };
      expect(stale(base)).toEqual([]);
      expect(stale({ ...base, path: 'assessmentAreas.json#areas[0].references[5].citation' })).toEqual([
        'assessmentAreas.json#areas[0].references[5].citation: the path finds nothing',
      ]);
      expect(stale({ ...base, text: `${citation}.` })[0]).toMatch(/^assessmentAreas\.json#areas\[0\]\.references\[0\]\.citation: the string there is not the entry's text$/);
      expect(stale({ ...base, path: 'assessmentAreas.json#areas[0].references[1].citation', text: 'A clean title.' })[0]).toMatch(/matches no claim/);
      expect(stale({ ...base, path: 'other.json#areas[0].references[0].citation' })[0]).toMatch(/^other\.json#areas\[0\]\.references\[0\]\.citation: the path finds nothing$/);
      // A stale entry exempts nothing: the string it pointed at stays a hit when the text differs.
      expect(scanContent(dir, allowFrom([{ ...base, text: `${citation}.` }])).hits.map((h) => h.path)).toEqual(['areas[0].references[0].citation']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: the content check flags question, area and control texts, reads real paths, and skips an allow-listed id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-content-'));
    try {
      mkdirSync(join(dir, '9.9.9'));
      writeFileSync(
        join(dir, '9.9.9', 'questionBank.json'),
        JSON.stringify({
          stages: {
            'pre-processing': {
              modules: [
                {
                  id: 'M-1',
                  questions: [
                    { id: 'Q-PP-90', text: 'Is the system compliant?', expectedPractice: 'Fine.' },
                    { id: 'Q-PO-22', text: 'Do you check your compliance with the law?', whyAsked: 'So you know.' },
                    { id: 'Q-PP-91', text: 'Fine.', whyAsked: 'Because a score helps.', gaps: ['certification'] },
                  ],
                },
              ],
            },
          },
        }),
      );
      writeFileSync(
        join(dir, '9.9.9', 'assessmentAreas.json'),
        JSON.stringify({
          areas: [{ id: 'PP-90', name: 'Fine', description: 'Aligned with a standard.' }],
          controls: [{ id: 'C-90', name: 'Fine', resources: [{ title: 'Audit-ready toolkit' }] }],
        }),
      );
      const ids = (...list: string[]): Allow => ({ ids: new Set(list), paths: [] });
      const hits = scanContent(dir, ids('Q-PO-22')).hits;
      expect(hits.map((h) => h.where)).toEqual([
        '9.9.9/questionBank.json Q-PP-90.text',
        '9.9.9/questionBank.json Q-PP-91.whyAsked',
        '9.9.9/assessmentAreas.json areas[0].description',
        '9.9.9/assessmentAreas.json controls[0].resources[0].title',
      ]);
      expect(hits.map((h) => `${h.file}#${h.path}`)).toEqual([
        'questionBank.json#stages.pre-processing.modules[0].questions[0].text',
        'questionBank.json#stages.pre-processing.modules[0].questions[2].whyAsked',
        'assessmentAreas.json#areas[0].description',
        'assessmentAreas.json#controls[0].resources[0].title',
      ]);
      // `gaps` is not a text field, so 'certification' in it is not read.
      expect(hits.map((h) => h.where).join()).not.toContain('gaps');
      // Allow-listing a control id skips every string under it.
      expect(scanContent(dir, ids('Q-PO-22', 'C-90', 'PP-90', 'Q-PP-90', 'Q-PP-91')).hits).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
