import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The hashed files of a content version directory, in hash order (contract, Content bundle). */
export const CONTENT_BUNDLE_FILES = [
  'assessmentAreas.json',
  'projectConfig.json',
  'questionBank.json',
  'reasonCodes.json',
  'documentHelp.json',
] as const;

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * SHA-256 hex of the lines `<file>:<sha256 hex of read(file)>` joined by `\n`,
 * in `CONTENT_BUNDLE_FILES` order: the 4.0.0 formula of
 * lib/framework/bundleHash.ts with the bare file name as the label. Pure: it
 * reads no file, so a route can import it without putting a computed path
 * into the build trace.
 */
export function hashBundleFiles(read: (file: (typeof CONTENT_BUNDLE_FILES)[number]) => Uint8Array): string {
  const lines = CONTENT_BUNDLE_FILES.map((f) => `${f}:${sha256Hex(read(f))}`);
  return sha256Hex(Buffer.from(lines.join('\n'), 'utf8'));
}

/**
 * For scripts and tests only. No module reachable from `app/` imports this
 * one: its computed path would make Turbopack trace the whole project.
 */
export function computeVersionBundleHash(versionDir: string): string {
  return hashBundleFiles((f) => readFileSync(join(versionDir, f)));
}
