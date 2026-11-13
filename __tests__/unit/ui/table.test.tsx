import { readFileSync } from 'node:fs';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Table, type TableColumn, type TableProps } from '@/components/ui/Table';
import { SORT_WORDS } from '@/lib/ui/copy';
import { decode, textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5: Table (modern-web-guidance `responsive-table` and `sortable-table`). The wrapper is a named, focusable
 * region; a sortable header holds a button with the column's label alone; only the sorted header carries aria-sort; a
 * visually hidden status line says the sort in the column's own words (the owner's decision of 13 November 2026); under
 * a 640 px container the rows become cards, each cell showing its column's label, hidden from assistive technology.
 * The table never sorts: it renders the rows in the order given and reports a header's activation through onSort.
 *
 * The handler case calls the component as a function with useId replaced, since this repository's unit tests run in
 * node with no DOM and calling a hook outside React throws.
 */

let fixedId: string | null = null;
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useId: (() => fixedId ?? actual.useId()) as typeof actual.useId };
});

const COLUMNS: readonly TableColumn[] = [
  { key: 'finding', label: 'Finding', sortable: true, sortWords: SORT_WORDS.name },
  { key: 'opened', label: 'Opened', sortable: true, sortWords: SORT_WORDS.date },
  { key: 'stage', label: 'Stage' },
  { key: 'questions', label: 'Questions', align: 'end', sortable: true, sortWords: SORT_WORDS.number },
];

const ROWS: TableProps['rows'] = [
  { key: 'f2', cells: { finding: 'Retention is not set', opened: '3 Mar 2026', stage: 'Pre-processing', questions: 2 } },
  { key: 'f1', cells: { finding: 'Consent does not cover reuse', opened: '11 Feb 2026', stage: 'In processing', questions: 5 } },
];

const base: TableProps = { caption: 'Sample findings', columns: COLUMNS, rows: ROWS, rowHeaderKey: 'finding', onSort: () => {} };
const html = (p: Partial<TableProps> = {}) => renderToStaticMarkup(<Table {...base} {...p} />);

