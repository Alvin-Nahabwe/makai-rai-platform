import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { Document, Page, renderToBuffer, Text } from '@react-pdf/renderer';
import type { DocumentType } from '@/types/record';
import { RENDERERS, type RenderInput, type ResolvedField } from '@/lib/documents/render';
import { renderDataCard } from '@/lib/documents/render/dataCard';
import { renderModelCard } from '@/lib/documents/render/modelCard';
import { PDF_FONT_FAMILY, breakPoints, UNPRINTABLE_NOTE, fontCovers, printable, registerPdfFont } from '@/lib/documents/render/font';
import { NOT_RECORDED, SEALED_NOTE, STATEMENT } from '@/lib/documents/resolve';
import { formatFingerprint } from '@/lib/seal/format';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { claimMatches } from '@/lib/claims/pattern';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { pdfPageRuns, pdfTextRuns } from '../helpers/pdfText';

const FINGERPRINT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const squash = (s: string) => s.replace(/\s+/g, ' ');

function input(type: DocumentType, over: { text?: (f: ResolvedField, i: number) => string | null; fields?: number } = {}): RenderInput {
  const map = loadFieldMap(type);
  const seals = [{ sealId: 's1', sealNumber: 2, reviewId: 'r1', reviewName: 'Pre-processing review 1', fingerprint: FINGERPRINT }];
  const picked = map.fields.slice(0, over.fields ?? 12);
  const fields: ResolvedField[] = picked.map((f): ResolvedField => ({
    fieldId: f.fieldId, label: f.label, section: f.section, text: null, provenance: `From Q-PP-12 v1 (content 5.0.0). Decided by Amina; declared 2 Nov 2026.`,
  })).map((f, i) => ({ ...f, text: over.text ? over.text(f, i) : `Fixture answer ${i + 1} for ${f.fieldId}.` }));
  fields.push({
    fieldId: 'ZZ-SEALS', label: 'Seals used', section: 'Record and sign-off',
    text: `Seal 2 of Pre-processing review 1: sealed 3 Nov 2026 09:00:00 UTC by Amina (owner); decisions entered by 2 people. Fingerprint ${formatFingerprint(FINGERPRINT, 'full')}`,
    provenance: '',
  });
  return { map, fields, stamp: { kind: 'issued', issuedAt: '2026-11-03T10:42:07.000Z', seals }, organisationName: 'Org', projectName: 'Project' };
}
const inputWithText = (type: DocumentType, text: string) => input(type, { text: () => text });

const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).status !== null;

