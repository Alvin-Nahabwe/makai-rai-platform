import { execSync } from 'node:child_process';

/**
 * Text from spawned processes, for tests that match it (C4 item 12): the child runs with
 * NO_COLOR=1 (and FORCE_COLOR=0) and every ANSI escape is stripped from what comes back, so a
 * colouring environment cannot change what a match sees.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** The colourless environment a matched child runs in. */
export function colourlessEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
}

/** Runs `cmd` in a shell with a colourless environment and returns its stdout, ANSI stripped. */
export function shText(cmd: string): string {
  return stripAnsi(execSync(cmd, { env: colourlessEnv(), encoding: 'utf8' }));
}