describe('Table', () => {
  afterEach(() => { fixedId = null; });

  it('the wrapper is a focusable region named by the caption', () => {
    const out = html();
    const wrap = /^<div class="ui-table-wrap" role="region" tabindex="0" aria-labelledby="([^"]+)">/.exec(out);
    expect(wrap, out.slice(0, 200)).not.toBeNull();
    expect(out).toContain(`<caption id="${wrap?.[1]}" class="ui-table__caption">Sample findings</caption>`);
  });

  it('captionHidden keeps the caption as the name and hides it visually', () => {
    expect(html({ captionHidden: true })).toMatch(/<caption id="[^"]+" class="ui-table__caption visually-hidden">Sample findings<\/caption>/);
  });

  it('a sortable header holds a <button type="button"> whose text is the column label alone; a plain header has none', () => {
    const out = html();
    const buttons = [...out.matchAll(/<button [^>]*>([\s\S]*?)<\/button>/g)];
    expect(buttons.map((b) => b[0].match(/^<button ([^>]*)>/)?.[1])).toEqual(Array(3).fill('type="button" class="ui-table__sort"'));
    expect(buttons.map((b) => textOf(b[1]))).toEqual(['Finding', 'Opened', 'Questions']);
    expect(out).toMatch(/<th role="columnheader" scope="col">Stage<\/th>/);
    for (const b of buttons) expect(b[1]).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
  });

  it('exactly one aria-sort, on the sorted header only, and none when sort is undefined', () => {
    expect(html()).not.toContain('aria-sort');
    const out = html({ sort: { key: 'opened', direction: 'descending' } });
    expect(out.match(/aria-sort=/g)).toHaveLength(1);
    expect(out).toMatch(/<th role="columnheader" scope="col" aria-sort="descending"><button type="button" class="ui-table__sort">Opened</);
    expect(html({ sort: { key: 'finding', direction: 'ascending' } })).toMatch(/<th [^>]*aria-sort="ascending"><button [^>]*>Finding</);
  });

  it('the status line is empty while unsorted and says the sort in the column\'s own words', () => {
    const status = (out: string) => decode(/<p role="status" class="ui-table__status visually-hidden">([^<]*)<\/p>/.exec(out)?.[1] ?? 'MISSING');
    expect(status(html())).toBe('');
    expect(status(html({ sort: { key: 'opened', direction: 'descending' } }))).toBe('Sorted by Opened, latest first');
    expect(status(html({ sort: { key: 'finding', direction: 'ascending' } }))).toBe('Sorted by Finding, A to Z');
    expect(status(html({ sort: { key: 'questions', direction: 'descending' } }))).toBe('Sorted by Questions, highest first');
  });

  it('every td has its column\'s __cell-label, hidden from assistive technology, before the content', () => {
    const out = html();
    const cells = [...out.matchAll(/<td [^>]*>([\s\S]*?)<\/td>/g)];
    expect(cells).toHaveLength(ROWS.length * 3);
    for (const [, inner] of cells) expect(inner).toMatch(/^<span class="ui-table__cell-label" aria-hidden="true">(Opened|Stage|Questions)<\/span>/);
    expect(out).not.toMatch(/<th [^>]*scope="row"[^>]*><span class="ui-table__cell-label"/);
  });

  it('carries explicit roles, so the card layout keeps the table\'s semantics', () => {
    const out = html();
    expect(out).toMatch(/<table class="ui-table" role="table">/);
    expect(out.match(/role="rowgroup"/g)).toHaveLength(2);
    expect(out.match(/<tr role="row">/g)).toHaveLength(ROWS.length + 1);
    expect(out.match(/role="columnheader"/g)).toHaveLength(COLUMNS.length);
    expect(out.match(/<th role="rowheader" scope="row"[^>]*>/g)).toHaveLength(ROWS.length);
    expect(out.match(/<td role="cell"/g)).toHaveLength(ROWS.length * 3);
  });

  it('renders the rows in the order given, the row header first in each row; it sorts nothing itself', () => {
    const out = html({ sort: { key: 'finding', direction: 'ascending' } });
    expect(out.indexOf('Retention is not set')).toBeLessThan(out.indexOf('Consent does not cover reuse'));
    expect(out).toMatch(/<tr role="row"><th role="rowheader" scope="row">Retention is not set<\/th><td role="cell">/);
  });

  it('align end reaches the header and the cells of that column', () => {
    const out = html();
    expect(out).toMatch(/<th role="columnheader" scope="col" class="ui-table__end"><button/);
    expect(out.match(/<td role="cell" class="ui-table__end">/g)).toHaveLength(ROWS.length);
  });

  it('with no rows, the empty node follows the table in __empty', () => {
    const out = html({ rows: [], empty: <span>No findings yet.</span> });
    expect(out).toMatch(/<\/table><div class="ui-table__empty"><span>No findings yet.<\/span><\/div>/);
    expect(out).not.toMatch(/<td /);
    expect(html({ rows: [] })).not.toContain('ui-table__empty');
  });

  it('a header button reports its column through onSort and nothing else', () => {
    fixedId = 'tbl';
    const onSort = vi.fn();
    const tree = Table({ ...base, onSort });
    const buttons = findAll(tree, (el) => el.type === 'button') as Array<ReactElement<{ onClick: () => void }>>;
    expect(buttons).toHaveLength(3);
    buttons[1].props.onClick();
    expect(onSort).toHaveBeenCalledExactlyOnceWith('opened');
  });

  it('a mistake in the screen is loud outside production: a sort key naming no sortable column, a sortable column with no onSort', () => {
    expect(() => html({ sort: { key: 'stage', direction: 'ascending' } })).toThrow(/stage/);
    expect(() => html({ sort: { key: 'nope', direction: 'ascending' } })).toThrow(/nope/);
    expect(() => html({ onSort: undefined })).toThrow(/onSort/);
    expect(() => html({ rowHeaderKey: 'owner' })).toThrow(/owner/);
    expect(() => html({ rows: [{ key: 'r1', cells: { opened: '1 Mar 2026' } }] })).toThrow(/r1/);
    expect(html({ onSort: undefined, columns: [{ key: 'finding', label: 'Finding' }, { key: 'stage', label: 'Stage' }] })).not.toContain('<button');
  });

  it('in production the same mistakes render a plain table: no aria-sort, no status, no dead button', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const wrongKey = html({ sort: { key: 'stage', direction: 'ascending' } });
      expect(wrongKey).not.toContain('aria-sort');
      expect(wrongKey).toMatch(/<p role="status" class="ui-table__status visually-hidden"><\/p>/);
      expect(html({ onSort: undefined })).not.toContain('<button');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the type refuses a sortable column without its words', () => {
    // @ts-expect-error sortable: true needs sortWords (the owner's decision: every sortable column says its own words)
    const refused: TableColumn = { key: 'opened', label: 'Opened', sortable: true };
    expect(refused.key).toBe('opened');
  });

  it('the CSS switches to cards under a 640 px container, shows the cell labels only there, and moves only colour', () => {
    const css = readFileSync('components/ui/Table.css', 'utf8');
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('@container (width < 640px)');
    expect(css).toMatch(/\.ui-table__cell-label\s*\{[^}]*display:\s*none/);
    for (const [, value] of css.matchAll(/transition:\s*([^;]+);/g)) expect(value).toMatch(/^(color|background-color|border-color)\b/);
    expect(css).not.toMatch(/@keyframes|animation:/);
  });

  it('is a client component: it has a handler of its own', () => {
    expect(readFileSync('components/ui/Table.tsx', 'utf8')).toMatch(/^'use client';/);
  });
});

/** Every element in a rendered tree (not mounted: function components are not called) that matches `test`. */
function findAll(node: ReactNode, test: (el: ReactElement<{ children?: ReactNode }>) => boolean): ReactElement[] {
  const found: ReactElement[] = [];
  const walk = (n: ReactNode) => Children.forEach(n, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (test(child)) found.push(child);
    walk(child.props.children);
  });
  walk(node);
  return found;
}
