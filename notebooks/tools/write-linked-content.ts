/**
 * Rewrites the `linked-content` cell of each technical notebook from the running content bundle.
 * Run from the repository root: `npx tsx notebooks/tools/write-linked-content.ts [content-version]`
 * (default 5.0.0). Only that one cell changes; the rest of each file is written back as read.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AreasFile, QuestionBankFile } from '../../types/content';
import { linkedContentMarkdown } from './linkedContent';

interface Cell { cell_type: string; metadata: { tags?: string[] }; source: string[] | string }
interface Notebook { cells: Cell[] }

const root = process.cwd();
const version = process.argv[2] ?? '5.0.0';
const dir = join(root, 'data', 'content', version);
const bank = JSON.parse(readFileSync(join(dir, 'questionBank.json'), 'utf8')) as QuestionBankFile;
const areas = JSON.parse(readFileSync(join(dir, 'assessmentAreas.json'), 'utf8')) as AreasFile;

const technical = join(root, 'notebooks', 'technical');
const files = readdirSync(technical).filter((f) => /^C-\d{2}_.+\.ipynb$/.test(f)).sort();
if (files.length === 0) throw new Error(`no notebooks found in ${technical}`);

for (const file of files) {
  const control = file.slice(0, 4);
  const path = join(technical, file);
  const nb = JSON.parse(readFileSync(path, 'utf8')) as Notebook;
  const cells = nb.cells.filter((c) => (c.metadata.tags ?? []).includes('linked-content'));
  if (cells.length !== 1) throw new Error(`${file}: expected one linked-content cell, found ${cells.length}`);
  const md = linkedContentMarkdown(control, bank, areas);
  cells[0].source = md.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
  writeFileSync(path, `${JSON.stringify(nb, null, 1)}\n`);
  console.log(`${file}: linked-content cell written from content ${version}`);
}
