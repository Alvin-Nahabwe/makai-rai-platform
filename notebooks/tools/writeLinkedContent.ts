import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AreasFile, QuestionBankFile } from '../../types/content';
import { linkedContentMarkdown } from './linkedContent';

interface Cell { cell_type: string; metadata: { tags?: string[] }; source: string[] | string }
interface Notebook { cells: Cell[] }

/**
 * Rewrites the `linked-content` cell of each technical notebook under `root` from a content version
 * (default: `running` in data/content/index.json). Only that one cell changes; the rest of each file is written
 * back as read. Returns the names of the notebooks written. A version must look like 5.0.0 and be listed in the index.
 */
export function writeLinkedContent(root: string, version?: string): string[] {
  const index = JSON.parse(readFileSync(join(root, 'data', 'content', 'index.json'), 'utf8')) as { running: string; versions: string[] };
  const chosen = version ?? index.running;
  if (!/^\d+\.\d+\.\d+$/.test(chosen)) throw new Error(`${chosen} is not a content version such as 5.0.0`);
  if (!index.versions.includes(chosen)) throw new Error(`content ${chosen} is not in data/content/index.json (${index.versions.join(', ')})`);
  const dir = join(root, 'data', 'content', chosen);
  const bank = JSON.parse(readFileSync(join(dir, 'questionBank.json'), 'utf8')) as QuestionBankFile;
  const areas = JSON.parse(readFileSync(join(dir, 'assessmentAreas.json'), 'utf8')) as AreasFile;

  const technical = join(root, 'notebooks', 'technical');
  const files = readdirSync(technical).filter((f) => /^C-\d{2}_.+\.ipynb$/.test(f)).sort();
  if (files.length === 0) throw new Error(`no notebooks found in ${technical}`);
  for (const file of files) {
    const path = join(technical, file);
    const nb = JSON.parse(readFileSync(path, 'utf8')) as Notebook;
    const cells = nb.cells.filter((c) => (c.metadata.tags ?? []).includes('linked-content'));
    if (cells.length !== 1) throw new Error(`${file}: expected one linked-content cell, found ${cells.length}`);
    const md = linkedContentMarkdown(file.slice(0, 4), bank, areas);
    cells[0].source = md.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
    writeFileSync(path, `${JSON.stringify(nb, null, 1)}\n`);
  }
  return files;
}
