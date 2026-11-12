import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, Stage } from '@/types/record';
import type { SaveDecisionRequest } from '@/types/api';
import type { Identity } from '@/lib/auth/identity';

const ctx = { orgId: 'o1', role: 'owner' } as unknown as OrgContext;
const actor: Actor = { userId: 'u1', role: 'owner' };
const tx = {} as unknown as TenantTx;
const REQ = '3f2b8c1e-5a47-4d0b-9e61-7c2d4a9b0f13';
const version = { id: 'v1', projectId: 'p', stage: 'pre-processing' as Stage, questionId: 'Q-PP-01', status: 'partly' as const, enteredById: 'u1' };
const body = { projectId: 'p' } as unknown as SaveDecisionRequest & { projectId: string };
const identity = { userId: 'u1' } as unknown as Identity;

const STAGE_LIST: Stage[] = ['pre-processing', 'in-processing', 'post-processing'];
const ZERO_COUNTS = {
  questions: 0, noDecision: 0, byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 },
  doneWithoutEvidence: 0, openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0,
  overdueMitigations: 0, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0,
};
const ZERO_COUNTS_BY_STAGE = Object.fromEntries(STAGE_LIST.map((s) => [s, ZERO_COUNTS]));

const PRODUCERS = ['DEC-a', 'FND-a', 'FND-b', 'FUP', 'REV-a', 'REV-b', 'DOC-a', 'DOC-b', 'PRJ', 'ORG', 'CNT', 'SUG', 'EVD', 'AUTHZ', 'EXP', 'ACC-a', 'MEM', 'DEC-b', 'UI'];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}
function grep(re: RegExp, dirs: string[]): string[] {
  return dirs.flatMap(filesUnder).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}`] : [])));
}

/**
 * Every `.ts` or `.tsx` file under `app`, `components` and `lib` that holds a `// CONTRACT_STUB: ` marker, found on disk
 * rather than listed by hand, so a marker in a new file is read by every case below (the database rule, the marker
 * position and the producer table). The disk is read, not git: an untracked file under those directories is scanned too,
 * so a local untracked file with a marker turns this red locally and not in CI. Ruling (controller).
 */
const STUB_FILES: readonly string[] = [...new Set(grep(/\/\/ CONTRACT_STUB: /, ['app', 'components', 'lib'])
  .map((hit) => hit.slice(0, hit.lastIndexOf(':'))))].filter((f) => /\.tsx?$/.test(f)).sort();

/**
 * The contract's "Typed stubs" table, one row per stubbed export, and the one place a unit name is
 * written next to an export. A row is checked only while its own marker sits directly above its
 * export (`stubbed`), so a producer that fills a body and deletes the marker never turns this red
 * (contract rule 6); the marker case below checks that each marker names this table's unit.
 */
