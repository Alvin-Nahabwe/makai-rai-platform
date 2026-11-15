import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceBlockView, type EvidenceBlockViewProps } from '@/components/evidence/EvidenceBlockView';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { attachedItems, type UploadItem } from '@/lib/evidence/uploadQueue';
import { CONNECTION_LOST_TEXT, EVIDENCE_COPY, LINK_REFUSAL_COPY } from '@/lib/evidence/copy';
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
  it('UX-30 FR-RM-01 C5: an uploading line is text, with one native progress element inside [data-upload-progress], labelled with the file', () => {
    const html = view({ uploads: [up({ state: 'uploading', loaded: 800_000, size: 2_400_000 })] });
    expect(text(html)).toContain('Uploading costing.xlsx: 0.8 of 2.4 MB.');
    expect(html.match(/<progress/g)).toHaveLength(1);
    expect(html).toMatch(/<span data-upload-progress[^>]*><progress[^>]*value="800000"[^>]*max="2400000"[^>]*aria-label="Uploading costing\.xlsx"[^>]*><\/progress><\/span>/);
    expect(html).not.toMatch(/role="progressbar"/);
    // A file that failed or finished has no progress element.
    expect(view({ uploads: [up({ state: 'failed', failure: 'cut_off' }), up({ key: 'k2', state: 'uploaded', size: 412_000 })] })).not.toMatch(/<progress/);
  });
  it('C5: "Save without" beside an uploading file while no Save waits, one button for the block; none while a Save waits', () => {
    const saveWithout = { label: 'Save without these files', onPress: () => {} };
    const two = view({ uploads: [up(), up({ key: 'k2', fileName: 'b.pdf' })], saveWithout });
    expect(two.match(/>Save without these files</g)).toHaveLength(1);
    expect(two.indexOf('Save without these files')).toBeGreaterThan(two.indexOf('b.pdf'));
    expect(view({ uploads: [up()], saveWithout: null })).not.toContain('Save without');
    expect(view({ uploads: [up({ state: 'failed', failure: 'cut_off' })], saveWithout })).not.toContain('Save without');
  });
  it('M-18 UX-30: names left uploading before the page closed are listed after reload', () => {
    expect(text(view({ notUploaded: ['costing.xlsx'] }))).toContain('costing.xlsx was not uploaded before the page closed. Choose the file again.');
  });
  it('NFR-PERF-06: an upload of a large file shows the size note and the link suggestion', () => {
    expect(text(view({ uploads: [up()] }))).toContain(EVIDENCE_COPY.lines.largeFile('2.4'));
  });
  it('M-17 UX-30: a failed upload has Retry upload and Cancel/Remove controls naming the file, announced through an alert; a finished one politely', () => {
    const failed = view({ uploads: [up({ state: 'failed', failure: 'cut_off' })] });
    expect(failed).toMatch(/<button[^>]*aria-label="Retry upload costing\.xlsx"/);
    expect(text(failed)).toContain(CONNECTION_LOST_TEXT);
    expect(failed).toMatch(/role="alert"/);
    expect(view({ uploads: [up({ state: 'uploading' })] })).toMatch(/<button[^>]*aria-label="Cancel upload costing\.xlsx"/);
    const done = view({ uploads: [up({ state: 'uploaded', size: 412_000 })] });
    expect(text(done)).toContain('Uploaded costing.xlsx (412 KB).');
    expect(done).toMatch(/role="status"/);
  });
  it('FR-EVD-04: carried items show their version and each has a Remove control naming the file', () => {
    const html = view({ items: [FILE_VIEW], fromVersionNumber: 2 });
    expect(html).toContain(EVIDENCE_COPY.fromCurrent);
    expect(html).not.toContain('version 2');
    expect(html).toMatch(/<button[^>]*aria-label="Remove memo.pdf"/);
  });
  it('NFR-SEC-10 FR-EVD-03: a link is a plain anchor with noopener noreferrer, never a fetch target', () => {
    const html = list([LINK_VIEW]);
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.org\/ethics.pdf"[^>]*rel="noopener noreferrer"/);
    expect(html).not.toMatch(/<(img|iframe|link|script)[^>]*example\.org/);
  });
  it('NFR-SEC-11 E14 F2: a link address with a right-to-left override shows without it, inside bdi; the href is the one parse of the stored address', () => {
    const url = 'https://e.org/\u202Eexe.pdf';
    for (const label of [null, 'Ethics']) {
      const html = list([{ ...LINK_VIEW, url, label }]);
      expect(text(html)).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(text(html)).toContain(label === null ? 'https://e.org/exe.pdf' : 'Ethics (e.org, opens another site)');
      expect(html).toMatch(/<bdi>[^<]*(https:\/\/e\.org\/exe\.pdf|Ethics)[^<]*<\/bdi>/);
      // webLink (lib/evidence/format.ts): the parsed address, the control percent-encoded in the path, as the browser sends it.
      expect(html).toContain('href="https://e.org/%E2%80%AEexe.pdf"');
    }
  });

  describe('T3 item 8: one rule for an evidence link, webLink (the same parse gives the href and the host shown)', () => {
    it('a name that claims another site is followed by the host the link really goes to', () => {
      const html = list([{ ...LINK_VIEW, url: 'https://evil.example/login', label: 'https://bank.example' }]);
      expect(html).toMatch(/<a href="https:\/\/evil\.example\/login" rel="noopener noreferrer"><bdi>https:\/\/bank\.example<\/bdi> <span class="evidence-item__host">\(evil\.example, opens another site\)<\/span><\/a>/);
      expect(text(html)).toBe(`https://bank.example ${EVIDENCE_COPY.list.linkTo('evil.example')}`);
    });

    it('"https:evil.example" goes to evil.example and says so; it is never a same-site path', () => {
      for (const label of [null, 'Our policy']) {
        const html = list([{ ...LINK_VIEW, url: 'https:evil.example', label }]);
        expect(html).toContain('href="https://evil.example/"');
        expect(html).not.toContain('href="https:evil.example"');
        expect(text(html)).toContain(EVIDENCE_COPY.list.linkTo('evil.example'));
      }
    });

    it('bidi controls in the host: no link at all, the cleaned address shown whole as text', () => {
      const url = `https://ex${String.fromCharCode(0x202e)}ample.org/`;
      for (const label of [null, 'Guide']) {
        const html = list([{ ...LINK_VIEW, url, label }]);
        expect(html).not.toMatch(/<a /);
        expect(text(html)).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
        expect(text(html)).toBe(label === null ? 'https://example.org/' : 'Guide (https://example.org/)');
        expect(text(html)).not.toContain('opens another site');
      }
    });
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
    expect(text(html)).toContain(`memo.pdf${EVIDENCE_COPY.list.fileErased('2 Nov 2026')}`);
    expect(html).toContain('<bdi>memo.pdf</bdi>. File erased on 2 Nov 2026 at your organisation&#x27;s request.');
    expect(html).not.toContain(`/evidence/${FILE_VIEW.id}`);
    expect(list([{ ...FILE_VIEW, fileName: null, erased: { erasedOn: '2026-11-02' } }])).toContain('File name erased');
  });
  it('NFR-A11Y-02 UX-30: the block is a fieldset with legend "Evidence", its inputs labelled and described by the help text', () => {
    const html = view({ linkFormOpen: true });
    expect(html).toMatch(/<fieldset[\s\S]*<legend>Evidence<\/legend>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Web address<\/label>/);
    expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>${EVIDENCE_COPY.linkName.replace(/[()]/g, '\\$&')}</label>`));
    expect(html).toMatch(/aria-describedby="[^"]*evidence-help/);
    const help = html.match(/<(\w+)[^>]*id="evidence-help"[^>]*>([\s\S]*?)<\/\1>/)?.[2] ?? '';
    expect(text(help)).toContain(EVIDENCE_COPY.help.keep);
    expect(text(help)).toContain(EVIDENCE_COPY.help.types);
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
  it('B3: while a link is being added the link form says so, in a status region that is there before its words', () => {
    const region = (html: string) => html.match(/<p[^>]*role="status"[^>]*data-link-adding[^>]*>([^<]*)<\/p>/)?.[1];
    expect(region(view({ linkFormOpen: true, linkPending: true }))).toBe('Adding the link...');
    expect(EVIDENCE_COPY.link.adding).toBe('Adding the link...');
    // Empty, not absent, until then: a live region added with its text is often not announced.
    expect(region(view({ linkFormOpen: true }))).toBe('');
    expect(view({})).not.toMatch(/data-link-adding/);
  });
  it('while the parent\'s save is out, Add link is aria-disabled and described by the reason, never natively disabled, and the two boxes are read-only', () => {
    const html = view({ linkFormOpen: true, held: true });
    const button = html.match(/<button[^>]*>Add link<\/button>/)![0];
    expect(button).toMatch(/aria-disabled="true"/);
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).toMatch(/aria-describedby="evidence-link-held"/);
    expect(html).toMatch(/<p[^>]*id="evidence-link-held"[^>]*>Wait for the save to finish, then add it\.<\/p>/);
    expect(EVIDENCE_COPY.link.waitForSave).toBe('Wait for the save to finish, then add it.');
    for (const id of ['evidence-link-url', 'evidence-link-label']) {
      const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))![0];
      expect(input).toMatch(/\sreadOnly=""/i);
      expect(input).toMatch(/aria-describedby="[^"]*evidence-link-held/);
    }
    const free = view({ linkFormOpen: true });
    expect(free).not.toMatch(/aria-disabled|readonly|evidence-link-held/i);
  });
  it('an address typed and not added: the refusal marks the address box and is tied to it', () => {
    expect(EVIDENCE_COPY.link.typedNotAdded).toBe('Not saved. You typed a web address but did not add it. Select Add link, or clear the box, then save.');
    const html = view({ linkFormOpen: true, linkUrl: 'https://example.org/x', linkRefused: true });
    const address = html.match(/<input[^>]*id="evidence-link-url"[^>]*>/)![0];
    expect(address).toMatch(/aria-invalid="true"/);
    expect(address).toMatch(/aria-describedby="evidence-help evidence-link-refused"/);
    expect(html).toMatch(/role="alert"[^>]*>(?:(?!<\/div>)[\s\S])*You typed a web address but did not add it/);
    expect(html.match(/<input[^>]*id="evidence-link-label"[^>]*>/)![0]).not.toMatch(/aria-invalid/);
  });
  it('third commit, N2: the refusal of a save never takes the place of the box\'s own line: both are shown, the box\'s own first', () => {
    const html = view({ linkFormOpen: true, linkUrl: 'example.org/x', linkError: EVIDENCE_COPY.link.address, linkRefused: true });
    const alert = html.match(/<div[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/)![1];
    const own = alert.indexOf('Enter a web address that starts with');
    const refusal = alert.indexOf('You typed a web address but did not add it');
    expect(own).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(own);
    expect(html.match(/<input[^>]*id="evidence-link-url"[^>]*>/)![0]).toMatch(/aria-describedby="evidence-help evidence-link-error evidence-link-refused"/);
  });
  it('the words of a save that waits for a link are one sentence for both forms', () => {
    expect(EVIDENCE_COPY.link.waiting).toBe('Waiting for the link to be added.');
  });
  it('NFR-A11Y-02: a link error is announced and tied to the address input', () => {
    const html = view({ linkFormOpen: true, linkUrl: 'ftp://x', linkError: 'Enter a web address that starts with http:// or https://.' });
    expect(html).toMatch(/role="alert"[^>]*>(?:(?!<\/div>)[\s\S])*Enter a web address that starts with http:\/\/ or https:\/\/\./);
    expect(html).toMatch(/aria-describedby="evidence-help evidence-link-error"/);
    expect(html).toMatch(/id="evidence-link-error">Enter a web address/);
    expect(html).toMatch(/aria-invalid="true"/);
  });
  it('17c review: only the field its message is about is marked invalid; a refusal marks neither', () => {
    const inputs = (html: string) => {
      const tag = (id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))![0];
      return { url: tag('evidence-link-url'), name: tag('evidence-link-label') };
    };
    const invalid = (tag: string) => /aria-invalid="true"/.test(tag) && /\bui-input--invalid\b/.test(tag);
    const unmarked = (tag: string) => !/aria-invalid=/.test(tag) && !/\bui-input--invalid\b/.test(tag);
    const address = inputs(view({ linkFormOpen: true, linkError: EVIDENCE_COPY.link.address }));
    expect(invalid(address.url)).toBe(true);
    expect(unmarked(address.name)).toBe(true);
    const name = inputs(view({ linkFormOpen: true, linkError: EVIDENCE_COPY.link.nameTooLong(200) }));
    expect(unmarked(name.url)).toBe(true);
    expect(invalid(name.name)).toBe(true);
    for (const refusal of [LINK_REFUSAL_COPY.signedOut, LINK_REFUSAL_COPY.archived, LINK_REFUSAL_COPY.rateLimited, LINK_REFUSAL_COPY.connectionLost]) {
      const r = inputs(view({ linkFormOpen: true, linkError: refusal }));
      expect(unmarked(r.url), refusal).toBe(true);
      expect(unmarked(r.name), refusal).toBe(true);
    }
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
  it('plan 1A Task 17 (X-6): the block wears the kit: named buttons in its compact secondary classes, no kit stylesheet imported directly', () => {
    const html = view({ items: [FILE_VIEW], uploads: [up({ state: 'failed', failure: 'cut_off' })], linkFormOpen: true });
    for (const name of ['Remove memo.pdf', 'Retry upload costing.xlsx', 'Remove costing.xlsx'])
      expect(html).toMatch(new RegExp(`<button[^>]*class="ui-button ui-button--secondary ui-button--compact"[^>]*aria-label="${name.replace('.', '\\.')}"`));
    expect(html).toMatch(/<button[^>]*class="ui-button ui-button--secondary"[^>]*>Add a file<\/button>/);
    expect(html).toMatch(/<button[^>]*class="ui-button ui-button--secondary"[^>]*aria-expanded="true"[^>]*>Add a link<\/button>/);
    expect(html).toMatch(/<input(?=[^>]*\bid="evidence-link-url")(?=[^>]*\bclass="ui-input")/);
    expect(html).toMatch(/<input(?=[^>]*\bid="evidence-file")(?=[^>]*\bclass="visually-hidden")/);
    expect(html).not.toMatch(/style="/);
    const source = readFileSync('components/evidence/EvidenceBlockView.tsx', 'utf8');
    expect(source).not.toMatch(/import ['"]@\/components\/ui\/[^'"]+\.css['"]/);
    expect(source).toContain("import './EvidenceBlock.css';");
  });
  it('B#252 B#262 Q9: the help is one element in two lines, and a link refusal is announced under the address', () => {
    const html = view({ linkFormOpen: true, linkError: 'Not added. The connection was lost. Try again.' });
    expect(text(html)).toContain('Do not upload datasets or files about the people your system affects. Add a link to where they are kept instead.');
    expect(text(html)).toContain('PDF, PNG, JPEG, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or ZIP. Up to 10 MB each.');
    expect(html.match(/id="evidence-help"/g)).toHaveLength(1);
    expect(html).toMatch(/role="alert"[\s\S]*Not added\. The connection was lost\. Try again\./);
    expect(html).toContain('>Name for the link (optional)</label>');
  });
  it('UX-30 W-4: the attached items are the carried ones not removed, then the finished uploads; onChange gets their ids', () => {
    const items = attachedItems([FILE_VIEW], [up({ state: 'uploaded', item: UP_VIEW }), up({ state: 'uploading' }), up({ state: 'failed', failure: 'cut_off' })]);
    expect(items.map((i) => i.id)).toEqual([FILE_VIEW.id, UP_VIEW.id]);
  });
});
