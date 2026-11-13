#!/usr/bin/env node
/**
 * Writes the stage of each defect in CONSOLIDATED section 7 (plan 1A, Task 0, Step 4).
 *
 *   node scripts/redesign/defect-stages.mjs <CONSOLIDATED.md> <screen-stages.md> <app-dir> <assignments.json> > defect-stages.md
 *
 * The stage comes from the checked-in assignment file (stage 0's Appendix A assigns by the defect's kind, which
 * an import walk cannot see; plan 1A line 923 says Appendix A governs). The import walk is kept as an
 * information column: for each backticked path in the "Where" cell, a route file takes its route's restructure
 * stage, and any other source file the earliest stage among the route files that import it, transitively
 * (ts.preProcessFile). A difference between the walk and the assignment is information, not a failure.
 * Exits 1 when section 7 is not exactly rows 1 to 55, a screen-stages.md row cannot be read, or the assignment
 * file leaves a defect unassigned, names an unknown or repeated number, a bad stage, or an empty source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { routeFiles, routeLabel } from './screen-stages.mjs';

const ORDER = ['0', '1A', '1B', '1C', '2', '3'];
const SOURCE_EXT = /\.(tsx?|mjs|cjs|jsx?|css)$/;
const PATH_LIKE = /\.(tsx?|mjs|cjs|jsx?|css|json|md|txt|html|conf|sh|ipynb|ts)$/;

const rank = (stage) => ORDER.indexOf(stage);
const earliest = (stages) => [...stages].sort((a, b) => rank(a) - rank(b))[0];

/** The rows of CONSOLIDATED section 7's table. Throws unless the section exists and holds rows 1 to 55. */
export function parseDefects(markdown) {
  const parts = markdown.split(/^## 7\. /m);
  if (parts.length < 2) throw new Error('CONSOLIDATED has no "## 7. " section marker');
  const section = parts[1].split(/^## 8\. /m)[0];
  const rows = [];
  for (const line of section.split('\n')) {
    const m = /^\| (\d+) \| (.*) \| (.*) \| (.*) \|$/.exec(line);
    if (m) rows.push({ id: Number(m[1]), defect: m[2], where: m[3], foundBy: m[4] });
  }
  const ok = rows.length === 55 && rows.every((r, i) => r.id === i + 1);
  if (!ok) throw new Error(`section 7 must hold exactly 55 rows numbered 1 to 55; found ${rows.length} rows (${rows.map((r) => r.id).join(',')})`);
  return rows;
}

/** Problems with the assignment file against the defects, as messages; empty when all 55 are assigned. */
export function checkAssignments(assignments, defects) {
  const problems = [];
  if (!Array.isArray(assignments)) return ['the assignment file is not an array'];
  const known = new Set(defects.map((d) => d.id));
  const seen = new Set();
  for (const a of assignments) {
    if (!known.has(a.n)) problems.push(`assignment names #${a.n}, which is not in section 7`);
    if (seen.has(a.n)) problems.push(`#${a.n} is assigned twice`);
    seen.add(a.n);
    if (!ORDER.includes(a.stage)) problems.push(`#${a.n}: stage "${a.stage}" is not one of ${ORDER.join(', ')}`);
    if (typeof a.source !== 'string' || a.source.trim() === '') problems.push(`#${a.n}: source is empty`);
  }
  for (const d of defects) if (!seen.has(d.id)) problems.push(`#${d.id} has no assignment`);
  return problems;
}

/** Route label to restructure stage, from the generated screen-stages.md. */
export function parseScreenStages(markdown) {
  const byLabel = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Route |')) continue;
    const cells = line.slice(2, -2).split(' | ');
    const stage = /^(none|\d[A-C]?)/.exec(cells[cells.length - 1])?.[1];
    if (!stage) throw new Error(`screen-stages.md row has no readable restructure stage: ${line}`);
    for (const m of cells[0].matchAll(/`([^`]+)`/g)) if (m[1].startsWith('/') || m[1].startsWith('[')) byLabel.set(m[1], stage);
  }
  return byLabel;
}

/** Backticked tokens of a "Where" cell that look like file paths, with any `:line` suffix removed. */
export function wherePaths(where) {
  const out = [];
  for (const m of where.matchAll(/`([^`]+)`/g)) {
    const token = m[1].replace(/:\d+(?:[,-]\d+)*$/, '');
    if (PATH_LIKE.test(token) || token.includes('*')) out.push(token);
  }
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** Candidate repository files for a (possibly abbreviated) path: an exact file, else a unique-suffix match. */
function candidates(token, files) {
  if (token.includes('*')) return [];
  if (files.includes(token)) return [token];
  return files.filter((f) => f === token || f.endsWith('/' + token));
}

function resolveImport(from, spec, fileSet) {
  let base;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(dirname(from), spec));
  else return null;
  for (const tail of ['', '.ts', '.tsx', '.js', '.mjs', '.css', '/index.ts', '/index.tsx']) {
    if (fileSet.has(base + tail) && SOURCE_EXT.test(base + tail)) return base + tail;
  }
  return null;
}

/** Map each source file to the set of route files that reach it. */
function reachedFrom(routes, fileSet) {
  const cache = new Map();
  const importsOf = (file) => {
    if (!cache.has(file)) {
      const src = readFileSync(file, 'utf8');
      const info = ts.preProcessFile(src, true, true);
      cache.set(file, info.importedFiles.map((i) => resolveImport(file, i.fileName, fileSet)).filter(Boolean));
    }
    return cache.get(file);
  };
  const reached = new Map();
  for (const route of routes) {
    const seen = new Set([route]);
    const stack = [route];
    while (stack.length) {
      for (const next of importsOf(stack.pop())) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    for (const f of seen) {
      if (!reached.has(f)) reached.set(f, new Set());
      reached.get(f).add(route);
    }
  }
  return reached;
}

export function assign(defects, screenMarkdown, appDir) {
  const files = trackedFiles();
  const fileSet = new Set(files);
  const stageByLabel = parseScreenStages(screenMarkdown);
  const routes = routeFiles(appDir);
  const routeStage = new Map(routes.map((r) => [r, stageByLabel.get(routeLabel(r))]));
  const reached = reachedFrom(routes, fileSet);

  const stageOfFile = (file) => {
    if (/^(data\/legal\/|data\/content\/|public\/robots\.txt$)/.test(file)) return { stage: '0' };
    if (routeStage.has(file)) {
      const st = routeStage.get(file);
      return st !== 'none' ? { stage: st } : { why: 'none' };
    }
    const stages = [...(reached.get(file) ?? [])].map((r) => routeStage.get(r)).filter((st) => st !== 'none');
    return stages.length > 0 ? { stage: earliest(stages) } : { why: 'none' };
  };

  return defects.map((d) => {
    const walk = [];
    for (const p of wherePaths(d.where)) {
      const found = candidates(p, files);
      if (found.length === 0) { walk.push({ path: p, shown: 'missing' }); continue; }
      const results = found.map(stageOfFile);
      const staged = results.filter((r) => r.stage).map((r) => r.stage);
      const label = found.length > 1 ? `${p} (${found.length} files)` : found[0];
      walk.push({ path: label, shown: staged.length ? earliest(staged) : 'none', stage: staged.length ? earliest(staged) : undefined });
    }
    const staged = walk.filter((w) => w.stage).map((w) => w.stage);
    return { ...d, walk, walkStage: staged.length ? earliest(staged) : 'none' };
  });
}

export function render(rows, assignments) {
  const by = new Map(assignments.map((a) => [a.n, a]));
  const strip = (s) => s.replace(/\*\*/g, '').replace(/\|/g, '/');
  let differs = 0;
  const counts = new Map(ORDER.map((st) => [st, 0]));
  const lines = [
    '| # | Defect | Stage | Source | Import walk | Differs |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const a = by.get(r.id);
    counts.set(a.stage, counts.get(a.stage) + 1);
    const differ = r.walkStage !== 'none' && r.walkStage !== a.stage;
    if (differ) differs += 1;
    const walk = r.walk.length ? `${r.walkStage} (${r.walk.map((w) => `\`${w.path}\`: ${w.shown}`).join('; ')})` : 'none';
    const defect = strip(r.defect);
    lines.push(`| ${r.id} | ${defect.length > 90 ? defect.slice(0, 87) + '...' : defect} | ${a.stage} | ${strip(a.source)} | ${walk} | ${differ ? 'differs' : ''} |`);
  }
  lines.push('', ...ORDER.map((st) => `Stage ${st}: ${counts.get(st)}`), `Rows where the import walk differs from the assignment: ${differs}`);
  return lines.join('\n') + '\n';
}

function main() {
  const [consolidated, screens, appDir, assignmentsPath] = process.argv.slice(2);
  if (!consolidated || !screens || !appDir || !assignmentsPath) {
    console.error('usage: defect-stages.mjs <CONSOLIDATED.md> <screen-stages.md> <app-dir> <assignments.json>');
    process.exit(2);
  }
  let defects;
  let assignments;
  let rows;
  try {
    defects = parseDefects(readFileSync(consolidated, 'utf8'));
    assignments = JSON.parse(readFileSync(assignmentsPath, 'utf8'));
    const problems = checkAssignments(assignments, defects);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      console.error(`${problems.length} assignment problems.`);
      process.exit(1);
    }
    rows = assign(defects, readFileSync(screens, 'utf8'), appDir);
  } catch (e) {
    console.error(`defect-stages: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(render(rows, assignments));
  console.error(`${rows.length} defects; ${rows.length} assigned; 0 unassigned.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
