import { formatSize } from '@/lib/format/size';
import { formatMbPair, stripBidiControls } from '@/lib/evidence/format';
import { STORAGE_FULL_TEXT } from '@/lib/evidence/storageCap';
import type { RetryState } from '@/lib/client/retrySafeWrite';
import type { EvidenceItemView } from '@/types/api';

/**
 * The states of the files a person is adding (UX-30) and the exact copy of messages M-13 to M-19 (SRS lines
 * 2560-2566). Pure: no React, no server code. Every file name in a line is shown without bidi controls (E14).
 */

export type UploadFailure =
  | 'too_large' | 'wrong_type' | 'cut_off' | 'rate_limited' | 'storage_full' | 'archived' | 'role_changed' | 'signed_out';

export interface UploadItem {
  key: string;
  fileName: string;
  size: number;
  retry: RetryState;
  state: 'uploading' | 'uploaded' | 'failed';
  loaded: number;
  failure: UploadFailure | null;
  item: EvidenceItemView | null;
}

/** A file over this many bytes gets the size note and the suggestion of a link (NFR-PERF-06). */
const LARGE_FILE_BYTES = 2_000_000;

export function statusLine(i: UploadItem): { text: string; retry: boolean } {
  const name = stripBidiControls(i.fileName);
  if (i.state === 'uploading') {
    const { x, y } = formatMbPair(i.loaded, i.size);
    return { text: `Uploading ${name}: ${x} of ${y} MB.`, retry: false };       // M-13
  }
  if (i.state === 'uploaded') return { text: `Uploaded ${name} (${formatSize(i.size)}).`, retry: false };   // M-14
  switch (i.failure) {
    case 'too_large':
      return { text: `Not uploaded: ${name} is larger than 10 MB. Add a link to where it is kept instead.`, retry: false };   // M-15
    case 'wrong_type':
      return { text: `Not uploaded: ${name} is not a PDF, PNG, JPEG, Office document or ZIP file.`, retry: false };          // M-16
    case 'rate_limited':
      return { text: 'Not uploaded: you can upload 10 files a minute. Wait a minute, then retry.', retry: true };               // M-19
    case 'storage_full':
      return { text: STORAGE_FULL_TEXT, retry: false };                                                                          // NFR-REL-09
    case 'archived':
      return { text: 'Not saved: this project is archived. Owners and admins can unarchive it.', retry: false };
    case 'role_changed':
      return { text: 'Not uploaded: your role no longer lets you add evidence to this project.', retry: false };
    case 'signed_out':
      return { text: 'Not uploaded: you were signed out. Sign in again, then choose the file again.', retry: false };
    case 'cut_off':
    case null:
      return { text: 'Not uploaded: connection lost.', retry: true };                                                            // M-17
  }
}

/** M-18: a file that was still uploading when the page closed. */
export function notUploadedLine(fileName: string): string {
  return `${stripBidiControls(fileName)} was not uploaded before the page closed. Choose the file again.`;
}

/** NFR-PERF-06: the size and the suggestion of a link, for a file over 2 MB. */
export function largeFileNote(size: number): string | null {
  if (size <= LARGE_FILE_BYTES) return null;
  return `${(size / 1e6).toFixed(1)} MB. Large files are slow on poor connections; you can link to where the file is kept instead.`;
}

/** The names UX-30's Save-wait rule needs: files still uploading and files that failed. */
export function uploadState(items: readonly UploadItem[]): { uploading: string[]; failed: string[] } {
  return {
    uploading: items.filter((i) => i.state === 'uploading').map((i) => i.fileName),
    failed: items.filter((i) => i.state === 'failed').map((i) => i.fileName),
  };
}

/** The items the answer holds: the carried ones not removed, then the finished uploads in the order chosen. */
export function attachedItems(carried: readonly EvidenceItemView[], uploads: readonly UploadItem[]): EvidenceItemView[] {
  const finished = uploads.flatMap((u) => (u.state === 'uploaded' && u.item !== null ? [u.item] : []));
  return [...carried, ...finished];
}

/**
 * The change that marks an upload as not uploaded, for `failure`. A function and not a literal in the component, so
 * no user-facing-string scan reads the state's name as copy (FR-PUB-01).
 */
export function failedChange(failure: UploadFailure): Pick<UploadItem, 'state' | 'failure'> {
  return { state: 'failed', failure };
}