type Row = { file: string; unit: string; fn: string; args: () => unknown[]; expected: 'throws' | unknown };
const EMPTY_BY_STAGE = Object.fromEntries(STAGE_LIST.map((s) => [s, []]));
const throws = 'throws' as const;
const ROWS: Row[] = [
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'saveDecision', args: () => [ctx, actor, body, 'd'], expected: throws },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'currentDecisions', args: () => [ctx, 'p', 'pre-processing'], expected: new Map() },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'onShortfallSaved', args: () => [tx, ctx, version, { requestId: REQ, digest: 'd' }], expected: null },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'listFindings', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'sealsIncludingRows', args: () => [ctx, ['a']], expected: new Map() },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'stageView', args: () => [ctx, 'p', '2026-11-02'], expected: ZERO_COUNTS_BY_STAGE },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'withdrawDecision', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'decisionHistory', args: () => [ctx, 'p', 'Q-PP-01'], expected: [] },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'currentDecisionRows', args: () => [tx, 'p', 'pre-processing'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'addMitigation', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'updateMitigation', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'acceptRisk', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'reopenFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'withdrawFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'closeByDecision', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'findingDetail', args: () => [ctx, 'p', 'f'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'mitigationHistory', args: () => [ctx, 'p', 'm'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'findingsToCloseByDecision', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'acceptedRisksToLookAgain', args: () => [ctx, 'p', '2026-11-02'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'openShortfallForQuestion', args: () => [ctx, 'p', 'Q-PP-01'], expected: null },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'mitigationOwnerCandidates', args: () => [ctx], expected: [] },
  { file: 'lib/data/teamFindings.ts', unit: 'FND-b', fn: 'raiseTeamFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'openMitigationsByStage', args: () => [ctx, 'p', '2026-11-02'], expected: EMPTY_BY_STAGE },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'myMitigations', args: () => [ctx, 'u1', '2026-11-02'], expected: [] },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'ownerCannotAct', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'stageFollowUpCounts', args: () => [ctx, 'p', 'pre-processing', '2026-11-02'], expected: { openFindings: 0, overdueMitigations: 0 } },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'sealStageReview', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'checkSeal', args: () => [ctx, 's'], expected: throws },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'listSeals', args: () => [ctx, 'r'], expected: [] },
  { file: 'lib/seal/ids.ts', unit: 'REV-a', fn: 'stageSnapshotIds', args: () => [tx, 'p', 'pre-processing'], expected: throws },
  { file: 'lib/seal/ids.ts', unit: 'REV-a', fn: 'manifestIds', args: () => [{}], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'openStageReview', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'sealPreview', args: () => [ctx, 'r'], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'listStageReviews', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'changedSinceSeal', args: () => [ctx, 'r'], expected: null },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'previewDocument', args: () => [ctx, actor, {}], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'issueDocument', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'listDocuments', args: () => [ctx, { projectId: 'p' }], expected: [] },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'readDocumentPdf', args: () => [ctx, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-b', fn: 'withdrawDocument', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-b', fn: 'readDocumentText', args: () => [ctx, 'd'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'archiveProject', args: () => [ctx, actor, 'p'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'unarchiveProject', args: () => [ctx, actor, 'p'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'projectHasRecords', args: () => [tx, 'p'], expected: throws },
  { file: 'lib/content/suggestions.ts', unit: 'SUG', fn: 'controlsForQuestion', args: () => [{}, 'Q-PP-01', []], expected: { first: [], rest: [] } },
  { file: 'lib/content/suggestions.ts', unit: 'SUG', fn: 'controlsForArea', args: () => [{}, 'A-1'], expected: [] },
  { file: 'lib/content/resources.ts', unit: 'CNT', fn: 'loadResources', args: () => [], expected: throws },
  // The four files the hand list missed (contract rule 5 and each function's own "Typed stubs" row): two list reads, a
  // page read, a single read that answers null for no label, and a single read that throws.
  { file: 'lib/data/evidence.ts', unit: 'EVD', fn: 'unattachedEvidence', args: () => [ctx, null, null], expected: [] },
  { file: 'lib/data/evidence.ts', unit: 'EVD', fn: 'unattachedEvidenceIn', args: () => [tx, null, null], expected: [] },
  { file: 'lib/data/orgEvents.ts', unit: 'ORG', fn: 'listOrganisationEvents', args: () => [ctx, { limit: 20 }], expected: { events: [], hasMore: false } },
  { file: 'lib/authz/roleLabel.ts', unit: 'AUTHZ', fn: 'orgRoleLabel', args: () => [identity, 'fixture-org'], expected: null },
  { file: 'lib/question/panel.ts', unit: 'DEC-b', fn: 'loadQuestionPanel', args: () => [ctx, identity, { projectId: 'p', stage: 'pre-processing', questionId: 'Q-PP-01' }], expected: throws },
];


/** True while `fn` is exported directly below its own `// CONTRACT_STUB: <unit>` marker in `file`. */
function stubbed(file: string, unit: string, fn: string): boolean {
  return new RegExp('// CONTRACT_STUB: ' + unit + '\\s*\\n\\s*export (async )?(function|const) ' + fn + '\\b').test(readFileSync(file, 'utf8'));
}

type StubMarker = { index: number; unit: string; fn: string };

/**
 * Every well-formed marker of `lines`, a line that is exactly `// CONTRACT_STUB: <UNIT>` (indent allowed, nothing after the
 * unit): its index, its unit, and the name exported on the line below ('(not an export)' when none). Any other line holding
 * `CONTRACT_STUB:` is not a marker, and `markerScanProblems` names it.
 */
function stubMarkers(lines: readonly string[]): StubMarker[] {
  return lines.flatMap((line, index) => {
    const marker = /^\s*\/\/ CONTRACT_STUB: (\S+)\s*$/.exec(line);
    if (!marker) return [];
    const fn = /^export (?:async )?(?:function|const) (\w+)/.exec(lines[index + 1] ?? '')?.[1] ?? '(not an export)';
    return [{ index, unit: marker[1], fn }];
  });
}

/**
 * What a stub's body must not contain: the tenant transaction, raw SQL, a model call on a transaction (`tx.model.method(`),
 * a transaction opened on any client, or a new client. The modules a stub may not use are `NO_STUB_MODULES`.
 */
const DATABASE = /\bwithOrg\s*\(|\$queryRaw|\$executeRaw|\$transaction\s*\(|\bnew PrismaClient\b|\btx\s*\.\s*\w+\s*\.\s*\w+\s*\(/;

/** The identity lane and connection modules (repository paths, no extension), which a stub may not use by any import form. */
const NO_STUB_MODULES = /^lib\/data\/(identity|preauth|connection|identityClient|identityReads)$/;

/** The repository path, without extension, an import specifier of `file` names; a package name is returned as it is. */
function moduleOf(spec: string, file: string): string {
  const path = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? relative(process.cwd(), resolve(dirname(file), spec)) : spec;
  return path.split(sep).join('/').replace(/\.(ts|tsx|js|mjs)$/, '');
}

/**
 * How the stub bodies of a file could reach a module they may not use: one pattern per local name the file imports from
 * `NO_STUB_MODULES` (named, renamed, default; a namespace as `ns.`), per local name of `withOrg` imported from
 * `lib/data/tenant` under another name, and per local name of its `appClient` (or `ns.appClient`). Type-only imports name
 * no value and are skipped.
 */
function importedDatabaseNames(lines: readonly string[], file: string): RegExp[] {
  const refs: RegExp[] = [];
  for (const m of lines.join('\n').matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const target = moduleOf(m[2], file);
    const banned = NO_STUB_MODULES.test(target);
    if (!banned && target !== 'lib/data/tenant') continue;
    // Comments inside the clause are dropped, and only identifier pieces are kept, so no comment text becomes a pattern.
    const clause = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const ns = /\*\s*as\s+(\w+)/.exec(clause)?.[1];
    const def = /^\s*(\w+)\s*(?:,|$)/.exec(clause)?.[1];
    const named = (/\{([^}]*)\}/.exec(clause)?.[1] ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '' && !/^type\s/.test(x))
      .map((x) => { const [orig, local] = x.split(/\s+as\s+/); return { orig: orig.trim(), local: (local ?? orig).trim() }; })
      .filter((n) => /^\w+$/.test(n.orig) && /^\w+$/.test(n.local));
    if (banned) {
      if (ns) refs.push(new RegExp(`\\b${ns}\\.`));
      if (def) refs.push(new RegExp(`\\b${def}\\b`));
      for (const n of named) refs.push(new RegExp(`\\b${n.local}\\b`));
    } else {
      // From the tenant module: withOrg under another name, and its client, which reaches every tenant table.
      if (ns) refs.push(new RegExp(`\\b${ns}\\.(?:withOrg|appClient)\\b`));
      for (const n of named) if (n.orig === 'withOrg' && n.local !== 'withOrg') refs.push(new RegExp(`\\b${n.local}\\s*\\(`));
      for (const n of named) if (n.orig === 'appClient') refs.push(new RegExp(`\\b${n.local}\\b`));
    }
  }
  return refs;
}

/**
 * The stubbed functions of `file` (its `lines`) whose body touches the database, by name. A stub's body is the export below
 * its `// CONTRACT_STUB:` marker, through any same-name overload signatures, to its own end (`declarationEnd`), never past
 * the next top-level export; a function its producer filled, its marker gone, is not read (contract rule 6). Caught in that
 * text: `DATABASE` (withOrg under any spacing, raw SQL, `tx.model.method(` across white space and lines, `$transaction(`,
 * `new PrismaClient`); a local name the file imports from `NO_STUB_MODULES`, `withOrg` under another name, or the tenant
 * `appClient`; a dynamic import of those modules, quoted or a template literal; and, in the body only (not the signature),
 * a same-file function or const, exported or not, overloads followed, that touches the database itself or through another,
 * to a fixed point. Not caught: a call through another module's function (`assertProjectWritable` reads the database, but
 * in its own file), a model call on a client other than `appClient` or on a variable not named `tx`, or behind a cast, an
 * import aliased through a re-export, an import clause the patterns cannot parse (it yields no names), a first line that
 * ends in `}` without closing the function, and a template literal holding a line of closers only.
 */
function databaseTouchingStubs(lines: readonly string[], file: string): string[] {
  const names = importedDatabaseNames(lines, file);
  const touches = (text: string) => DATABASE.test(text) || names.some((re) => re.test(text))
    || [...text.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].some((m) => NO_STUB_MODULES.test(moduleOf(m[1], file)));
  const extentAt = (start: number) => { const impl = implementationStart(lines, start); return { impl, end: declarationEnd(lines, impl) }; };
  const textAt = (start: number) => lines.slice(start, extentAt(start).end + 1).join('\n');
  // Same-file names are followed in the body only, so a parameter named like a filled function names nothing.
  const bodyAt = (start: number) => { const { impl, end } = extentAt(start); return bodyText(lines, impl, end); };
  // Every top-level function or const of the file, exported or not (the first declaration of a name, so an overload run once).
  const declarations = new Map<string, { text: string; body: string }>();
  lines.forEach((line, i) => {
    const name = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line)?.[1] ?? /^(?:export\s+)?(?:const|let)\s+(\w+)\b/.exec(line)?.[1];
    if (name !== undefined && !declarations.has(name)) declarations.set(name, { text: textAt(i), body: bodyAt(i) });
  });
  // Those that touch the database themselves, or by naming one that does, to a fixed point.
  const touching = new Set<string>();
  const namesTouching = (text: string, self: string) => [...touching].some((g) => g !== self && new RegExp(`\\b${g}\\b`).test(text));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, { text, body }] of declarations) {
      if (!touching.has(name) && (touches(text) || namesTouching(body, name))) { touching.add(name); grew = true; }
    }
  }
  return stubMarkers(lines).flatMap(({ index, fn }) => {
    const start = index + 1;
    return touches(textAt(start)) || namesTouching(bodyAt(start), fn) ? [fn === '(not an export)' ? `(line ${start + 1})` : fn] : [];
  });
}

/**
 * The body of the declaration from `start` to `end`, without its signature: after the `{` that opens it; inside the outer
 * braces of a function that closes on its own line; after the first `=>` outside parentheses for a brace-less arrow; after
 * the first `=` for an alias (`export const f = impl;`).
 */
function bodyText(lines: readonly string[], start: number, end: number): string {
  for (let j = start; j <= end; j += 1) {
    const t = lines[j].replace(/\s+\/\/.*$/, '').trimEnd();
    if (t.endsWith('{')) return lines.slice(j + 1, end + 1).join('\n');
    if (!t.endsWith(';') && !(j === start && t.endsWith('}'))) continue;
    const head = lines.slice(start, j + 1).join('\n');
    if (!t.endsWith(';')) {
      for (let i = head.length - 1, depth = 0; i >= 0; i -= 1) {
        if (head[i] === '}') depth += 1;
        else if (head[i] === '{' && (depth -= 1) === 0) return head.slice(i + 1);
      }
      return head;
    }
    let depth = 0;
    for (let i = 0; i < head.length; i += 1) {
      if (head[i] === '(') depth += 1;
      else if (head[i] === ')') depth -= 1;
      else if (depth === 0 && head.startsWith('=>', i)) return head.slice(i + 2);
    }
    const eq = head.search(/=(?![=>])/);
    return eq === -1 ? head : head.slice(eq + 1);
  }
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Where the implementation of the function declared at `start` begins: past a run of same-name `(export )?(async )?function`
 * overload signatures, exported or not, each ending in `;`, to the declaration that carries the body. Anything else begins
 * at `start`.
 */
function implementationStart(lines: readonly string[], start: number): number {
  const name = /^(?:export )?(?:async )?function (\w+)/.exec(lines[start] ?? '')?.[1];
  if (name === undefined) return start;
  const sameName = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`);
  let cur = start;
  for (;;) {
    const end = declarationEnd(lines, cur);
    if (!lines[end].replace(/\s+\/\/.*$/, '').trimEnd().endsWith(';') || !sameName.test(lines[end + 1] ?? '')) return cur;
    cur = end + 1;
  }
}

/**
 * The last line of the top-level declaration starting at `start`, never past the next top-level export. The first line
 * from `start` that ends in `{`, `}` or `;` decides its shape: `;` ends it there (a brace-less arrow, an alias, a one-line
 * declaration ending `};`); `}` on the first line ends it there (it closed on its own line); `{` opens a body, which ends
 * at a column-0 line of closers only (`}`, `};`, `});`, `]);`).
 */
function declarationEnd(lines: readonly string[], start: number): number {
  const nextIsExport = (k: number) => (lines[k + 1] ?? '').startsWith('export ');
  for (let j = start; j < lines.length; j += 1) {
    // The shape is read without a trailing line comment (`{ // EVD fills` still opens a body).
    const t = lines[j].replace(/\s+\/\/.*$/, '').trimEnd();
    if (t.endsWith(';') || (j === start && t.endsWith('}'))) return j;
    if (t.endsWith('{')) {
      let k = j;
      // A column-0 line of closers only (`}`, `};`, `});`, `]);`) ends it; `}): Promise<...> {` and `}> {` do not.
      while (k + 1 < lines.length && !(k > j && /^[}\])]+;?\s*$/.test(lines[k])) && !nextIsExport(k)) k += 1;
      return k;
    }
    if (nextIsExport(j)) return j;
  }
  return lines.length - 1;
}

