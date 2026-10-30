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
 * `CLAIMS` is the SRS pattern (FR-PUB-01, SRS line 1103) with `\bscored\b` and
 * `\breadiness report\b` added: the SRS pattern as written does not match one
 * of the strings its own *Why* cites ("scored against responsible AI
 * principles. At the end, you get a readiness report"), so the fixture test
 * below would pass vacuously on the pattern alone (owner question B26).
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
const CLAIMS =
  /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|\bscored\b|\breadiness report\b|cannot see your records/i;

type Hit = { where: string; text: string };

/** Every line of `text` that matches, with its position. */
function matchIn(where: string, text: string): Hit[] {
  return text
    .split('\n')
    .map((line, i) => ({ where: `${where}:${i + 1}`, text: line.trim() }))
    .filter((h) => CLAIMS.test(h.text));
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

function isCodeString(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
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

// --- Content texts, per version directory ----------------------------------

type AllowEntry = { id: string; reason: string };

const QUESTION_FIELDS = ['text', 'helpText', 'example', 'options', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples'];

/** Every string anywhere under `value`, with the id of the nearest object that has one. */
function stringsUnder(value: unknown, where: string, ownerId: string | null, out: Array<Hit & { id: string | null }>): void {
  if (typeof value === 'string') out.push({ where, text: value, id: ownerId });
  else if (Array.isArray(value)) value.forEach((v, i) => stringsUnder(v, `${where}[${i}]`, ownerId, out));
  else if (value && typeof value === 'object') {
    const id = typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : ownerId;
    for (const [k, v] of Object.entries(value)) stringsUnder(v, `${where}.${k}`, id, out);
  }
}

/** Question objects (an `id` starting `Q-`), found at any depth, so the check does not depend on how a bundle nests its stages. */
function questionsIn(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) value.forEach((v) => questionsIn(v, out));
  else if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('Q-')) out.push(value as Record<string, unknown>);
    else Object.values(value).forEach((v) => questionsIn(v, out));
  }
  return out;
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The claim hits in every `<contentRoot>/<semver>/` directory, skipping allow-listed ids. */
function contentClaimHits(contentRoot: string, allowIds: Set<string>): Hit[] {
  const hits: Hit[] = [];
  const versions = existsSync(contentRoot)
    ? readdirSync(contentRoot).filter((n) => statSync(join(contentRoot, n)).isDirectory())
    : [];
  for (const v of versions) {
    const dir = join(contentRoot, v);
    for (const q of questionsIn(readJson(join(dir, 'questionBank.json')))) {
      if (allowIds.has(q.id as string)) continue;
      const strings: Array<Hit & { id: string | null }> = [];
      for (const f of QUESTION_FIELDS) if (f in q) stringsUnder(q[f], `${v}/questionBank.json ${q.id}.${f}`, q.id as string, strings);
      hits.push(...strings.filter((s) => CLAIMS.test(s.text)));
    }
    const strings: Array<Hit & { id: string | null }> = [];
    const areas = readJson(join(dir, 'assessmentAreas.json')) as { areas?: unknown; controls?: unknown } | null;
    stringsUnder(areas?.areas, `${v}/assessmentAreas.json areas`, null, strings);
    stringsUnder(areas?.controls, `${v}/assessmentAreas.json controls`, null, strings);
    hits.push(...strings.filter((s) => !(s.id && allowIds.has(s.id)) && CLAIMS.test(s.text)));
  }
  return hits.map(({ where, text }) => ({ where, text }));
}

function readAllowlist(path: string): AllowEntry[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of { id, reason }`);
  return raw as AllowEntry[];
}

// --- The tests ------------------------------------------------------------

describe('no product claims', () => {
  it('FR-PUB-01: no product claim in the package description, the README, or any user-facing string in app and components', () => {
    const hits = [
      ...matchIn('package.json description', JSON.parse(readFileSync('package.json', 'utf8')).description),
      ...matchIn('README.md', readFileSync('README.md', 'utf8')),
      ...userFacingStrings(['app', 'components'])
        .filter((s) => !s.insideClaimsAllowed)
        .map(({ where, text }) => ({ where, text })),
    ].filter((s) => CLAIMS.test(s.text));
    expect(hits).toEqual([]);
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

  it('FR-PUB-01: the allow-list holds only { id, reason } entries, each with a reason', () => {
    const entries = readAllowlist('__tests__/lint/claim-allowlist.json');
    for (const e of entries) {
      expect(typeof e.id, JSON.stringify(e)).toBe('string');
      expect(typeof e.reason === 'string' && e.reason.trim().length > 0, `${e.id} needs a reason`).toBe(true);
    }
    expect(new Set(entries.map((e) => e.id)).size, 'an id is listed twice').toBe(entries.length);
  });

  it('FR-PUB-01: content question texts are checked, except the ids that ask the team about its own practice', () => {
    const root = join(process.cwd(), 'data', 'content');
    const versions = existsSync(root)
      ? readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory())
      : [];
    if (versions.length === 0) {
      // Content 5.0.0 arrives with the content units; a release candidate without it is not a candidate.
      expect(process.env.RELEASE_CANDIDATE, 'RELEASE_CANDIDATE=1 and no data/content/<semver>/ directory').not.toBe('1');
    }
    const allow = new Set(readAllowlist('__tests__/lint/claim-allowlist.json').map((e) => e.id));
    expect(contentClaimHits(root, allow)).toEqual([]);
  });

  it('FR-PUB-01: the content check flags a question text and skips an allow-listed id', () => {
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
      const hits = contentClaimHits(dir, new Set(['Q-PO-22'])).map((h) => h.where);
      expect(hits).toEqual([
        '9.9.9/questionBank.json Q-PP-90.text',
        '9.9.9/questionBank.json Q-PP-91.whyAsked',
        '9.9.9/assessmentAreas.json areas[0].description',
        '9.9.9/assessmentAreas.json controls[0].resources[0].title',
      ]);
      // `gaps` is not a text field, so 'certification' in it is not read.
      expect(hits.join()).not.toContain('gaps');
      // Allow-listing a control id skips every string under it.
      expect(contentClaimHits(dir, new Set(['Q-PO-22', 'C-90', 'PP-90', 'Q-PP-90', 'Q-PP-91']))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
