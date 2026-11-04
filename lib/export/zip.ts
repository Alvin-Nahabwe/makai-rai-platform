import { closeSync, openSync, writeSync } from 'node:fs';
import { Zip, ZipPassThrough } from 'fflate';

/**
 * The team export's ZIP file (SRS 6.3, ADR-C7): entries stored uncompressed (method 0), written
 * chunk by chunk to a file only its owner can read, so an export never holds the archive in
 * memory. fflate sets the UTF-8 flag (bit 11) on a non-ASCII entry name by itself.
 */

/** Letters, digits, '.', '-' and '_' in any script (SRS line 1412). */
const KEPT = /[\p{L}\p{N}._-]/u;
const MAX_NAME_CODE_POINTS = 100;

/**
 * `evidence/<evidenceId>-<name>`, where the name an uploader gave cannot leave the folder or
 * disguise its extension (NFR-SEC-11): composed to NFC, cut to the text after the last `/` or `\`,
 * stripped of every character but letters, digits, '.', '-' and '_' (which removes spaces, quotes,
 * markup and direction overrides), stripped of leading dots, and cut to 100 code points. A name
 * left empty, or no name, becomes `file`. The export lists the stored name byte for byte under
 * `fileName`; only the entry name is made safe.
 */
export function safeEvidenceEntryName(evidenceId: string, fileName: string | null): string {
  const composed = (fileName ?? '').normalize('NFC');
  const last = composed.split(/[/\\]/).pop() ?? '';
  const kept = [...last].filter((c) => KEPT.test(c)).join('').replace(/^\.+/, '');
  const name = [...kept].slice(0, MAX_NAME_CODE_POINTS).join('');
  return `evidence/${evidenceId}-${name === '' ? 'file' : name}`;
}

export type ZipFileWriter = {
  /** Adds one stored entry; its bytes are written to the file before this returns. */
  add(name: string, bytes: Uint8Array): void;
  /** Writes the central directory, closes the file and returns its size in bytes. */
  finish(): number;
  /** Closes the file of an archive that will not be finished; does nothing once it is closed. */
  abort(): void;
};

/**
 * Creates `path` (it must not exist: flag `wx`) with mode 0600 and returns a writer for it. If a
 * write fails, the descriptor is closed and the error is thrown from the `add` or `finish` that
 * caused it; deleting the partial file is the caller's (it owns the directory).
 */
export function openZipFile(path: string): ZipFileWriter {
  const fd = openSync(path, 'wx', 0o600);
  let open = true;
  let bytes = 0;
  let failure: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failure ??= err;
      return;
    }
    if (failure !== null) return;
    try {
      let off = 0;
      while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
      bytes += chunk.length;
    } catch (e) {
      failure = e;
    }
  });

  const close = () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
  // fflate calls the callback synchronously for stored entries, so a failure is known on return.
  const run = (step: () => void) => {
    if (!open) throw new Error('openZipFile: the archive is already finished or failed');
    try {
      step();
    } catch (e) {
      failure ??= e;
    }
    if (failure !== null) {
      close();
      throw failure;
    }
  };

  return {
    add(name, data) {
      run(() => {
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(data, true);
      });
    },
    finish() {
      run(() => zip.end());
      close();
      return bytes;
    },
    abort() {
      close();
    },
  };
}
