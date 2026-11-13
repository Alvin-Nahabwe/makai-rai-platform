import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Defect 25 (plan stage 1A, defect-stages.md): the evidence attach component of plan 1c and its write-then-confirm
 * helper had no caller once S-12 took EVD's EvidenceBlock, and are deleted. The case fails if either file, or any
 * source naming either, comes back. `assertEvidenceAttachable` (lib/data/evidenceGuard.ts) is a different, live
 * function: the word boundary keeps it out of the match.
 */
const FILES = ['components/evidence/EvidenceAttach.tsx', 'lib/evidence/mutateThenConfirm.ts'];
const NAMES = ['\\bEvidenceAttach\\b', 'mutateThenConfirm', 'mutate-then-confirm'];

it('EvidenceAttach is not in the tree', () => {
  for (const f of FILES) expect(existsSync(f), f).toBe(false);
  const r = spawnSync('git', ['grep', '--untracked', '-nE', NAMES.join('|'), '--', 'app', 'components', 'lib'], { encoding: 'utf8' });
  expect([0, 1], r.stderr).toContain(r.status);   // 1 is "no match"; 128 is a failed search, not a clean tree
  expect(r.stdout).toBe('');
});
