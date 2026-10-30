import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { MARKER_PATTERN } from './markers';

/**
 * In-process log capture and scan for NFR-PRIV-03 (no record text and no email address in any log) and
 * NFR-OBS-01 (one event per action). The server-log half, for a live server, is `e2e/helpers/logs.ts`.
 */

const METHODS = ['log', 'info', 'warn', 'error'] as const;

/**
 * Runs `fn` while `console.log`, `info`, `warn` and `error` (the four methods `lib/redact.ts` wraps) record
 * what they are given instead of printing it. Returns the result and the lines in order, formatted as the
 * console would format them, with a message that holds newlines split into one line each. The console is
 * restored whether `fn` returns or rejects. Not reentrant across concurrent calls: the second would record
 * into the first's spies.
 */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = Object.fromEntries(METHODS.map((m) => [m, console[m]])) as Record<(typeof METHODS)[number], (...a: unknown[]) => void>;
  for (const method of METHODS)
    console[method] = (...args: unknown[]) => {
      lines.push(...format(...args).split('\n'));
    };
  try {
    return { result: await fn(), lines };
  } finally {
    for (const method of METHODS) console[method] = original[method];
  }
}

/** The address pattern the nightly production scan uses (`ops/host/makrai-email-scan.sh`), read from its file. */
const EMAIL_SOURCE = readFileSync(join(process.cwd(), 'ops', 'host', 'email-shape.regex'), 'utf8').trim();

export interface LogFinding {
  line: number;
  match: string;
  kind: 'marker' | 'email';
}

/**
 * Every marker and email address in `lines`, as `{ line, match, kind }` with `line` counted from 0, in order
 * of line and then of position in the line. A kind that is not asked for is not scanned.
 */
export function scanLines(lines: readonly string[], opts: { markers: boolean; emails: boolean }): LogFinding[] {
  const found: Array<LogFinding & { at: number }> = [];
  lines.forEach((text, line) => {
    // New patterns per call: a global RegExp keeps its position between uses.
    const patterns: Array<[LogFinding['kind'], RegExp]> = [];
    if (opts.emails) patterns.push(['email', new RegExp(EMAIL_SOURCE, 'g')]);
    if (opts.markers) patterns.push(['marker', new RegExp(MARKER_PATTERN.source, 'g')]);
    for (const [kind, pattern] of patterns)
      for (const m of text.matchAll(pattern)) found.push({ line, match: m[0], kind, at: m.index });
  });
  return found.sort((a, b) => a.line - b.line || a.at - b.at).map(({ line, match, kind }) => ({ line, match, kind }));
}
