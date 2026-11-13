import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceBlockView, type EvidenceBlockViewProps } from '@/components/evidence/EvidenceBlockView';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { attachedItems, type UploadItem } from '@/lib/evidence/uploadQueue';
import { HOSTILE_FILE_NAMES } from '../helpers/hostile';
import type { EvidenceItemView } from '@/types/api';

const FILE_VIEW: EvidenceItemView = {
  id: 'e-file', kind: 'file', fileName: 'memo.pdf', mimeType: 'application/pdf', byteSize: 412_000, sha256: 'a'.repeat(64), url: null, label: null,
  uploadedBy: null, uploadedAt: '2026-11-02T08:00:00.000Z', erased: null,
};
const UP_VIEW: EvidenceItemView = { ...FILE_VIEW, id: 'e-up', fileName: 'up.pdf' };
const LINK_VIEW: EvidenceItemView = {
  id: 'e-link', kind: 'link', fileName: null, mimeType: null, byteSize: null, sha256: null, url: 'https://example.org/ethics.pdf', label: 'Ethics approval',
  uploadedBy: null, uploadedAt: '2026-11-02T08:00:00.000Z', erased: null,
};
const up = (o: Partial<UploadItem> = {}): UploadItem => ({
  key: 'k1', fileName: 'costing.xlsx', size: 2_400_000, retry: { requestId: null, sentBody: null }, state: 'uploading', loaded: 0,
  failure: null, item: null, ...o,
});

const view = (o: Partial<EvidenceBlockViewProps> = {}) => renderToStaticMarkup(
  <EvidenceBlockView orgSlug="acme" idBase="evidence" items={[]} added={[]} uploads={[]} notUploaded={[]} disabled={false}
    linkFormOpen={false} linkUrl="" linkLabel="" linkError={null} {...o} />);
