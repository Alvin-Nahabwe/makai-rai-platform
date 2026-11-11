import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The content check reads a question-set proposal only when its status is 'approved' (lib/content/validate.ts:173-177).
 * A draft version's committed proposal says 'checked' until the owner's sitting, so tests check a draft's content
 * through a temporary copy that says 'approved'. The copy is removed afterwards, and `run` receives its path.
 */
export function withApprovedCopy<T>(proposalFile: string, run: (approvedFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-copy-'));
  try {
    const file = join(dir, 'proposal.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(proposalFile, 'utf8')), status: 'approved' }));
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The committed status of a proposal file, or null when the version has none. */
export function proposalStatus(proposalFile: string): string | null {
  try {
    return (JSON.parse(readFileSync(proposalFile, 'utf8')) as { status: string }).status;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
