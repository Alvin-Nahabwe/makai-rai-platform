import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AboutPage from '@/app/(public)/about/page';

/**
 * CONSOLIDATED section 4 (owner ruling, country content): the UNCST table ("Which fields answer Uganda's six AI
 * protocol issues") left About and the documents page (S-18), with its component, stylesheet, reader and data file.
 * The property is held over the tree, not over the list of files that once held it, so the table or its words coming
 * back anywhere under the scanned roots fails here. The rendered S-18 needs the database, so it is checked for every
 * role in `__tests__/integration/documents-page.test.tsx`; About is rendered here.
 *
 * Other Uganda content is not this rule's: a project's free-text country, a legal text's address and a template's
 * example law name the place a team works, and stay.
 */

/** The table's acronym in any case (also its file and component names), and the heading's words as JSX or markup writes them. */
const COUNTRY_TABLE = /UNCST|Uganda(?:'|’|&apos;|&#x27;|&#39;)s (?:six )?AI protocol/i;

/** Every text file under `roots`, as a repo-relative path with '/' separators. A missing root throws. */
function textFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/.test(name)) out.push(full.split(path.sep).join('/'));
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

describe('CONSOLIDATED section 4: no country table', () => {
  it('no screen renders UNCST or a Uganda-only table', () => {
    const files = textFiles(['app', 'components', 'lib', 'data']);
    expect(files.length, 'not vacuous').toBeGreaterThan(100);
    expect(files.filter((f) => COUNTRY_TABLE.test(f) || COUNTRY_TABLE.test(readFileSync(f, 'utf8')))).toEqual([]);
    const about = renderToStaticMarkup(createElement(AboutPage));
    expect(about).toContain('id="help-and-contact"');   // the section that held the table still renders
    expect(about).not.toMatch(COUNTRY_TABLE);
    expect(about).not.toMatch(/<table[\s>]/);
  });

  it('(harness) the pattern catches each form the removed table was written in, and not the country alone', () => {
    for (const hit of ['UNCST guidelines 2025', 'UncstTable', 'uncst-16-6.json', "Uganda's six AI protocol issues", 'Uganda&apos;s AI protocol issues', 'Uganda&#x27;s AI protocol issues']) {
      expect(COUNTRY_TABLE.test(hit), hit).toBe(true);
    }
    for (const miss of ['Kampala, Uganda', "Uganda's Data Protection and Privacy Act 2019", 'rural Uganda']) expect(COUNTRY_TABLE.test(miss), miss).toBe(false);
  });
});
