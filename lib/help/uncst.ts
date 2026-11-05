import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which data card and mitigation plan fields answer the six AI protocol issues
 * of UNCST 16.6 (owner answer A2). The mapping lives in `data/uncst-16-6.json`,
 * written and reviewed with the field maps (C-MAP); this module only reads it.
 *
 * The literal `data` prefix after `process.cwd()` is deliberate: the build
 * traces the file from a static path, and a computed segment would make it
 * trace the whole project (contract, "Static read paths").
 *
 * Callers render every value as a React text child, never as markup (NFR-SEC-11).
 */
export type UncstIssueId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

export type UncstTable = {
  source: string;
  issues: Array<{
    id: UncstIssueId;
    title: string;
    dataCardFields: string[];
    mitigationPlanFields: string[];
    note: string | null;
  }>;
};

const FILE = 'data/uncst-16-6.json';
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Reads the file and refuses one that does not hold issues `a` to `f` in order, naming the problem. */
export function readUncstTable(): UncstTable {
  const text = readFileSync(join(process.cwd(), 'data', 'uncst-16-6.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${FILE}: not valid JSON`, { cause });
  }
  const file = raw as { source?: unknown; issues?: unknown } | null;
  if (typeof file?.source !== 'string' || file.source.trim() === '') {
    throw new Error(`${FILE}: "source" must be a non-empty string`);
  }
  if (!Array.isArray(file.issues)) throw new Error(`${FILE}: "issues" must be an array`);
  const found = file.issues.map((i: { id?: unknown }) => String(i?.id)).join(',');
  if (found !== IDS.join(',')) {
    const missing = IDS.find((id) => !found.split(',').includes(id));
    throw new Error(
      `${FILE}: issue ids must be a to f in order, found "${found}"` +
        (missing ? `; issue "${missing}" is missing` : ''),
    );
  }
  for (const issue of file.issues as Array<Record<string, unknown>>) {
    const id = String(issue.id);
    if (typeof issue.title !== 'string' || issue.title.trim() === '') {
      throw new Error(`${FILE}: issue ${id} needs a non-empty title`);
    }
    if (!isStringArray(issue.dataCardFields) || !isStringArray(issue.mitigationPlanFields)) {
      throw new Error(`${FILE}: issue ${id} field lists must be arrays of strings`);
    }
    if (issue.note !== null && typeof issue.note !== 'string') {
      throw new Error(`${FILE}: issue ${id} note must be a string or null`);
    }
  }
  return file as UncstTable;
}
