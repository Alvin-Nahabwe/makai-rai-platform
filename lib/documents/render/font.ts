import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Font } from '@react-pdf/renderer';

/**
 * The font every document PDF embeds (owner question A11, default (b)): Geist Regular, copied once from
 * `node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf` to `data/fonts/` with its SIL Open Font Licence beside it
 * (NFR-SEC-15). Standard PDF fonts cover windows-1252 only, so a Luganda "ŋ" would not print; Geist covers it. A character
 * Geist lacks prints as "?" in the PDF, with one line saying so; the plain-text copy keeps the exact text.
 */

export const PDF_FONT_FAMILY = 'Geist';
export const UNPRINTABLE_NOTE = 'Some characters could not be printed in this PDF. The plain-text copy has the exact text.';

let fontBytes: Buffer | undefined;
let registered = false;

function bytes(): Buffer {
  // The literal form: file tracing copies exactly this path into `.next/standalone` (contract "Static read paths").
  fontBytes ??= readFileSync(join(process.cwd(), 'data', 'fonts', 'Geist-Regular.ttf'));
  return fontBytes;
}

/** Registers the font once per process. `Font` is react-pdf's global registry, so DOC-b's renderer shares the registration. */
export function registerPdfFont(): void {
  if (registered) return;
  Font.register({ family: PDF_FONT_FAMILY, src: `data:font/ttf;base64,${bytes().toString('base64')}` });
  // react-pdf hyphenates English by default, which would split "certification" across two text runs; whole words keep the
  // selectable text equal to the typed text.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

type Segment = { start: number; end: number; delta: number; rangeOffset: number; rangeAt: number };
let coverage: { segments: Segment[]; view: DataView } | undefined;

/** The segments of the font's format 4 `cmap` subtable (platform 3, encoding 1; Geist has that and the platform 0 copy). */
function cmap(): NonNullable<typeof coverage> {
  if (coverage) return coverage;
  const b = bytes();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = view.getUint16(4);
  let cmapAt = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (b.toString('latin1', rec, rec + 4) === 'cmap') cmapAt = view.getUint32(rec + 8);
  }
  if (cmapAt < 0) throw new Error('font: no cmap table');
  let sub = -1;
  const count = view.getUint16(cmapAt + 2);
  for (let i = 0; i < count; i++) {
    const rec = cmapAt + 4 + i * 8;
    if (view.getUint16(rec) === 3 && view.getUint16(rec + 2) === 1) sub = cmapAt + view.getUint32(rec + 4);
  }
  if (sub < 0 || view.getUint16(sub) !== 4) throw new Error('font: no format 4 cmap for platform 3 encoding 1');
  const segCount = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  const offsets = deltas + segCount * 2;
  const segments: Segment[] = [];
  for (let i = 0; i < segCount; i++) {
    segments.push({
      end: view.getUint16(ends + i * 2), start: view.getUint16(starts + i * 2), delta: view.getInt16(deltas + i * 2),
      rangeOffset: view.getUint16(offsets + i * 2), rangeAt: offsets + i * 2,
    });
  }
  coverage = { segments, view };
  return coverage;
}

/** True when the font maps `codePoint` to a glyph other than .notdef (glyph 0). Code points above U+FFFF are not in a format 4 table. */
export function fontCovers(codePoint: number): boolean {
  if (codePoint > 0xffff) return false;
  const { segments, view } = cmap();
  const seg = segments.find((s) => codePoint <= s.end);
  if (seg === undefined || codePoint < seg.start) return false;
  if (seg.rangeOffset === 0) return ((codePoint + seg.delta) & 0xffff) !== 0;
  const glyph = view.getUint16(seg.rangeAt + seg.rangeOffset + (codePoint - seg.start) * 2);
  return glyph !== 0 && ((glyph + seg.delta) & 0xffff) !== 0;
}

/** `text` with each code point the font lacks replaced by "?" (line breaks and tabs are layout, not glyphs, and stay). */
export function printable(text: string): { text: string; replaced: boolean } {
  let replaced = false;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09 || fontCovers(cp)) out += ch;
    else { out += '?'; replaced = true; }
  }
  return { text: out, replaced };
}
