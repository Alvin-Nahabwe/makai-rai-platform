import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inventory } from '../../scripts/design/inventory.mjs';

/**
 * Plan 1A Task 24: DESIGN.md is written from the built system and held to it. `scripts/design/inventory.mjs` reads the
 * tokens of app/globals.css, the exports of components/ui, the `ui-` and `shell-` classes of the tracked stylesheets and
 * the icons of components/ui/icons.tsx. Both directions are checked, by exact name, with no network:
 *  - every token, component and icon of the inventory is named in DESIGN.md (inside backticks: a token as `--name`, a
 *    component as `<Name>`, an icon in the "Icons" section as `name`);
 *  - every such name DESIGN.md gives exists in the inventory, and so does every `.ui-…` or `.shell-…` class it names.
 * Fenced code blocks are not read, so a diagram cannot name or hide a thing.
 */

const inv = inventory();
const doc = readFileSync('DESIGN.md', 'utf8').replace(/^```[\s\S]*?^```/gm, '');
const spans = [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

/** The text of the "## Icons" section: up to the next level-two heading. */
function iconsSection(): string {
  const start = doc.search(/^## Icons\b/m);
  if (start === -1) return '';
  const rest = doc.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const namedTokens = new Set(spans.flatMap((s) => s.match(/(?<![\w-])--[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []));
const namedComponents = new Set(spans.flatMap((s) => [...s.matchAll(/<([A-Z][A-Za-z0-9]*)>/g)].map((m) => m[1])));
const namedClasses = new Set(spans.flatMap((s) => [...s.matchAll(/\.((?:ui|shell)-[A-Za-z0-9_-]+)/g)].map((m) => m[1])));
const namedIcons = new Set([...iconsSection().matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));

describe('DESIGN.md and the built system', () => {
  it('the inventory is not empty (a parser that finds nothing would pass every case below)', () => {
    expect(inv.tokens.length).toBeGreaterThan(50);
    expect(inv.components.length).toBeGreaterThan(30);
    expect(inv.icons.length).toBeGreaterThan(25);
    expect(inv.classes.length).toBeGreaterThan(100);
  });

  it('names every token of app/globals.css', () => {
    expect(inv.tokens.map((t) => t.name).filter((n) => !namedTokens.has(n))).toEqual([]);
  });

  it('names every component of components/ui, as <Name>', () => {
    expect(inv.components.map((c) => c.name).filter((n) => !namedComponents.has(n))).toEqual([]);
  });

  it('names every icon, in its Icons section', () => {
    expect(inv.icons.filter((n) => !namedIcons.has(n))).toEqual([]);
  });

  it('gives no token that app/globals.css does not define', () => {
    const known = new Set(inv.tokens.map((t) => t.name));
    expect([...namedTokens].filter((n) => !known.has(n))).toEqual([]);
  });

  it('gives no component that components/ui does not export', () => {
    const known = new Set(inv.components.map((c) => c.name));
    expect([...namedComponents].filter((n) => !known.has(n))).toEqual([]);
  });

  it('gives no icon that components/ui/icons.tsx does not draw', () => {
    const known = new Set(inv.icons);
    expect([...namedIcons].filter((n) => !known.has(n))).toEqual([]);
  });

  it('gives no ui- or shell- class that no tracked stylesheet holds', () => {
    const known = new Set(inv.classes.map((c) => c.name));
    expect([...namedClasses].filter((n) => !known.has(n))).toEqual([]);
  });

  it('keeps the screenshots it shows: every docs/design/screens file named exists', () => {
    const files = [...doc.matchAll(/docs\/design\/screens\/[\w.-]+\.webp/g)].map((m) => m[0]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => { try { readFileSync(f); return false; } catch { return true; } })).toEqual([]);
  });
});
