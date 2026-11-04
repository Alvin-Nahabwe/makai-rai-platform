import { describe, it, expect } from 'vitest';
import { attachedItems, largeFileNote, notUploadedLine, statusLine, uploadState, type UploadItem } from '@/lib/evidence/uploadQueue';
import type { EvidenceItemView } from '@/types/api';

const item = (o: Partial<UploadItem> = {}): UploadItem => ({
  key: 'k1', fileName: 'costing.xlsx', size: 2_400_000, retry: { requestId: null, sentBody: null }, state: 'uploading', loaded: 0,
  failure: null, item: null, ...o,
});
const view = (id: string): EvidenceItemView => ({
  id, kind: 'file', fileName: `${id}.pdf`, mimeType: 'application/pdf', byteSize: 10, sha256: 'a'.repeat(64), url: null, label: null,
  uploadedBy: null, uploadedAt: '2026-11-02T08:00:00.000Z', erased: null,
});

describe('upload states', () => {
  it('M-13 M-14 M-15 M-16 M-17 M-19: each upload state shows its message', () => {
    expect(statusLine(item({ state: 'uploading', loaded: 800_000, size: 2_400_000 })).text).toBe('Uploading costing.xlsx: 0.8 of 2.4 MB.');
    expect(statusLine(item({ state: 'uploaded', size: 412_000 })).text).toBe('Uploaded costing.xlsx (412 KB).');
    expect(statusLine(item({ state: 'failed', failure: 'too_large' })).text).toBe('Not uploaded: costing.xlsx is larger than 10 MB. Add a link to where it is kept instead.');
    expect(statusLine(item({ state: 'failed', failure: 'wrong_type' })).text).toBe('Not uploaded: costing.xlsx is not a PDF, PNG, JPEG, Office document or ZIP file.');
    expect(statusLine(item({ state: 'failed', failure: 'cut_off' }))).toEqual({ text: 'Not uploaded: connection lost.', retry: true });
    expect(statusLine(item({ state: 'failed', failure: 'rate_limited' }))).toEqual({ text: 'Not uploaded: you can upload 10 files a minute. Wait a minute, then retry.', retry: true });
    expect(statusLine(item({ state: 'failed', failure: 'storage_full' })).text).toBe("This organisation's storage is full. Attach a link instead.");
    expect(statusLine(item({ state: 'failed', failure: 'archived' })).text).toBe('Not saved: this project is archived. Owners and admins can unarchive it.');
  });
  it('NFR-SEC-11: a status line names the file without bidi controls', () => {
    expect(statusLine(item({ fileName: 'invoice‮fdp.exe.pdf', state: 'uploaded', size: 1000 })).text).toBe('Uploaded invoicefdp.exe.pdf (1 KB).');
  });
  it('M-18: a file that did not finish before the page closed is named after reload', () => {
    expect(notUploadedLine('costing.xlsx')).toBe('costing.xlsx was not uploaded before the page closed. Choose the file again.');
  });
  it('NFR-PERF-06: a file over 2 MB gets its size and the link suggestion; a smaller one none', () => {
    expect(largeFileNote(2_400_000)).toBe('2.4 MB. Large files are slow on poor connections; you can link to where the file is kept instead.');
    expect(largeFileNote(2_000_000)).toBeNull();
  });
  it('UX-30 (helper): uploading and failed names are reported for the Save-wait rule', () => {
    expect(uploadState([item({ state: 'uploading' }), item({ fileName: 'b.pdf', state: 'failed', failure: 'cut_off' }), item({ fileName: 'c.pdf', state: 'uploaded' })]))
      .toEqual({ uploading: ['costing.xlsx'], failed: ['b.pdf'] });
  });
  it('UX-30 W-4: the attached items are the carried ones not removed, then the finished uploads in order', () => {
    const items = attachedItems([view('c1')], [item({ state: 'uploaded', item: view('u1') }), item({ state: 'uploading' }), item({ state: 'failed', failure: 'cut_off' }), item({ state: 'uploaded', item: view('u2') })]);
    expect(items.map((i) => i.id)).toEqual(['c1', 'u1', 'u2']);
  });
});
