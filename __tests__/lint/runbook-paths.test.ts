import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * No runbook command may reference a developer's local checkout.
 *
 * The application lives at `/srv/makrai/app` on the server. A runbook step that
 * says `cd /home/<someone>/Downloads/...` fails on the very first line, and it
 * failed silently in three separate places before this file existed:
 *
 *  - `deployment.md` §3's clone step, fixed 2026-08-27
 *  - the backup script's `source .env`, which meant every cron backup died
 *    before reaching the database (2026-08-29, register D-242)
 *  - the certbot renewal cron, and then five surviving `cd` commands including
 *    the FIRST LINE of the restore procedure — found 2026-08-29 while trying to
 *    execute that procedure for the first time
 *
 * The third instance is the reason this is a test rather than a fourth fix. The
 * paths are invisible in review because they look exactly like a working path,
 * and they are only discovered by someone running the step on the real machine
 * — which, for a restore procedure, is the worst possible moment.
 *
 * The scripts themselves used to be pasted into the runbook, so a bad path in
 * one was a bad path in a fenced block. They are tracked in `ops/host/` now, and
 * that directory is read here too, as whole files rather than fenced blocks.
 *
 * SCOPED TO FENCED CODE BLOCKS. Prose must stay free to discuss the defect:
 * several sections explain what the path used to be and why it was wrong, and a
 * guard that forbade the string outright would force those explanations out of
 * the document. What must never contain it is a line someone copies and runs.
 */

/**
 * Tracked files, plus new ones not yet committed, so the check runs on a
 * working copy before the commit that adds them. In CI the two are the same.
 */
function runbooks(): string[] {
  return execSync('git ls-files -co --exclude-standard docs/runbooks ops/host')
    .toString().trim().split('\n').filter(Boolean);
}

/**
 * What a reader copies and executes: lines inside ``` fences in a document, and
 * every non-comment line of a script or crontab in `ops/host/`.
 */
function commandLines(file: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  if (!file.endsWith('.md')) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.trim() !== '' && !line.trimStart().startsWith('#')) out.push({ line, n: i + 1 });
    });
    return out;
  }
  let inFence = false;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; return; }
    if (inFence) out.push({ line, n: i + 1 });
  });
  return out;
}

describe('runbook commands reference the server, not a developer machine', () => {
  it('reads a plausible number of command lines, so a broken fence parser fails loudly', () => {
    const total = runbooks().reduce((a, f) => a + commandLines(f).length, 0);
    expect(total, 'no fenced command lines found — the fence parser is broken').toBeGreaterThan(100);
  });

  it('has no local checkout path in any runnable line', () => {
    const bad: string[] = [];
    for (const f of runbooks()) {
      for (const { line, n } of commandLines(f)) {
        if (/\/home\/[a-z_][a-z0-9_-]*\/(Downloads|Documents|Desktop|projects?|src|dev|code|repos?)\//i.test(line)) {
          bad.push(`${f}:${n}  ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(
      bad,
      `these runbook commands point at a developer's local checkout and will fail on the ` +
        `server, where the app is at /srv/makrai/app:\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });
});