/** The text a person reads: tags removed, entities as they display. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
const list = (items: EvidenceItemView[]) => renderToStaticMarkup(<VersionEvidenceList orgSlug="acme" items={items} />);

describe('the evidence block and the version evidence list', () => {
  it('UX-30 FR-RM-01: upload lines are text and no progress element exists', () => {
    const html = view({ uploads: [up({ state: 'uploading', loaded: 800_000, size: 2_400_000 })] });
    expect(text(html)).toContain('Uploading costing.xlsx: 0.8 of 2.4 MB.');
    expect(html).not.toMatch(/<progress|role="progressbar"/);
  });
  it('M-18 UX-30: names left uploading before the page closed are listed after reload', () => {
    expect(text(view({ notUploaded: ['costing.xlsx'] }))).toContain('costing.xlsx was not uploaded before the page closed. Choose the file again.');
  });
  it('NFR-PERF-06: an upload of a large file shows the size note and the link suggestion', () => {
    expect(view({ uploads: [up()] })).toContain('Large files are slow on poor connections');
  });
  it('M-17 UX-30: a failed upload has Retry upload and Cancel/Remove controls naming the file, announced through an alert; a finished one politely', () => {
    const failed = view({ uploads: [up({ state: 'failed', failure: 'cut_off' })] });
    expect(failed).toMatch(/<button[^>]*aria-label="Retry upload costing\.xlsx"/);
    expect(text(failed)).toContain('Not uploaded: connection lost.');
    expect(failed).toMatch(/role="alert"/);
    expect(view({ uploads: [up({ state: 'uploading' })] })).toMatch(/<button[^>]*aria-label="Cancel upload costing\.xlsx"/);
    const done = view({ uploads: [up({ state: 'uploaded', size: 412_000 })] });
    expect(text(done)).toContain('Uploaded costing.xlsx (412 KB).');
    expect(done).toMatch(/role="status"/);
  });
  it('FR-EVD-04: carried items show their version and each has a Remove control naming the file', () => {
    const html = view({ items: [FILE_VIEW], fromVersionNumber: 2 });
    expect(html).toContain('from version 2');
    expect(html).toMatch(/<button[^>]*aria-label="Remove memo.pdf"/);
  });
  it('NFR-SEC-10 FR-EVD-03: a link is a plain anchor with noopener noreferrer, never a fetch target', () => {
    const html = list([LINK_VIEW]);
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.org\/ethics.pdf"[^>]*rel="noopener noreferrer"/);
    expect(html).not.toMatch(/<(img|iframe|link|script)[^>]*example\.org/);
  });
  it('NFR-SEC-11 E14 F2: a link address with a right-to-left override shows without it, inside bdi; the href stays as stored', () => {
    const url = 'https://e.org/\u202Eexe.pdf';
    for (const label of [null, 'Ethics']) {
      const html = list([{ ...LINK_VIEW, url, label }]);
      expect(text(html)).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(text(html)).toContain('https://e.org/exe.pdf');
      expect(html).toMatch(/<bdi>[^<]*(https:\/\/e\.org\/exe\.pdf|Ethics)[^<]*<\/bdi>/);
      expect(html).toContain(`href="${url}"`);
    }
  });
  it('NFR-SEC-11: hostile names and labels render as text', () => {
    const items: EvidenceItemView[] = [...HOSTILE_FILE_NAMES.map((n, i) => ({ ...FILE_VIEW, id: `e${i}`, fileName: n })), { ...LINK_VIEW, url: 'javascript:alert(1)', label: '<script>alert(1)</script>' }];
    const html = list(items);
    expect(html).not.toMatch(/<img src=x|<script>|href="javascript:/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('FR-EVD-05: an erased file shows the erased line with its date and no download link', () => {
    const html = list([{ ...FILE_VIEW, erased: { erasedOn: '2026-11-02' } }]);
    expect(html).toContain("<bdi>memo.pdf</bdi> . File erased on 2 Nov 2026 on the organisation&#x27;s instruction. Its fingerprint is kept, so seals that include it still check.");
    expect(html).not.toContain(`/evidence/${FILE_VIEW.id}`);
    expect(list([{ ...FILE_VIEW, fileName: null, erased: { erasedOn: '2026-11-02' } }])).toContain('File name erased');
  });
  it('NFR-A11Y-02 UX-30: the block is a fieldset with legend "Evidence", its inputs labelled and described by the help text', () => {
    const html = view({ linkFormOpen: true });
    expect(html).toMatch(/<fieldset[\s\S]*<legend>Evidence<\/legend>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Web address<\/label>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Label \(optional\)<\/label>/);
    expect(html).toMatch(/aria-describedby="[^"]*evidence-help/);
    expect(html).toContain('PDF, PNG, JPEG, Office documents or ZIP, up to 10 MB each. Do not upload datasets or files about the people your system affects. Add a link to where they are kept instead.');
    expect(html.match(/<button(?![^>]*type="button")/g)).toBeNull();
  });
  it('UX-30: the block names itself once: one legend "Evidence" and no heading', () => {
    const html = view({});
    expect(html.match(/<legend>Evidence<\/legend>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h[1-6][\s>]/);
  });
  it('CR-1: while a link is being added the Add link button is disabled, so a second press sends nothing', () => {
    expect(view({ linkFormOpen: true, linkPending: true })).toMatch(/<button[^>]*disabled=""[^>]*>Add link<\/button>/);
    expect(view({ linkFormOpen: true })).not.toMatch(/<button[^>]*disabled=""[^>]*>Add link<\/button>/);
  });
  it('NFR-A11Y-02: a link error is announced and tied to the address input', () => {
    const html = view({ linkFormOpen: true, linkUrl: 'ftp://x', linkError: 'Enter a web address that starts with http:// or https://.' });
    expect(html).toMatch(/role="alert"[^>]*>Enter a web address that starts with http:\/\/ or https:\/\/\./);
    expect(html).toMatch(/aria-invalid="true"/);
  });
  it('UX-31 FR-PRJ-03: a disabled block renders items with no control', () => {
    expect(view({ items: [FILE_VIEW], disabled: true })).not.toMatch(/<button|<input/);
  });
  it("FR-AUTHZ-01 FR-EVD-04 UX-30 (R12-18): the block's only gate is its disabled prop; enabled, Add a file, Add a link and Remove show for whoever holds the form", () => {
    const on = view({ items: [FILE_VIEW], disabled: false });
    expect(on).toContain('Add a file');
    expect(on).toContain('Add a link');
    expect(on).toMatch(/<button[^>]*aria-label="Remove memo.pdf"/);
    expect(view({ items: [FILE_VIEW], disabled: true })).not.toMatch(/Add a file|Add a link|Remove memo\.pdf/);
  });
  it('FR-AUTHZ-01 FR-AUTHZ-02 (R12-18): the block takes no permission prop, reads no policy, and Remove sends no DELETE', () => {
    for (const f of ['components/evidence/EvidenceBlock.tsx', 'components/evidence/EvidenceBlockView.tsx'])
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/canCreate|canDelete|decision:write|evidence:(create|delete)|from '@\/lib\/authz|lib\/authz\/policy/);
    for (const f of ['components/evidence/EvidenceBlock.tsx', 'lib/client/evidenceUpload.ts']) expect(readFileSync(f, 'utf8'), f).not.toMatch(/['"]DELETE['"]/);
  });
  it('NFR-SEC-11 FR-EVD-02: a right-to-left override name renders without its controls, inside bdi', () => {
    const rtl = HOSTILE_FILE_NAMES.find((n) => /\u202E/.test(n))!;
    for (const html of [list([{ ...FILE_VIEW, fileName: rtl }]), view({ items: [{ ...FILE_VIEW, fileName: rtl }] })]) {
      expect(html).toMatch(/<bdi>(?:(?!<\/bdi>)[\s\S])*invoicefdp\.exe\.pdf(?:(?!<\/bdi>)[\s\S])*<\/bdi>/);
      expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    }
  });
  it('NFR-SEC-11 E14: an uploading line and an M-18 line hold the name inside bdi, without bidi controls', () => {
    const rtl = HOSTILE_FILE_NAMES.find((n) => /\u202E/.test(n))!;
    const html = view({ uploads: [up({ fileName: rtl, state: 'uploading' })], notUploaded: [rtl] });
    expect(html.match(/<bdi>invoicefdp\.exe\.pdf<\/bdi>/g)).toHaveLength(2);
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(text(html)).toContain('Uploading invoicefdp.exe.pdf: 0.0 of 2.4 MB.');
    expect(text(html)).toContain('invoicefdp.exe.pdf was not uploaded before the page closed. Choose the file again.');
    const failed = view({ uploads: [up({ fileName: rtl, state: 'failed', failure: 'too_large' })] });
    expect(failed).toContain('<bdi>invoicefdp.exe.pdf</bdi>');
  });
  it('UX-39 FR-EVD-02: a downloadable file is a DownloadLink with its kind and size', () => {
    expect(list([FILE_VIEW])).toContain('memo.pdf (PDF, 412 KB)');
    expect(list([FILE_VIEW])).toContain('href="/api/v1/orgs/acme/evidence/e-file"');
  });
  it('UX-30 W-4: the attached items are the carried ones not removed, then the finished uploads; onChange gets their ids', () => {
    const items = attachedItems([FILE_VIEW], [up({ state: 'uploaded', item: UP_VIEW }), up({ state: 'uploading' }), up({ state: 'failed', failure: 'cut_off' })]);
    expect(items.map((i) => i.id)).toEqual([FILE_VIEW.id, UP_VIEW.id]);
  });
});
