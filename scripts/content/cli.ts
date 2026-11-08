/** A process helper the content scripts share (moved from coverage.ts, C4 SIM-4). */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is the one `node`/`tsx` was started on, also through a symlinked path. */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
}
