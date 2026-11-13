import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const ROOT = join(__dirname, '../../..');

/**
 * The repository's files as the working tree holds them: tracked files plus untracked files that .gitignore does not
 * exclude, minus tracked files deleted in the working tree. The vocabulary lint and the verbatim-reasons test both
 * choose their files from this list, so they see the same files: a copy module another lane has just created is found
 * before it is committed, and ignored output (node_modules, .next, build folders) never is.
 */
export function repoFiles(): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const deleted = new Set(git('ls-files', '--deleted'));
  return [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard'))].filter((f) => !deleted.has(f)).sort();
}
