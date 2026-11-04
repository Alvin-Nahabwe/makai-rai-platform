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
 * What a classic (non-ZIP64) archive can address: fflate 0.8.3 writes no ZIP64 records, so an
 * offset past 4 GiB or a count past 65 535 entries would be written cut to its field, a corrupt
 * archive that reads as a good one. `openZipFile` refuses to grow past either.
 */
export const zipLimits = { maxEntries: 0xffff, maxBytes: 0xffffffff } as const;

/** An `add` refused because the archive would pass one of `zipLimits`. Nothing of the entry was written. */
export class ZipLimitError extends Error {
  constructor(readonly limit: 'entries' | 'bytes', message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

/**
 * Creates `path` (it must not exist: flag `wx`) with mode 0600 and returns a writer for it. If a
 * write fails, the descriptor is closed and the error is thrown from the `add` or `finish` that
 * caused it; deleting the partial file is the caller's (it owns the directory). An `add` that would
 * take the archive past `limits` throws before it writes anything.
 */
export function openZipFile(path: string, limits: { maxEntries: number; maxBytes: number } = zipLimits): ZipFileWriter {
  const fd = openSync(path, 'wx', 0o600);
  let open = true;
  let bytes = 0;
  let entries = 0;
  let centralBytes = 0;
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
  // On a failure the first error is the one thrown; a close that also fails must not replace it.
  const closeAfterFailure = () => {
    try {
      close();
    } catch {
      /* the descriptor is gone either way; `failure` is what is thrown */
    }
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
      closeAfterFailure();
      throw failure;
    }
  };

  return {
    add(name, data) {
      const nameBytes = Buffer.byteLength(name, 'utf8');
      // Local header and name, the data, the data descriptor, then this entry's central header and the end record.
      const after = bytes + 30 + nameBytes + data.byteLength + 16 + centralBytes + 46 + nameBytes + 22;
      if (open && entries + 1 > limits.maxEntries) {
        failure = new ZipLimitError('entries', `team export: the archive would hold more than ${limits.maxEntries} entries, which a ZIP without ZIP64 cannot`);
      } else if (open && after > limits.maxBytes) {
        failure = new ZipLimitError('bytes', `team export: the archive would be more than ${limits.maxBytes} bytes, which a ZIP without ZIP64 cannot address`);
      }
      entries += 1;
      centralBytes += 46 + nameBytes;
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
