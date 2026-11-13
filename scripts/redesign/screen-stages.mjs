#!/usr/bin/env node
/**
 * Generates the per-screen table of the interface redesign (plan 1A, "The per-screen table (generated)").
 *
 *   node scripts/redesign/screen-stages.mjs <app-dir> <rules.json> > screen-stages.md
 *
 * Walks <app-dir> for page.tsx, error.tsx, global-error.tsx and not-found.tsx, skips the development-only
 * prefixes the rules file names, strips route groups, and matches each route against exactly one rule.
 * Exits 1 when a route matches no rule or several. The table is written to stdout, the count to stderr.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPECIAL = { 'error.tsx': 'error', 'global-error.tsx': 'global-error', 'not-found.tsx': 'not-found' };

/** Every route file under `appDir`, as paths relative to the directory above it (`app/...`), sorted. */
export function routeFiles(appDir) {
  const base = dirname(appDir.replace(/\/+$/, ''));
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx' || entry.name in SPECIAL) out.push(relative(base, full).split(sep).join('/'));
    }
  };
  walk(appDir);
  return out.sort();
}

/** `app/(public)/legal/[kind]/page.tsx` gives `/legal/[kind]`; `app/not-found.tsx` gives `[not-found] /`. */
export function routeLabel(file) {
  const parts = file.split('/').slice(1);
  const name = parts.pop();
  const dir = '/' + parts.filter((p) => !/^\(.*\)$/.test(p)).join('/');
  const path = dir === '/' ? '/' : dir;
  return name === 'page.tsx' ? path : `[${SPECIAL[name]}] ${path}`;
}

export function loadRules(rulesPath) {
  const data = JSON.parse(readFileSync(rulesPath, 'utf8'));
  return { ...data, rules: data.rules.map((r) => ({ ...r, re: new RegExp(r.route) })) };
}

/** Matches every route file to exactly one rule. Returns the rows and the problem list. */
export function buildRows(appDir, config) {
  const files = routeFiles(appDir).filter((f) => !config.devOnlyPrefixes.some((p) => f.startsWith(p)));
  const devOnly = routeFiles(appDir).filter((f) => config.devOnlyPrefixes.some((p) => f.startsWith(p)));
  const problems = [];
  const groups = new Map();
  for (const file of files) {
    const label = routeLabel(file);
    const hits = config.rules.map((r, i) => [r, i]).filter(([r]) => r.re.test(label));
    if (hits.length !== 1) {
      problems.push(`${file} (${label}): ${hits.length === 0 ? 'matches no rule' : `matches ${hits.length} rules`}`);
      continue;
    }
    const [rule, index] = hits[0];
    const key = rule.oneRow || label.startsWith('[') ? `rule:${index}` : label;
    if (!groups.has(key)) groups.set(key, { rule, index, labels: [], files: [], special: label.startsWith('[') });
    const g = groups.get(key);
    if (!g.labels.includes(label)) g.labels.push(label);
    g.files.push(file);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    a.special !== b.special ? (a.special ? 1 : -1) : a.special ? a.index - b.index : a.files[0] < b.files[0] ? -1 : 1,
  );
  const rows = ordered.map((g) => {
    let route = g.labels.map((l) => `\`${l}\``).join(', ');
    if (g.rule.listFiles) {
      const byDepth = [...g.files].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
      route += ` (${byDepth.map((f) => `\`${f}\``).join(', ')})`;
    }
    return { route, screen: g.rule.screen, restyled: g.rule.restyled, restructured: g.rule.restructured };
  });
  for (const a of config.appended) rows.push({ route: a.route, screen: a.screen, restyled: a.restyled, restructured: a.restructured });
  return { rows, problems, devOnly, routeCount: files.length };
}

export function renderTable(rows) {
  const lines = [
    '| Route | Screen (spec section 8, screens/INDEX.md numbers) | Restyled and reworded | Restructured |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.route} | ${r.screen} | ${r.restyled} | ${r.restructured} |`),
  ];
  return lines.join('\n');
}

function main() {
  const [appDir, rulesPath] = process.argv.slice(2);
  if (!appDir || !rulesPath) {
    console.error('usage: screen-stages.mjs <app-dir> <rules.json>');
    process.exit(2);
  }
  const config = loadRules(rulesPath);
  const { rows, problems, devOnly, routeCount } = buildRows(appDir, config);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`${routeCount} route files from ${appDir}; ${problems.length} unmatched or ambiguous.`);
    process.exit(1);
  }
  let out = renderTable(rows) + '\n';
  if (devOnly.length > 0) {
    out += '\nDevelopment only, 404 in production (excluded from the table and the count):\n\n';
    out += devOnly.map((f) => `- \`${routeLabel(f)}\``).join('\n') + '\n';
  }
  process.stdout.write(out);
  console.error(`${rows.length} rows from ${routeCount} route files in ${appDir}; 0 unmatched or ambiguous.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
