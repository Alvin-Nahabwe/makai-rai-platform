import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { CLAIMS_CORE, MAY_APPEAR, NEVER_LIST, NEVER_WORDS, claimMatches, isClaim } from '@/lib/claims/pattern';

/**
 * FR-PUB-01: the platform makes no claim of compliance, audit readiness,
 * certification, approval, accreditation or alignment with a standard about
 * itself or its outputs, and shows no score. This is the phrase test over
 * source and content; `e2e/claims-crawl.spec.ts` is the same pattern over
 * rendered pages. The pattern is `lib/claims/pattern.ts`, a module with no
 * tests in it, which both import and which the document tests of DOC-a and
 * DOC-b and C-TXT's text check import too.
 *
 * What is let through, and nothing else:
 *   - an element carrying `data-claims-allowed` in JSX (the About page's
 *     sentences that explain why there is no score, and the exact allow-listed
 *     sentences of SRS 7.5.3);
 *   - a content item named in `claim-allowlist.json`, each with its reason.
 */
type Hit = { where: string; text: string };

/** Every line of `text` that matches, with its position. */
function matchIn(where: string, text: string, pattern: { test(s: string): boolean } = { test: isClaim }): Hit[] {
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

/**
 * True when the node is words inside a JSX element that carries `data-claims-allowed`. A string in an attribute
 * (a title, an aria-label, an alt) is spoken but is not the marked sentence, so a marker never exempts it.
 */
function insideClaimsAllowed(node: ts.Node): boolean {
  let inAttribute = false;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isJsxAttribute(n)) inAttribute = true;
    const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
    if (
      opening?.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText() === 'data-claims-allowed',
      )
    ) {
      return !inAttribute;
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
  // A string compared with `===` or `!==` names a state in code (`status === 'completed'`); it is never shown.
  if (
    ts.isBinaryExpression(p) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)
  ) {
    return true;
  }
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

/** The one component that may carry `data-source-note`, and the one page that may render it (review r1 I-2). */
const REFERENCES_LIST = 'components/report/ReferencesList';
const S26_PAGE = 'app/(authenticated)/explore/framework/page.tsx';

/** The module a specifier names, as a path from `base` without its extension; a package name is returned as it is. */
function specifierTarget(spec: string, file: string, base: string): string {
  const path = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? relative(base, resolve(dirname(file), spec)).split(sep).join('/') : spec;
  return path.replace(/\.(tsx|ts|jsx|js)$/, '');
}

/** The module specifier of an import, a re-export, a dynamic `import()` or a `require()`, when `n` is one. */
function moduleSpecifierOf(n: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) return n.moduleSpecifier.text;
  if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
    const [arg] = n.arguments;
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return undefined;
}

/** True when a `data-source-note` attribute sits on the element whose child is `{ref.relevance}`. */
function onRelevanceNote(attr: ts.JsxAttribute): boolean {
  const element = attr.parent.parent.parent;
  return ts.isJsxElement(element) && element.children.some((c) => ts.isJsxExpression(c) && c.expression?.getText() === 'ref.relevance');
}

/**
 * Every use of `data-source-note` under `roots` (below `base`) other than the one ruling 2 allows: the attribute on
 * ReferencesList's `{ref.relevance}` element. A string holding the name (a `setAttribute`, a spread) is a use too.
 * And every import of ReferencesList other than S-26's, so the note only ever shows content's cited sources.
 */