/**
 * What is wrong with the marker scan of the tree at `root`, with no marker needed (the last producer's merge, V and RC
 * leave none): the walk read no file under `lib`, or a line holding `CONTRACT_STUB:` is not a marker `stubMarkers`
 * parses (named `file:line`). Read from disk, as the scan is.
 */
function markerScanProblems(root: string): string[] {
  const dirs = ['app', 'components', 'lib'].map((d) => join(root, d));
  const problems = filesUnder(join(root, 'lib')).length === 0 ? ['the walk read no file under lib'] : [];
  const parsed = new Set(dirs.flatMap(filesUnder).flatMap((f) => stubMarkers(readFileSync(f, 'utf8').split('\n')).map((m) => `${f}:${m.index + 1}`)));
  for (const hit of grep(/CONTRACT_STUB:/, dirs)) if (!parsed.has(hit)) problems.push(`${hit}: not a marker of the form // CONTRACT_STUB: <UNIT>`);
  return problems;
}

/** `databaseTouchingStubs` over a file on disk. */
const touchingStubsOf = (file: string) => databaseTouchingStubs(readFileSync(file, 'utf8').split('\n'), file);

/** The release case reads the list strictly: a missing export is a failure, never an empty list. */
function pendingRoutesOf(lists: { PENDING_ROUTES?: readonly string[] }): readonly string[] {
  if (!Array.isArray(lists.PENDING_ROUTES)) throw new Error('lib/authz/routeActions.ts does not export PENDING_ROUTES');
  return lists.PENDING_ROUTES;
}