describe('long tokens (C4 CR-2)', () => {
  const url = `https://example.org/${'abcdefghij'.repeat(30)}TAIL`;   // 324 characters, no space
  const typed = `${'x'.repeat(1997)}END`;                              // a 2000-character typed value, no space
  const squeeze = (t: string) => t.replace(/[\s-]+/g, '');

  it('NFR-A11Y-06 FR-DOC-02: a word longer than 24 characters gets break points every 16 characters, a shorter one none, and no space is inserted', () => {
    expect(breakPoints('short')).toEqual(['short']);
    expect(breakPoints('x'.repeat(24))).toEqual(['x'.repeat(24)]);
    expect(breakPoints('y'.repeat(40))).toEqual(['y'.repeat(16), 'y'.repeat(16), 'y'.repeat(8)]);
    expect(breakPoints(url).join('')).toBe(url);
    expect(breakPoints('\u014B'.repeat(30)).join('')).toBe('\u014B'.repeat(30));
  });

  it('NFR-A11Y-06 FR-DOC-02: a 324-character address and a 2000-character typed value are each printed whole, in order, in the PDF', async () => {
    const { pdf, plainText } = await renderDataCard(inputWithText('data_card', `${url}\n${typed}`));
    const printed = squeeze(pdfTextRuns(pdf).join(' '));
    expect(printed).toContain(squeeze(url));
    expect(printed).toContain(squeeze(typed));
    expect(plainText).toContain(url);                       // the plain-text copy keeps the exact text
    expect(plainText).not.toContain('\u200b');              // and no zero-width space is ever inserted
  });

  it.skipIf(!HAS_PDFTOTEXT && !process.env.CI)('NFR-A11Y-06 (pdftotext): every printed word lies inside the page, and the text read back holds every character', async () => {
    const { pdf } = await renderDataCard(inputWithText('data_card', `${url}\n${typed}`));
    const dir = mkdtempSync(join(tmpdir(), 'doca-long-'));
    try {
      writeFileSync(join(dir, 'x.pdf'), pdf);
      const bbox = execFileSync('pdftotext', ['-bbox', join(dir, 'x.pdf'), '-'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
      const pages = [...bbox.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)];
      expect(pages.length).toBeGreaterThan(0);
      let words = 0;
      for (const [, w, h, inner] of pages) {
        expect(Number(w)).toBeGreaterThan(500);
        for (const m of inner.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g)) {
          words += 1;
          const [xMin, yMin, xMax, yMax] = [m[1], m[2], m[3], m[4]].map(Number);
          expect([xMin >= 0, yMin >= 0, xMax <= Number(w), yMax <= Number(h)]).toEqual([true, true, true, true]);
        }
      }
      expect(words).toBeGreaterThan(50);
      const text = execFileSync('pdftotext', [join(dir, 'x.pdf'), '-'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
      expect(squeeze(text)).toContain(squeeze(url));
      expect(squeeze(text)).toContain(squeeze(typed));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('document renderers', () => {
  it('NFR-A11Y-06: each PDF has its title, language en, selectable text, and text in field-map order', async () => {
    for (const [type, title] of [['data_card', 'Data card'], ['model_card', 'Model card']] as const) {
      const inp = input(type);
      const { pdf } = await RENDERERS[type]!(inp);
      const s = pdf.toString('latin1');
      expect(s).toMatch(new RegExp(`\\(${title}\\)`));
      expect(s).toContain('/Lang (en)');
      const joined = squash(pdfTextRuns(pdf).join(' '));
      const at = inp.fields.map((f) => joined.indexOf(squash(f.label)));
      expect(at.every((x) => x >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('FR-DOC-02 (D8): every page carries the type, the issue time to the second in UTC, the statement and the sealed note', async () => {
    const { pdf } = await renderDataCard(input('data_card', { fields: 35, text: (f) => `${'A long answer the team wrote about this field. '.repeat(8)}${f.fieldId}` }));
    const pages = pdfPageRuns(pdf);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const t = squash(p.join(' '));
      expect(t).toContain('Data card');
      expect(t).toContain('3 Nov 2026 10:42:07 UTC');
      expect(t).toContain(STATEMENT);
      expect(t).toContain(SEALED_NOTE);
    }
    expect(pages.flat().join(' ')).not.toMatch(/verif/i);                       // no verification code or address (ruling 5)
  });

  it('FR-DOC-05: the seals list prints each full fingerprint in groups of four', async () => {
    const { pdf } = await renderModelCard(input('model_card'));
    expect(squash(pdfTextRuns(pdf).join(' '))).toContain(FINGERPRINT.match(/.{4}/g)!.join(' '));
  });

  it('NFR-SEC-11 FR-DOC-02: hostile strings print literally in the PDF and the plain text', async () => {
    const { pdf, plainText } = await renderDataCard(inputWithText('data_card', HOSTILE_STRINGS.join(' ')));
    // react-pdf writes a leading "<", "[" or quote as a run of its own on the same visual line, so the runs are compared
    // with their white space removed: the characters are all there, in order, none interpreted.
    const runs = pdfTextRuns(pdf).join('').replace(/\s+/g, '');
    for (const h of HOSTILE_STRINGS) {
      expect(runs).toContain(h.replace(/\s+/g, ''));
      expect(plainText).toContain(h);
    }
  });

  it('FR-DOC-07 (helper for DOC-b): the plain text holds every field label and text the PDF holds, in the same order', async () => {
    const inp = input('data_card', { text: (_f, i) => (i === 3 ? null : `Fixture answer ${i}`) });
    const { pdf, plainText } = await renderDataCard(inp);
    let from = 0;
    for (const f of inp.fields) {
      const at = plainText.indexOf(f.label, from);
      expect(at, f.fieldId).toBeGreaterThanOrEqual(from);
      from = at;
      expect(plainText).toContain(f.text ?? NOT_RECORDED);
    }
    expect(plainText).toContain(NOT_RECORDED);
    expect(squash(pdfTextRuns(pdf).join(' '))).toContain(inp.fields[0].text!);
    expect(plainText.split(STATEMENT)).toHaveLength(2);                         // the footer once, at the end
  });

  it('NFR-A11Y-06 (A11 (b)): Luganda ŋ prints in the embedded Geist font, ɔ prints as ? with the one-line note, and the plain text keeps both', async () => {
    expect([fontCovers(0x014b), fontCovers(0x0254)]).toEqual([true, false]);
    const { pdf, plainText } = await renderDataCard(inputWithText('data_card', 'Nankya ŋ and Okɔ'));
    const runs = squash(pdfTextRuns(pdf).join(' '));
    expect(runs).toContain('Nankya ŋ and Ok?');
    expect(runs).toContain(UNPRINTABLE_NOTE);
    expect(plainText).toContain('Nankya ŋ and Okɔ');
    expect(plainText).not.toContain(UNPRINTABLE_NOTE);
    expect(pdf.toString('latin1')).toMatch(/\/BaseFont \/[A-Z]{6}\+Geist/);
    const { pdf: plain } = await renderDataCard(inputWithText('data_card', 'Plain text only'));
    expect(squash(pdfTextRuns(plain).join(' '))).not.toContain(UNPRINTABLE_NOTE);
  });

  it('NFR-A11Y-06 (A11 (b)): printable replaces every code point the font lacks and reports whether it did', () => {
    expect(printable('Okɔ ɛ')).toEqual({ text: 'Ok? ?', replaced: true });
    expect(printable('Nankya ŋ')).toEqual({ text: 'Nankya ŋ', replaced: false });
  });

  it('NFR-A11Y-06 (helper): pdfTextRuns reads the embedded font through its ToUnicode map', async () => {
    registerPdfFont();
    const pdf = await renderToBuffer(createElement(Document, { title: 'Data card', language: 'en' },
      createElement(Page, { style: { fontFamily: PDF_FONT_FAMILY } }, createElement(Text, null, 'Nankya ŋ end'))));
    expect(pdfTextRuns(pdf).join('')).toBe('Nankya ŋ end');
  });

  it('NFR-SEC-15 (A11 (b)): the font is the copy from next, with its OFL licence beside it, read by a literal path', () => {
    expect(sha256(readFileSync('data/fonts/Geist-Regular.ttf'))).toBe(sha256(readFileSync('node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf')));
    const ofl = readFileSync('data/fonts/Geist-OFL.txt', 'utf8');
    expect(ofl).toContain('Copyright 2024 The Geist Project Authors');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(readFileSync('lib/documents/render/font.ts', 'utf8')).toContain("join(process.cwd(), 'data', 'fonts', 'Geist-Regular.ttf')");
  });

  it('NFR-SEC-15 (A11 (b)): the build traces the font directory, so the licence reaches the image beside the font', () => {
    expect(readFileSync('next.config.ts', 'utf8')).toMatch(/outputFileTracingIncludes[\s\S]*'data\/fonts\/\*\*'/);
  });

  it('FR-PUB-01 FR-DOC-02 (SRS 7.5.3): the printed copy holds no claim word outside the allowed statement, and no form of "fail"', async () => {
    for (const type of ['data_card', 'model_card'] as const) {
      const { pdf, plainText } = await RENDERERS[type]!(input(type, { fields: 40 }));
      const printed = squash(pdfTextRuns(pdf).join(' ')).replaceAll(STATEMENT, '');
      const plain = plainText.replaceAll(STATEMENT, '');
      for (const text of [printed, plain]) {
        expect(claimMatches(text), type).toEqual([]);
        expect(text, type).not.toMatch(/fail/i);
      }
    }
  });
});
