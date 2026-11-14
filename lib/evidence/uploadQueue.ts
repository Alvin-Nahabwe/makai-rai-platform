import { formatSize } from '@/lib/format/size';
import { formatMbPair, stripBidiControls } from '@/lib/evidence/format';
import {
  ARCHIVED_TEXT, CONNECTION_LOST_TEXT, EVIDENCE_COPY, ROLE_CHANGED_TEXT, SIGNED_OUT_TEXT, STORAGE_FULL_TEXT, UPLOAD_LIMIT_TEXT,
} from '@/lib/evidence/copy';
import type { RetryState } from '@/lib/client/retrySafeWrite';
import type { EvidenceItemView } from '@/types/api';

/**
 * The states of the files a person is adding (UX-30) and their lines, M-13 to M-19, in the words of lib/evidence/copy.ts.
 * Pure: no React, no server code. Every file name in a line is shown without bidi controls (E14).
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

/**
 * A line of text with the file's name apart from the words around it: the view puts the name in `<bdi>` so a name in a
 * right-to-left script cannot reorder its neighbours (E14). `text` is the three parts joined, as a person reads it.
 */
export interface NamedLine { before: string; name: string; after: string; text: string }

function named(before: string, name: string, after: string): NamedLine {
  return { before, name, after, text: `${before}${name}${after}` };
}
const plain = (text: string): NamedLine => named(text, '', '');

export function statusLine(i: UploadItem): NamedLine & { retry: boolean } {
  const name = stripBidiControls(i.fileName);
  const words = EVIDENCE_COPY.lines;
  if (i.state === 'uploading') {
    const { x, y } = formatMbPair(i.loaded, i.size);
    return { ...named(words.uploadingBefore, name, words.uploadingAfter(x, y)), retry: false };                   // M-13
  }
  if (i.state === 'uploaded') return { ...named(words.uploadedBefore, name, words.uploadedAfter(formatSize(i.size))), retry: false };   // M-14
  switch (i.failure) {
    case 'too_large': return { ...named(words.notUploadedBefore, name, words.tooLargeAfter), retry: false };        // M-15
    case 'wrong_type': return { ...named(words.notUploadedBefore, name, words.wrongTypeAfter), retry: false };      // M-16
    case 'rate_limited': return { ...plain(UPLOAD_LIMIT_TEXT), retry: true };                                       // M-19
    case 'storage_full': return { ...plain(STORAGE_FULL_TEXT), retry: false };                                      // NFR-REL-09
    case 'archived': return { ...plain(ARCHIVED_TEXT), retry: false };                                              // M-12
    case 'role_changed': return { ...plain(ROLE_CHANGED_TEXT), retry: false };                                      // M-09
    case 'signed_out': return { ...plain(SIGNED_OUT_TEXT), retry: false };                                          // M-08
    case 'cut_off':
    case null:
      return { ...plain(CONNECTION_LOST_TEXT), retry: true };                                                       // M-17
  }
}

/** M-18: a file that was still uploading when the page closed. */
export function notUploadedLine(fileName: string): NamedLine {
  return named('', stripBidiControls(fileName), EVIDENCE_COPY.lines.closedAfter);
}

/** NFR-PERF-06: the size and the suggestion of a link, for a file over 2 MB. */
export function largeFileNote(size: number): string | null {
  if (size <= LARGE_FILE_BYTES) return null;
  return EVIDENCE_COPY.lines.largeFile((size / 1e6).toFixed(1));
}

/**
 * The names UX-30's Save-wait rule needs: files still uploading and files that failed, without bidi controls. A parent
 * that renders one wraps it in `<bdi>` (E14).
 */
export function uploadState(items: readonly UploadItem[]): { uploading: string[]; failed: string[] } {
  return {
    uploading: items.filter((i) => i.state === 'uploading').map((i) => stripBidiControls(i.fileName)),
    failed: items.filter((i) => i.state === 'failed').map((i) => stripBidiControls(i.fileName)),
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

/** Appends `item` unless one with its id is already there: a replayed link outcome adds nothing (FR-DEC-07). */
export function appendOnce(list: readonly EvidenceItemView[], item: EvidenceItemView): EvidenceItemView[] {
  return list.some((i) => i.id === item.id) ? [...list] : [...list, item];
}
