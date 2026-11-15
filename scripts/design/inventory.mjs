#!/usr/bin/env node
// The design inventory (plan 1A Task 24, spec 11): what the built system holds, read from the files, so DESIGN.md can be
// held to it (__tests__/lint/design-md.test.ts). Prints, in this order:
//   1. every token of app/globals.css with its light value (the :root block) and its dark value (the
//      :root[data-theme='dark'] block; "(as light)" where the dark block does not set it);
//   2. every components/ui/*.tsx export: components (a capitalised function) with the name of the props type, helpers
//      (anything else exported as a value or a function);
//   3. every `ui-` and `shell-` class named in a tracked stylesheet;
//   4. every icon name of components/ui/icons.tsx.
// No network, no build. Run from the repository root: `node scripts/design/inventory.mjs`.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first block whose selector line is exactly `selector`, by brace depth. */
function blockOf(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no block for ${selector} in app/globals.css`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error(`unbalanced braces in the ${selector} block`);
}

function declarations(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

export function tokens() {
  const css = stripComments(readFileSync('app/globals.css', 'utf8'));
  const light = declarations(blockOf(css, ':root'));
  const dark = declarations(blockOf(css, ":root[data-theme='dark']"));
  const media = declarations(blockOf(css, ":root:not([data-theme='light'])"));
  for (const [name, value] of dark) {
    if (media.get(name) !== value) throw new Error(`the two dark blocks differ at ${name}`);
  }
  if (media.size !== dark.size) throw new Error('the two dark blocks differ in size');
  return [...light].map(([name, value]) => ({ name, light: value, dark: dark.get(name) ?? null }));
}

export function components() {
  const out = [];
  const helpers = [];
  for (const file of readdirSync('components/ui').filter((f) => f.endsWith('.tsx')).sort()) {
    const source = readFileSync(`components/ui/${file}`, 'utf8');
    for (const m of source.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = m[1];
      if (!/^[A-Z]/.test(name)) { helpers.push({ name, file: `components/ui/${file}` }); continue; }
      const props = new RegExp(`^export (?:type|interface) (${name}Props)\\b`, 'm').exec(source);
      out.push({ name, file: `components/ui/${file}`, props: props ? props[1] : null });
    }
  }
  for (const file of readdirSync('components/ui').filter((f) => /\.ts$/.test(f)).sort()) {
    const source = readFileSync(`components/ui/${file}`, 'utf8');
    for (const m of source.matchAll(/^export (?:function|const) (\w+)/gm)) helpers.push({ name: m[1], file: `components/ui/${file}` });
  }
  return { components: out, helpers };
}

export function classes() {
  const files = execFileSync('git', ['ls-files', '*.css'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const found = new Map();
  for (const file of files) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/\.((?:ui|shell)-[A-Za-z0-9_-]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(file);
    }
  }
  return [...found].map(([name, where]) => ({ name, files: [...where].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

export function icons() {
  const source = readFileSync('components/ui/icons.tsx', 'utf8');
  const body = source.slice(source.indexOf('export const ICONS'));
  return [...body.matchAll(/^ {2}'([a-z0-9-]+)': \[/gm)].map((m) => m[1]);
}

export function inventory() {
  return { tokens: tokens(), ...components(), classes: classes(), icons: icons() };
}

function print() {
  const inv = inventory();
  const lines = [];
  lines.push(`# tokens (${inv.tokens.length}): name | light | dark`);
  for (const t of inv.tokens) lines.push(`${t.name} | ${t.light} | ${t.dark ?? '(as light)'}`);
  lines.push('', `# components (${inv.components.length}): name | props type | file`);
  for (const c of inv.components) lines.push(`${c.name} | ${c.props ?? '(inline props)'} | ${c.file}`);
  lines.push('', `# helpers (${inv.helpers.length}): name | file`);
  for (const h of inv.helpers) lines.push(`${h.name} | ${h.file}`);
  lines.push('', `# classes (${inv.classes.length}): name | stylesheets`);
  for (const c of inv.classes) lines.push(`${c.name} | ${c.files.join(', ')}`);
  lines.push('', `# icons (${inv.icons.length})`, ...inv.icons);
  console.log(lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) print();