describe('no contract stubs', () => {
  it('NFR-MNT-01 (release): the release case fails when PENDING_ROUTES is not exported, instead of reading it as empty', () => {
    expect(() => pendingRoutesOf({})).toThrow(/does not export PENDING_ROUTES/);
    expect(() => pendingRoutesOf({ PENDING_ROUTES: undefined })).toThrow(/does not export PENDING_ROUTES/);
    expect(() => pendingRoutesOf({ PENDING_ROUTES: 'app/x' as unknown as string[] })).toThrow(/does not export PENDING_ROUTES/);
    expect(pendingRoutesOf({ PENDING_ROUTES: [] })).toEqual([]);
    expect(pendingRoutesOf({ PENDING_ROUTES: ['app/x/route.ts'] })).toEqual(['app/x/route.ts']);
  });

  // An unset run reports this case as skipped, not passed: a release candidate runs it with RELEASE_CANDIDATE=1.
  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-MNT-01 (release): no CONTRACT_STUB or SLOT_STUB marker and no pending route remains', async () => {
    expect(grep(/CONTRACT_STUB|SLOT_STUB/, ['app', 'components', 'lib'])).toEqual([]);
    const lists = (await import('@/lib/authz/routeActions')) as { PENDING_ROUTES?: readonly string[] };
    expect(pendingRoutesOf(lists)).toEqual([]);
  });

  for (const r of ROWS) {
    it(`NFR-MNT-01: ${r.file} ${r.fn} (${r.unit}) ${r.expected === 'throws' ? 'throws NotImplementedError' : 'returns the empty value'} while its marker is in place`, async (ctx) => {
      // A producer that filled the function deleted its marker (contract rule 6): the row reports skipped, not passed.
      if (!stubbed(r.file, r.unit, r.fn)) ctx.skip('filled');
      const mod = (await import(/* @vite-ignore */ '@/' + r.file.replace(/\.ts$/, ''))) as Record<string, (...a: unknown[]) => unknown>;
      const call = async () => mod[r.fn](...r.args());
      if (r.expected === 'throws') {
        await expect(call()).rejects.toMatchObject({ status: 501, code: 'not_implemented', extra: { unit: r.unit } });
      } else {
        expect(await call()).toEqual(r.expected);
      }
    });
  }

  it('NFR-MNT-01: every CONTRACT_STUB marker names the producer the table gives for the export below it', () => {
    const seen: Array<{ file: string; fn: string; marker: string; row: string | undefined }> = [];
    for (const file of STUB_FILES) {
      for (const { unit, fn } of stubMarkers(readFileSync(file, 'utf8').split('\n'))) {
        seen.push({ file, fn, marker: unit, row: ROWS.find((r) => r.file === file && r.fn === fn)?.unit });
      }
    }
    expect(markerScanProblems('.')).toEqual([]);
    for (const s of seen) expect(s, `${s.file} ${s.fn}`).toEqual({ ...s, row: s.marker });
    for (const r of ROWS) expect(PRODUCERS, `${r.file} ${r.fn}`).toContain(r.unit);
    // a row that is still stubbed has the marker for its own producer (stubbed() is the one gate every case uses)
    for (const r of ROWS) if (stubbed(r.file, r.unit, r.fn)) expect(seen.some((s) => s.file === r.file && s.fn === r.fn && s.marker === r.unit), `${r.file} ${r.fn}`).toBe(true);
  });

  describe('the marker scan needs no marker to be sound', () => {
    let root: string;
    beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'no-contract-stubs-tree-')); });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('NFR-MNT-01 (release): a tree with no marker left passes, so the last producer, V and RC are not blocked', () => {
      const tree = join(root, 'no-markers');
      mkdirSync(join(tree, 'lib', 'data'), { recursive: true });
      writeFileSync(join(tree, 'lib', 'data', 'filled.ts'), 'export async function filled(): Promise<number> {\n  return 1;\n}\n');
      expect(markerScanProblems(tree)).toEqual([]);
    });

    it('NFR-MNT-01: a line holding CONTRACT_STUB: that is not exactly // CONTRACT_STUB: <UNIT> is refused, naming its file and line', () => {
      const forms: Array<[string, string]> = [['two-spaces', '//  CONTRACT_STUB: DEC-a'], ['no-unit', '// CONTRACT_STUB:'], ['trailing-text', '// CONTRACT_STUB: DEC-a until Task 3']];
      for (const [name, marker] of forms) {
        const tree = join(root, name);
        mkdirSync(join(tree, 'lib'), { recursive: true });
        writeFileSync(join(tree, 'lib', 'stub.ts'), `${marker}\nexport async function f(): Promise<unknown[]> {\n  return [];\n}\n`);
        expect(markerScanProblems(tree), name).toEqual([`${join(tree, 'lib', 'stub.ts')}:1: not a marker of the form // CONTRACT_STUB: <UNIT>`]);
      }
    });

    it('NFR-MNT-01: a tree whose lib the walk cannot read fails, so an empty scan is never read as a clean one', () => {
      const tree = join(root, 'no-lib');
      mkdirSync(join(tree, 'app'), { recursive: true });
      expect(markerScanProblems(tree)).toEqual(['the walk read no file under lib']);
    });
  });

  describe('the database rule reads each stub, not its file', () => {
    let dir: string;
    const scratch = (name: string, src: string) => { const f = join(dir, name); writeFileSync(f, src); return f; };
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'no-contract-stubs-')); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const scan = (name: string, src: readonly string[]) => touchingStubsOf(scratch(name, src.join('\n')));
    const TENANT = "import { withOrg } from '@/lib/data/tenant';";

    it('NFR-MNT-01: a stub may not use the identity, preauth or connection modules, by any import form; a filled function beside it may', () => {
      expect(scan('identity-named.ts', ["import { lookupUserNames } from '@/lib/data/identity';", '// CONTRACT_STUB: DEC-a',
        'export async function names(): Promise<unknown> {', "  return lookupUserNames(['u']);", '}', ''])).toEqual(['names']);
      expect(scan('preauth-renamed.ts', ["import { bootstrapOrgWithOwner as make } from '@/lib/data/preauth';", '// CONTRACT_STUB: DEC-a',
        'export async function makeOne(): Promise<unknown> {', '  return make as unknown;', '}', ''])).toEqual(['makeOne']);
      expect(scan('connection-dynamic.ts', ['// CONTRACT_STUB: DEC-a', 'export async function url(): Promise<unknown> {',
        "  const { requireDatabaseUrl } = await import('@/lib/data/connection');", "  return requireDatabaseUrl('APP_DATABASE_URL');", '}', ''])).toEqual(['url']);
      expect(scan('identity-namespace.ts', ["import * as identity from '@/lib/data/identity';", "import { identityLaneClient } from '@/lib/data/identityClient';",
        '// CONTRACT_STUB: DEC-a', 'export async function viaNamespace(): Promise<unknown> {', "  return identity.lookupUserNames(['u']);", '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function viaLaneClient(): Promise<unknown> {', '  return identityLaneClient;', '}', ''])).toEqual(['viaNamespace', 'viaLaneClient']);
      expect(scan('withorg-forms.ts', ["import { withOrg as w } from '@/lib/data/tenant';", '// CONTRACT_STUB: DEC-a',
        'export async function renamed(ctx: unknown): Promise<unknown> {', '  return w(ctx as never, async () => 1);', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function spaced(ctx: unknown): Promise<unknown> {', '  return withOrg (ctx as never, async () => 1);', '}', ''])).toEqual(['renamed', 'spaced']);
      expect(scan('identity-filled.ts', ["import { lookupUserNames } from '@/lib/data/identity';", '',
        'export async function filledNames(): Promise<unknown> {', "  return lookupUserNames(['u']);", '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function names(): Promise<unknown[]> {', '  return [];', '}', ''])).toEqual([]);
    });

    it('NFR-MNT-01: a stub may not reach the database through a same-file function, directly, by alias or in steps; a pure helper is fine', () => {
      expect(scan('helpers.ts', [TENANT, '',
        'async function load(ctx: unknown): Promise<unknown[]> {', '  return withOrg(ctx as never, async () => []);', '}', '',
        'function viaLoad(ctx: unknown): Promise<unknown[]> {', '  return load(ctx);', '}', '',
        'function pure(n: number): number {', '  return n + 1;', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function callsLoad(ctx: unknown): Promise<unknown[]> {', '  return load(ctx);', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export const aliased = load;', '',
        '// CONTRACT_STUB: DEC-a', 'export async function twoSteps(ctx: unknown): Promise<unknown[]> {', '  return viaLoad(ctx);', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function callsPure(): Promise<number> {', '  return pure(1);', '}', '']))
        .toEqual(['callsLoad', 'aliased', 'twoSteps']);
    });

    it('NFR-MNT-01: a top-level const that closes on }); ends there, so a filled function below it is not read as the const', () => {
      for (const filled of ['async function filledLoad', 'export async function filledLoad']) {
        expect(scan(`const-closer-${filled.length}.ts`, [TENANT, 'const CONFIG = Object.freeze({', '  a: 1,', '});', '',
          `${filled}(ctx: unknown): Promise<unknown> {`, '  return withOrg(ctx as never, async () => 1);', '}', '',
          '// CONTRACT_STUB: DEC-a', 'export async function config(): Promise<unknown> {', '  return CONFIG;', '}', '']), filled).toEqual([]);
      }
    });

    it('NFR-MNT-01: a stub may not use the tenant client, or a model call split over lines', () => {
      expect(scan('app-client.ts', ["import { appClient } from '@/lib/data/tenant';", "import * as tenant from '@/lib/data/tenant';",
        '// CONTRACT_STUB: DEC-a', 'export async function viaClient(): Promise<unknown> {', '  return appClient.decision.findMany();', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function viaNamespace(): Promise<unknown> {', '  return tenant.appClient;', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function split(tx: { decision: { findMany: () => unknown } }): Promise<unknown> {',
        '  return tx', '    .decision', '    .findMany();', '}', ''])).toEqual(['viaClient', 'viaNamespace', 'split']);
    });

    it('NFR-MNT-01: a same-file name is followed only in a stub body, not in its signature', () => {
      expect(scan('param-named-like-helper.ts', [TENANT, 'export async function load(ctx: unknown): Promise<unknown> {',
        '  return withOrg(ctx as never, async () => 1);', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function list(load: unknown): Promise<unknown[]> {', '  return [];', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export const arrow = async (load: unknown): Promise<unknown[]> => [];', ''])).toEqual([]);
    });

    it('NFR-MNT-01: a stub may not reach the database through a private overloaded helper', () => {
      expect(scan('private-overloads.ts', [TENANT, 'function load(ctx: string): Promise<unknown>;', 'function load(ctx: number): Promise<unknown>;',
        'function load(ctx: unknown): Promise<unknown> {', '  return withOrg(ctx as never, async () => 1);', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function list(ctx: unknown): Promise<unknown> {', '  return load(ctx as string);', '}', ''])).toEqual(['list']);
    });

    it('NFR-MNT-01: a stub may not call a model on a transaction, open a transaction or make a client', () => {
      expect(scan('model-call.ts', ['// CONTRACT_STUB: DEC-a', 'export async function direct(tx: { decision: { findMany: () => unknown } }): Promise<unknown> {', '  return tx.decision.findMany();', '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function opens(c: { $transaction: (f: () => unknown) => unknown }): Promise<unknown> {', '  return c.$transaction(async () => 1);', '}', '',
        "import { PrismaClient } from '@prisma/client';", '// CONTRACT_STUB: DEC-a', 'export async function client(): Promise<unknown> {', '  return new PrismaClient();', '}', '']))
        .toEqual(['direct', 'opens', 'client']);
    });

    it('NFR-MNT-01: a line comment after an opening brace does not hide the body', () => {
      expect(scan('trailing-comment.ts', [TENANT, '// CONTRACT_STUB: EVD', 'export async function f(ctx: unknown): Promise<unknown> { // EVD fills this',
        '  const n = 1;', '  return withOrg(ctx as never, async () => n);', '}', ''])).toEqual(['f']);
    });

    it('NFR-MNT-01: an import clause with comments inside it, and a template-literal dynamic import, are still read', () => {
      expect(scan('commented-import.ts', ['import {', '  lookupUserNames, // feeds names to lookupUserNames( calls', '  /* the lane */ identityDb,',
        "} from '@/lib/data/identity';", '// CONTRACT_STUB: DEC-a', 'export async function names(): Promise<unknown> {', "  return lookupUserNames(['u']);", '}', '',
        '// CONTRACT_STUB: DEC-a', 'export async function lane(): Promise<unknown> {', '  return identityDb;', '}', ''])).toEqual(['names', 'lane']);
      expect(scan('template-import.ts', ['// CONTRACT_STUB: DEC-a', 'export async function url(): Promise<unknown> {',
        '  const m = await import(`@/lib/data/connection`);', '  return m;', '}', ''])).toEqual(['url']);
    });

    it('NFR-MNT-01: an overloaded stub is read through its overload signatures to the implementation body', () => {
      expect(scan('overloads.ts', [TENANT, '// CONTRACT_STUB: DEC-a', 'export function pick(a: string): Promise<string>;',
        'export function pick(a: number): Promise<number>;', 'export function pick(a: string | number): Promise<unknown> {',
        '  return withOrg(a as never, async () => a);', '}', ''])).toEqual(['pick']);
    });

    it('NFR-MNT-01: a stub that closes on its own line, or a brace-less arrow, is read only to its own end', () => {
      expect(scan('one-line.ts', [TENANT, '// CONTRACT_STUB: DEC-a', 'export async function listThings(): Promise<unknown[]> { return []; }', '',
        '/** Callers wrap it in withOrg(ctx, ...); this comment is not the stub. */', 'export async function other(ctx: unknown): Promise<unknown> {',
        '  return withOrg(ctx as never, async () => 1);', '}', ''])).toEqual([]);
      expect(scan('arrow-then-export.ts', [TENANT, '// CONTRACT_STUB: DEC-a', 'export const listThings = async (): Promise<unknown[]> => [];',
        'export async function filled(ctx: unknown): Promise<unknown> {', '  return withOrg(ctx as never, async () => 1);', '}', ''])).toEqual([]);
      expect(scan('arrow-then-helper.ts', [TENANT, '// CONTRACT_STUB: DEC-a', 'export const listThings = async (): Promise<unknown[]> =>', '  [];',
        'function unrelated(ctx: unknown): Promise<unknown> {', '  return withOrg(ctx as never, async () => 1);', '}', ''])).toEqual([]);
    });

    it('NFR-MNT-01: a stub body is read to its own closer, past a signature or return type that starts a line with }', () => {
      expect(scan('house-style-params.ts', [TENANT, '// CONTRACT_STUB: DEC-a',
        'export async function listThings(p: {', '  a: string;', '}): Promise<unknown[]> {', '  return withOrg(p as never, async () => []);', '}', ''])).toEqual(['listThings']);
      expect(scan('object-return.ts', ['// CONTRACT_STUB: DEC-a',
        'export async function countThings(tx: { $queryRaw: unknown }): Promise<{', '  n: number;', '}> {',
        '  return (tx as never as { $queryRaw: (s: TemplateStringsArray) => { n: number } }).$queryRaw`SELECT 1 AS n`;', '}', ''])).toEqual(['countThings']);
      expect(scan('template-brace.ts', [TENANT, '// CONTRACT_STUB: DEC-a',
        'export async function quoted(ctx: unknown): Promise<unknown> {', '  const sql = `', '}`;', '  return withOrg(ctx as never, async () => sql);', '}', ''])).toEqual(['quoted']);
    });

    it('NFR-MNT-01: a stubbed function whose body calls withOrg or raw SQL is refused', () => {
      const f = scratch('stubbed.ts', [
        "import { withOrg } from '@/lib/data/tenant';",
        '// CONTRACT_STUB: DEC-a',
        'export async function listThings(ctx: unknown): Promise<unknown[]> {',
        '  return withOrg(ctx as never, async (tx) => tx.$queryRaw`SELECT 1`);',
        '}',
        '',
      ].join('\n'));
      expect(touchingStubsOf(f)).toEqual(['listThings']);
    });

    it('NFR-MNT-01: a filled function may call withOrg and raw SQL; only the stub left beside it is read', () => {
      const f = scratch('filled.ts', [
        "import { withOrg } from '@/lib/data/tenant';",
        '',
        '/** Filled by its producer: its marker is gone. */',
        'export async function saveThing(ctx: unknown): Promise<number> {',
        '  return withOrg(ctx as never, async (tx) => tx.$executeRaw`INSERT INTO t VALUES (1)`);',
        '}',
        '',
        '// CONTRACT_STUB: DEC-a',
        'export async function listThings(ctx: unknown): Promise<unknown[]> {',
        '  return [];',
        '}',
        '',
        '/** Read inside withOrg(ctx, ...) by its caller; this comment is not a stub body. */',
        'export async function countThings(ctx: unknown): Promise<number> {',
        '  return withOrg(ctx as never, async (tx) => (await tx.$queryRaw<{ n: number }[]>`SELECT 1 AS n`)[0].n);',
        '}',
        '',
      ].join('\n'));
      expect(touchingStubsOf(f)).toEqual([]);
    });
  });

  it('NFR-MNT-01: a stub is a function whose marker is the line directly above its export, and no stub touches the database', () => {
    for (const f of STUB_FILES) {
      const lines = readFileSync(f, 'utf8').split('\n');
      for (const { index } of stubMarkers(lines)) {
        expect({ f, line: index + 1, nextLine: (lines[index + 1] ?? '').startsWith('export ') }).toEqual({ f, line: index + 1, nextLine: true });
      }
      // a stub reads and writes nothing; a function its producer has filled (its marker gone) may
      expect(databaseTouchingStubs(lines, f), f).toEqual([]);
    }
  });
});