function sourceNoteProblems(base: string, roots: string[]): string[] {
  const problems: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(join(base, root))) {
      const rel = relative(base, file).split(sep).join('/');
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (n: ts.Node): void => {
        if (ts.isJsxAttribute(n) && n.name.getText() === 'data-source-note') {
          if (!(rel === `${REFERENCES_LIST}.tsx` && onRelevanceNote(n))) problems.push(`${rel}: data-source-note is allowed only on ReferencesList's {ref.relevance} element`);
        } else if (ts.isStringLiteralLike(n) && n.text.includes('data-source-note')) {
          problems.push(`${rel}: the string "data-source-note" is allowed only as ReferencesList's attribute`);
        }
        const spec = moduleSpecifierOf(n);
        if (spec !== undefined && specifierTarget(spec, file, base) === REFERENCES_LIST && rel !== S26_PAGE) {
          problems.push(`${rel} imports ${REFERENCES_LIST}; only ${S26_PAGE} may`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return problems;
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

const QUESTION_FIELDS = ['text', 'helpText', 'example', 'options', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples', 'principle'];

/**
 * A string of a content file: where it is (`file`, JSON `path`), how a failure names it (`where`), the ids of
 * every object it sits under (`owners`, outermost first, so an id entry reaches a nested object too), and the
 * nearest of them (`id`).
 */
type Found = { file: string; path: string; where: string; text: string; id: string | null; owners: string[]; question?: string };

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

const MODULE_FIELDS = ['title', 'description', 'momentsOfBias'];
const REASON_CODE_FIELDS = ['label', 'useWhen', 'reasonMustSay'];

/** Module objects (an object with a `questions` list) with their JSON path: their own title, description and moments of bias are read too. */
function modulesIn(value: unknown, path = '', out: Array<{ module: Record<string, unknown>; path: string }> = []): Array<{ module: Record<string, unknown>; path: string }> {
  if (Array.isArray(value)) value.forEach((v, i) => modulesIn(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    if (Array.isArray((value as { questions?: unknown }).questions)) out.push({ module: value as Record<string, unknown>, path });
    for (const [k, v] of Object.entries(value)) modulesIn(v, path === '' ? k : `${path}.${k}`, out);
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

/**
 * The `%` alternative of the claim pattern (`NEVER_WORDS`). SRS 7.5.3 bans a percentage "next to the team's items",
 * and a cited study's figure is not one (coordinator ruling 2, unit/cnt), so a reference's relevance note
 * (`assessmentAreas.json` `areas[].references[].relevance`, what S-26 shows through ReferencesList) is not a hit
 * for a match of this alternative alone. Every other word of the list in a note is still a hit, and a percentage
 * anywhere else (a question, an area description) still is one. The crawl's `data-source-note` skip is the same rule.
 */
const SOURCE_NOTE_PERCENT_ALTERNATIVE = String.raw`\d\s?%`;
const SOURCE_NOTE_PERCENT = new RegExp(`^(?:${SOURCE_NOTE_PERCENT_ALTERNATIVE})$`);
const SOURCE_NOTE_PATH = /^areas\[\d+\]\.references\[\d+\]\.relevance$/;

/** True when a content string is a claim: for a reference's relevance note, a claim other than a cited figure. */
function contentClaim(s: Found): boolean {
  if (s.file === 'assessmentAreas.json' && SOURCE_NOTE_PATH.test(s.path)) {
    return claimMatches(s.text).some((m) => !SOURCE_NOTE_PERCENT.test(m.text));
  }
  return isClaim(s.text);
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
      const before = found.length;
      for (const f of QUESTION_FIELDS) if (f in q) collectStrings(q[f], 'questionBank.json', `${path}.${f}`, `${v}/questionBank.json ${q.id}.${f}`, [q.id as string], found);
      for (const item of found.slice(before)) item.question = path;
    }
    for (const { module, path } of modulesIn(bank)) {
      for (const f of MODULE_FIELDS) if (f in module) collectStrings(module[f], 'questionBank.json', `${path}.${f}`, `${v}/questionBank.json ${path}.${f}`, [], found);
    }
    const areas = readJson(join(dir, 'assessmentAreas.json')) as { areas?: unknown; controls?: unknown } | null;
    collectStrings(areas?.areas, 'assessmentAreas.json', 'areas', `${v}/assessmentAreas.json areas`, [], found);
    collectStrings(areas?.controls, 'assessmentAreas.json', 'controls', `${v}/assessmentAreas.json controls`, [], found);
    const stages = (areas as { stages?: Record<string, Record<string, unknown>> } | null)?.stages;
    if (stages && typeof stages === 'object') {
      for (const [k, stage] of Object.entries(stages)) {
        for (const f of ['label', 'description']) if (f in stage) collectStrings(stage[f], 'assessmentAreas.json', `stages.${k}.${f}`, `${v}/assessmentAreas.json stages.${k}.${f}`, [], found);
      }
    }
    const config = readJson(join(dir, 'projectConfig.json')) as Record<string, unknown> | null;
    if (config && typeof config === 'object') {
      for (const f of ['projectName', 'description', 'principlesSource']) if (f in config) collectStrings(config[f], 'projectConfig.json', f, `${v}/projectConfig.json ${f}`, [], found);
    }
    const help = readJson(join(dir, 'documentHelp.json'));
    if (help && typeof help === 'object') {
      for (const [k, text] of Object.entries(help)) collectStrings(text, 'documentHelp.json', k, `${v}/documentHelp.json ${k}`, [], found);
    }
    const codes = readJson(join(dir, 'reasonCodes.json')) as { codes?: unknown } | null;
    if (Array.isArray(codes?.codes)) {
      codes.codes.forEach((c: Record<string, unknown>, i: number) => {
        for (const f of REASON_CODE_FIELDS) if (f in c) collectStrings(c[f], 'reasonCodes.json', `codes[${i}].${f}`, `${v}/reasonCodes.json codes[${i}].${f}`, [], found);
      });
    }
    scanned += found.length;
    for (const s of found) {
      if (!contentClaim(s)) continue;
      // An id entry exempts one question's own text and nothing else under it (AL-7).
      const questionId = s.owners[s.owners.length - 1];
      if (s.question !== undefined && s.path === `${s.question}.text` && questionId !== undefined && allow.ids.has(questionId)) {
        usedIds.add(questionId);
        continue;
      }
      const entry = allow.paths.find((e) => e.path === `${s.file}#${s.path}` && e.text === s.text);
      if (entry) usedPaths.add(entry);
      else hits.push(s);
    }
    for (const e of allow.paths) {
      const [file, jsonPath] = splitEntryPath(e.path);
      const root = { 'questionBank.json': bank, 'assessmentAreas.json': areas, 'documentHelp.json': help, 'reasonCodes.json': codes, 'projectConfig.json': config }[file];
      const at = valueAt(root, jsonPath);
      if (at === undefined) why.set(e, why.get(e) ?? 'the path finds nothing');
      else if (at !== e.text) why.set(e, "the string there is not the entry's text");
      else if (!isClaim(e.text)) why.set(e, 'the text matches no claim, so the entry exempts nothing');
    }
  }
  const stale = [
    ...[...allow.ids].filter((id) => !usedIds.has(id)).map((id) => `id ${id}: no question text under this id matches a claim`),
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
  for (const v of versionDirs(contentRoot)) {
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
    for (const file of ['documentHelp.json', 'reasonCodes.json']) {
      if (readJson(join(contentRoot, v, file)) === null) problems.push(`${v}/${file} is missing`);
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
    if (typeof entry?.path === 'string' && !/^(questionBank|assessmentAreas|documentHelp|reasonCodes|projectConfig)\.json#[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+|\[(0|[1-9][0-9]*)\])*$/.test(entry.path)) {
      problems.push(`${name}: path must be questionBank.json#, assessmentAreas.json#, documentHelp.json# or reasonCodes.json# and a JSON path such as areas[10].references[0].citation`);
    }
    if (typeof entry?.id === 'string' && !/^Q-\S+$/.test(entry.id)) {
      problems.push(`${name}: an id entry is accepted only for a question id (Q-...) and exempts only that question's text (AL-7); use { path, text, reason } for anything else`);
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
    file: 'app/(authenticated)/orgs/[slug]/projects/page.tsx',
    text: 'Completed',
    owner: 'the project pages (PRJ, Task 6)',
  },
  {
    file: 'components/dashboard/ProjectCard.tsx',
    text: 'Completed',
    owner: 'the project pages (PRJ, Task 6)',
  },
  {
    file: 'app/(public)/about/page.tsx',
    text: 'Reproducibility Failure',
    owner: 'C-TXT (the framework area name, which the About page lists by hand; rename together)',
  },
  {
    file: 'app/(public)/about/page.tsx',
    text: 'Model Robustness Failure',
    owner: 'C-TXT (the framework area name, as above)',
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
        .filter((s) => !s.insideClaimsAllowed && isClaim(s.text))
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
    for (const l of lines) expect(isClaim(l), l).toBe(true);
  });

  it('FR-PUB-01: every word of the SRS 7.5.3 list, and its forms, is flagged on a synthetic page that holds it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-words-'));
    try {
      mkdirSync(join(dir, 'app'));
      NEVER_LIST.forEach(([, sentence], i) =>
        writeFileSync(join(dir, 'app', `w${i}.tsx`), `export default function W() { return <main><p>${sentence}</p></main>; }\n`));
      writeFileSync(join(dir, 'app', 'ok.tsx'), `export default function W() { return <main>${MAY_APPEAR.map((t) => `<p>${t.replace(/\?/g, '')}</p>`).join('')}</main>; }\n`);
      const found = userFacingStrings([join(dir, 'app')]);
      expect(found.length, 'the scan read every synthetic page').toBeGreaterThanOrEqual(NEVER_LIST.length + MAY_APPEAR.length);
      const unflagged = NEVER_LIST.filter(([, sentence]) => !found.some((f) => f.text.trim() === sentence && isClaim(f.text))).map(([w]) => w);
      expect(unflagged, 'words of the SRS 7.5.3 list the phrase test does not catch').toEqual([]);
      const wrongly = MAY_APPEAR.map((t) => t.replace(/\?/g, '')).filter((t) => found.some((f) => f.text.trim() === t && isClaim(f.text)));
      expect(wrongly, 'ordinary words the phrase test flags').toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: a marker exempts the words of its element, not the spoken attributes on or inside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-attr-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(
        join(dir, 'app', 'a.tsx'),
        [
          'export const a = (',
          '  <p data-claims-allowed="not-an-approval-service" title="Certified by MAK-AI">',
          '    <span aria-label="ISO 42001 compliant">It is not an approval, audit, certification or compliance service.</span>',
          '    <img alt="Audit-ready" src="/x.png" />',
          '  </p>',
          ');',
        ].join('\n'),
      );
      const flagged = userFacingStrings([join(dir, 'app')]).filter((s) => !s.insideClaimsAllowed && isClaim(s.text)).map((s) => s.text);
      expect(flagged.sort()).toEqual(['Audit-ready', 'Certified by MAK-AI', 'ISO 42001 compliant']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: strings that are code are not read as words: class names with a modifier, CSS functions, console messages and states compared with ===', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-code-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(
        join(dir, 'app', 'code.tsx'),
        [
          'export const a = (ok: boolean) => (ok ? "badge--completed" : "badge--in-progress");',
          'export const b = "repeat(auto-fit, minmax(min(100%, 24rem), 1fr))";',
          'export function c() { console.error("evidence route: logSecurityEvent failed", 1); }',
          'export const e = (s: { status: string }) => s.status === "completed" || s.status !== "failed";',
          'export const d = <p>The review failed</p>;',
        ].join('\n'),
      );
      const flagged = userFacingStrings([join(dir, 'app')]).filter((s) => isClaim(s.text)).map((s) => s.text);
      expect(flagged).toEqual(['The review failed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: every data-claims-allowed marker states its reason, and the only markers are the four of the About page', () => {
    const markers = claimsAllowedMarkers(['app', 'components', 'lib']);
    expect(markers.filter((m) => m.reason === '').map((m) => m.file), 'a marker with no reason').toEqual([]);
    // Every marker in app and components is listed here with its file, so a new one fails until it is added with its
    // AL row (SRS 7.5.3). DOC-a adds AL-1 for the document pages in its own commit.
    const about = join('app', '(public)', 'about', 'page.tsx');
    expect(markers.map((m) => `${m.file} ${m.reason}`).sort()).toEqual(
      [`${about} about-model-scores`, `${about} about-model-scores`, `${about} not-an-approval-service`, `${about} why-no-score`].sort(),
    );   // why-no-score: the heading only
  });

  it('FR-PUB-01 FR-RM-01: data-source-note sits only on ReferencesList\'s relevance note, and only S-26 renders ReferencesList', () => {
    // The marker exempts a cited figure from the percentage checks (ruling 2), so it is fenced like data-claims-allowed:
    // anywhere else it would let "40% of your items" through. Review r1 I-2.
    expect(sourceNoteProblems(process.cwd(), ['app', 'components', 'lib'])).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'claims-note-'));
    try {
      mkdirSync(join(dir, 'components', 'report'), { recursive: true });
      mkdirSync(join(dir, 'app', 'x'), { recursive: true });
      writeFileSync(join(dir, 'components', 'report', 'ReferencesList.tsx'), [
        'export default function R({ ref }: { ref: { relevance: string; citation: string } }) {',
        '  return <p><span data-source-note="">{ref.relevance}</span><span data-source-note="">{ref.citation}</span></p>;',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'components', 'Count.tsx'), 'export const C = () => <span data-source-note="">40% of your items</span>;\n');
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'x.ts'), "export const k = 'data-source-note';\n");
      writeFileSync(join(dir, 'app', 'x', 'page.tsx'), "import R from '@/components/report/ReferencesList';\nexport default R;\n");
      writeFileSync(join(dir, 'app', 'x', 'other.tsx'), "export { default } from '../../components/report/ReferencesList';\n");
      expect(sourceNoteProblems(dir, ['app', 'components', 'lib']).sort()).toEqual([
        'app/x/other.tsx imports components/report/ReferencesList; only app/(authenticated)/explore/framework/page.tsx may',
        'app/x/page.tsx imports components/report/ReferencesList; only app/(authenticated)/explore/framework/page.tsx may',
        'components/Count.tsx: data-source-note is allowed only on ReferencesList\'s {ref.relevance} element',
        'components/report/ReferencesList.tsx: data-source-note is allowed only on ReferencesList\'s {ref.relevance} element',
        'lib/x.ts: the string "data-source-note" is allowed only as ReferencesList\'s attribute',
      ].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      const flagged = found.filter((s) => !s.insideClaimsAllowed && isClaim(s.text)).map((s) => s.text);
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
    for (const bad of ['PP-06', 'C-03', 'q-1', ' Q-1']) expect(allowlistProblems([{ id: bad, reason: 'r' }]).join(), bad).toMatch(/only for a question id/);
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

  it.skipIf(!due)('FR-PUB-01: no interim finding is left once the content is due: OWNED_ELSEWHERE is empty', () => {
    expect(OWNED_ELSEWHERE.map((o) => `${o.file}: "${o.text}" (${o.owner})`), 'strings other units still have to reword').toEqual([]);
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
      expect(contentShapeProblems(dir)).toEqual([
        '1.0.0/questionBank.json is missing',
        '1.0.0/assessmentAreas.json is missing',
        '1.0.0/documentHelp.json is missing',
        '1.0.0/reasonCodes.json is missing',
      ]);
      writeFileSync(join(dir, '1.0.0', 'documentHelp.json'), JSON.stringify({ data_card: 'Fine.' }));
      writeFileSync(join(dir, '1.0.0', 'reasonCodes.json'), JSON.stringify({ codes: [{ code: 'c', label: 'Fine' }] }));
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
  function plantedBundle(o: {
    questions?: Array<Record<string, unknown>>;
    areas?: Array<Record<string, unknown>>;
    module?: Record<string, unknown>;
    help?: Record<string, unknown>;
    codes?: Array<Record<string, unknown>>;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), 'claims-content-'));
    mkdirSync(join(dir, '9.9.9'));
    writeFileSync(
      join(dir, '9.9.9', 'questionBank.json'),
      JSON.stringify({ stages: { 'pre-processing': { modules: [{ id: 'M-1', title: 'Fine', description: 'Fine.', momentsOfBias: ['Fine'], ...o.module, questions: o.questions ?? [{ id: 'Q-PP-01', text: 'Fine.' }] }] } } }),
    );
    writeFileSync(
      join(dir, '9.9.9', 'assessmentAreas.json'),
      JSON.stringify({ areas: o.areas ?? [{ id: 'PP-01', name: 'Fine', description: 'Fine.' }], controls: [{ id: 'C-01', name: 'Fine' }] }),
    );
    writeFileSync(join(dir, '9.9.9', 'documentHelp.json'), JSON.stringify(o.help ?? { data_card: 'Fine.' }));
    writeFileSync(join(dir, '9.9.9', 'reasonCodes.json'), JSON.stringify({ codes: o.codes ?? [{ code: 'c1', status: 'not_applicable', label: 'Fine', useWhen: 'Fine.', reasonMustSay: 'Fine.' }] }));
    return dir;
  }

  it('FR-PUB-01: document help, reason codes and the module texts of the question bank are read too', () => {
    const dir = plantedBundle({
      module: { title: 'A scored module', description: 'Audit-ready.', momentsOfBias: ['Historical bias', 'Ranking bias'] },
      help: { data_card: 'Fine.', mitigation_plan: 'The platform gives no ratings.' },
      codes: [{ code: 'c1', status: 'not_applicable', label: 'Fine', useWhen: 'Approved by MAK-AI.', reasonMustSay: 'Why it passed.' }],
    });
    try {
      const r = scanContent(dir, allowFrom([]));
      expect(r.hits.map((h) => `${h.file}#${h.path}`)).toEqual([
        'questionBank.json#stages.pre-processing.modules[0].title',
        'questionBank.json#stages.pre-processing.modules[0].description',
        'questionBank.json#stages.pre-processing.modules[0].momentsOfBias[1]',
        'documentHelp.json#mitigation_plan',
        'reasonCodes.json#codes[0].useWhen',
        'reasonCodes.json#codes[0].reasonMustSay',
      ]);
      // A path entry reaches them; ids and keys are not read.
      const entry = { path: 'documentHelp.json#mitigation_plan', text: 'The platform gives no ratings.', reason: 'x' };
      expect(scanContent(dir, allowFrom([entry]))).toMatchObject({ stale: [] });
      expect(allowlistProblems([entry, { path: 'reasonCodes.json#codes[0].useWhen', text: 't', reason: 'r' }])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01: an id entry exempts the question\'s own text field, not an object under it, and the stage, principle and project texts are read', () => {
    const dir = plantedBundle({ questions: [{ id: 'Q-PO-22', text: 'Fine.', options: [{ text: 'Certified' }], principle: 'Rated fairness' }] });
    writeFileSync(join(dir, '9.9.9', 'projectConfig.json'), JSON.stringify({ projectName: 'Fine', description: 'A graded assessment.' }));
    const bank = JSON.parse(readFileSync(join(dir, '9.9.9', 'assessmentAreas.json'), 'utf8'));
    writeFileSync(join(dir, '9.9.9', 'assessmentAreas.json'), JSON.stringify({ ...bank, stages: { pre: { id: 'pre', label: 'Pre-processing', description: 'Audit-ready groundwork.' } } }));
    try {
      const r = scanContent(dir, allowFrom([{ id: 'Q-PO-22', reason: 'x' }]));
      expect(r.hits.map((h) => `${h.file}#${h.path}`).sort()).toEqual([
        'assessmentAreas.json#stages.pre.description',
        'projectConfig.json#description',
        'questionBank.json#stages.pre-processing.modules[0].questions[0].options[0].text',
        'questionBank.json#stages.pre-processing.modules[0].questions[0].principle',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      expect(missing.stale).toEqual(['id Q-PO-23: no question text under this id matches a claim']);
      // An id whose item no longer holds a claim is stale too.
      expect(scanContent(dir, allowFrom([{ id: 'Q-PP-01', reason: 'x' }])).stale).toEqual(['id Q-PP-01: no question text under this id matches a claim']);
      expect(scanContent(dir, allowFrom([{ id: 'Q-PO-22', reason: 'x' }])).stale).toEqual([]);
      // An id entry exempts the question's text and no other field of it (AL-7), and only a Q- id is accepted.
      const two = plantedBundle({ questions: [{ id: 'Q-PO-22', text: 'Do you check your compliance with the law?', helpText: 'Compliance is a floor.' }] });
      try {
        const r = scanContent(two, allowFrom([{ id: 'Q-PO-22', reason: 'x' }]));
        expect(r.hits.map((h) => h.where)).toEqual(['9.9.9/questionBank.json Q-PO-22.helpText']);
        expect(r.stale).toEqual([]);
      } finally {
        rmSync(two, { recursive: true, force: true });
      }
      const area = plantedBundle({ areas: [{ id: 'PP-01', name: 'Fine', description: 'Risk Scores' }] });
      try {
        expect(scanContent(area, allowFrom([{ id: 'PP-01', reason: 'x' }])).hits, 'an area id exempts nothing').toHaveLength(1);
      } finally {
        rmSync(area, { recursive: true, force: true });
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

  it("FR-PUB-01: a cited figure in a reference's relevance note passes; a % in a question or an area description, or a claim word in a note, is a hit", () => {
    // SRS 7.5.3 bans a percentage "next to the team's items"; a cited study's figure is not one (coordinator ruling 2).
    const dir = plantedBundle({
      questions: [{ id: 'Q-PP-01', text: 'Do 40% of your items have a decision?' }],
      areas: [{
        id: 'PP-01', name: 'Fine', description: 'Fine for 12% of rows.',
        references: [
          { citation: 'A clean title.', relevance: 'Error rates up to 34.7% for darker-skinned women against 0.8% for lighter-skinned men.' },
          { citation: 'Another clean title.', relevance: 'An empirical audit that found 3.3% label errors.' },
        ],
      }],
    });
    try {
      const hits = scanContent(dir, allowFrom([])).hits.map((h) => h.path);
      expect(hits.filter((p) => p.startsWith('areas')).sort()).toEqual(['areas[0].description', 'areas[0].references[1].relevance']);
      expect(hits.filter((p) => p.endsWith('questions[0].text'))).toHaveLength(1);
      expect(hits).toHaveLength(3);
      // The skip is the `%` alternative alone; it stays in step with the pattern it carves out.
      expect(NEVER_WORDS).toContain(SOURCE_NOTE_PERCENT_ALTERNATIVE);
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
      // An id exempts a question's text only: Q-PP-91's whyAsked, the area and the control stay hits.
      expect(scanContent(dir, ids('Q-PO-22', 'C-90', 'PP-90', 'Q-PP-90', 'Q-PP-91')).hits.map((h) => h.where)).toEqual([
        '9.9.9/questionBank.json Q-PP-91.whyAsked',
        '9.9.9/assessmentAreas.json areas[0].description',
        '9.9.9/assessmentAreas.json controls[0].resources[0].title',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
