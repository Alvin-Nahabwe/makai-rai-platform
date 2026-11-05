import { inflateSync } from 'node:zlib';

/**
 * The text of a PDF as a reader's tool would take it out (NFR-A11Y-06 "selectable text"; contract row `pdfText.ts`,
 * gap G071, round 4 wording): every text-show operation of every page, pages in page-tree order, each content stream
 * inflated with `node:zlib` when it is FlateDecode. A `Tj` or `TJ` string is decoded through the `/ToUnicode` CMap of
 * the font the last `Tf` selected (its `bfchar` entries and its `bfrange` entries, whose destination is a start code
 * or an array), and with `windows-1252` when that font has none. One operation is one entry: react-pdf writes one
 * `TJ` per printed line. Test-only: nothing under `app/` or `lib/` imports it.
 */

interface Ref { ref: number }
interface Name { name: string }
type PdfValue = number | string | boolean | null | Ref | Name | Buffer | PdfValue[] | { [k: string]: PdfValue };
type PdfDict = { [k: string]: PdfValue };

interface PdfObject { value: PdfValue; stream: Buffer | null }

const WS = /[\s\0]/;
const DELIM = /[()<>[\]{}/%]/;

class Lexer {
  pos = 0;
  constructor(readonly s: string) {}

  private skip(): void {
    for (;;) {
      while (this.pos < this.s.length && WS.test(this.s[this.pos])) this.pos++;
      if (this.s[this.pos] === '%') { while (this.pos < this.s.length && this.s[this.pos] !== '\n' && this.s[this.pos] !== '\r') this.pos++; } else return;
    }
  }

  /** The next value or, for the content stream, the next bare keyword (returned as `{ op }`). */
  next(): PdfValue | { op: string } | undefined {
    this.skip();
    const c = this.s[this.pos];
    if (c === undefined) return undefined;
    if (c === '/') {
      let i = this.pos + 1;
      while (i < this.s.length && !WS.test(this.s[i]) && !DELIM.test(this.s[i])) i++;
      const name = this.s.slice(this.pos + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      this.pos = i;
      return { name };
    }
    if (c === '<' && this.s[this.pos + 1] === '<') {
      this.pos += 2;
      const d: PdfDict = {};
      for (;;) {
        this.skip();
        if (this.s.startsWith('>>', this.pos)) { this.pos += 2; return d; }
        const k = this.next();
        if (!isName(k as PdfValue)) throw new Error('pdfTextRuns: malformed dictionary');
        d[(k as Name).name] = this.value();
      }
    }
    if (c === '<') {
      const end = this.s.indexOf('>', this.pos);
      const hex = this.s.slice(this.pos + 1, end).replace(/\s+/g, '');
      this.pos = end + 1;
      return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    }
    if (c === '(') return this.literal();
    if (c === '[') {
      this.pos++;
      const a: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.s[this.pos] === ']') { this.pos++; return a; }
        if (this.pos >= this.s.length) throw new Error('pdfTextRuns: unterminated array');
        a.push(this.value());
      }
    }
    let i = this.pos;
    while (i < this.s.length && !WS.test(this.s[i]) && !DELIM.test(this.s[i])) i++;
    if (i === this.pos) { this.pos++; return { op: c }; }
    const word = this.s.slice(this.pos, i);
    this.pos = i;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { op: word };
  }

  /** A value in a dictionary or array: resolves `n g R` into a reference. */
  value(): PdfValue {
    const v = this.next();
    if (v === undefined) throw new Error('pdfTextRuns: value expected');
    if (typeof v === 'number' && Number.isInteger(v)) {
      const save = this.pos;
      const g = this.next();
      const r = this.next();
      if (typeof g === 'number' && r !== undefined && typeof r === 'object' && r !== null && 'op' in r && r.op === 'R') return { ref: v };
      this.pos = save;
    }
    if (v !== null && typeof v === 'object' && 'op' in v) throw new Error(`pdfTextRuns: unexpected keyword ${v.op}`);
    return v;
  }

  private literal(): Buffer {
    const out: number[] = [];
    let depth = 0;
    for (this.pos++; this.pos < this.s.length; this.pos++) {
      const ch = this.s[this.pos];
      if (ch === '\\') {
        const n = this.s[++this.pos];
        const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (n in esc) out.push(esc[n]);
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(this.s[this.pos + 1])) oct += this.s[++this.pos];
          out.push(parseInt(oct, 8) & 0xff);
        } else if (n === '\r') { if (this.s[this.pos + 1] === '\n') this.pos++; } else if (n !== '\n') out.push(n.charCodeAt(0) & 0xff);
      } else if (ch === '(') { depth++; out.push(40); } else if (ch === ')') {
        if (depth === 0) { this.pos++; return Buffer.from(out); }
        depth--; out.push(41);
      } else out.push(ch.charCodeAt(0) & 0xff);
    }
    throw new Error('pdfTextRuns: unterminated string');
  }
}

const isDict = (v: PdfValue | undefined): v is PdfDict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && !('ref' in v) && !('name' in v);
const isRef = (v: PdfValue | undefined): v is Ref => typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && 'ref' in v;
const isName = (v: PdfValue | undefined): v is Name => typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && 'name' in v;

function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const s = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const header = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = header.exec(s)) !== null) {
    const num = Number(m[1]);
    const lex = new Lexer(s);
    lex.pos = m.index + m[0].length;
    let value: PdfValue;
    try { value = lex.value(); } catch { continue; }
    let stream: Buffer | null = null;
    const rest = s.slice(lex.pos, lex.pos + 12);
    const kw = /^\s*stream(\r\n|\n|\r)/.exec(rest);
    if (kw !== null && isDict(value)) {
      const start = lex.pos + kw[0].length;
      const end = s.indexOf('endstream', start);
      let raw = pdf.subarray(start, end);
      if (raw.length >= 2 && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - (raw[raw.length - 2] === 0x0d ? 2 : 1));
      else if (raw.length >= 1 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      const filter = value.Filter;
      const filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter];
      stream = filters.some((f) => isName(f) && f.name === 'FlateDecode') ? inflateSync(raw) : Buffer.from(raw);
      header.lastIndex = end;
    }
    objects.set(num, { value, stream });
  }
  return objects;
}

type CMap = { width: number; map: Map<number, string> };

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  const width = (() => {
    const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
    return cs === null ? 1 : cs[1].length / 2;
  })();
  const utf16 = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex').swap16().toString('utf16le');
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(e[1], 16), utf16(e[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const lo = parseInt(e[1], 16);
      const hi = parseInt(e[2], 16);
      if (e[3].startsWith('[')) {
        [...e[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((d, i) => { if (lo + i <= hi) map.set(lo + i, utf16(d[1])); });
      } else {
        const first = e[3].slice(1, -1);
        const base = parseInt(first, 16);
        const digits = first.length;
        for (let c = lo; c <= hi; c++) map.set(c, utf16((base + (c - lo)).toString(16).padStart(digits, '0')));
      }
    }
  }
  return { width, map };
}

const WIN1252 = new TextDecoder('windows-1252');

function decode(bytes: Buffer, cmap: CMap | null): string {
  if (cmap === null) return WIN1252.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += cmap.width) {
    let code = 0;
    for (let k = 0; k < cmap.width; k++) code = code * 256 + (bytes[i + k] ?? 0);
    out += cmap.map.get(code) ?? '';
  }
  return out;
}

/** The runs of each page, pages in page-tree order. */
export function pdfPageRuns(pdf: Buffer): string[][] {
  const objects = readObjects(pdf);
  const get = (v: PdfValue | undefined): PdfValue | undefined => (isRef(v) ? objects.get(v.ref)?.value : v);

  const catalog = [...objects.values()].find((o) => isDict(o.value) && isName(o.value.Type) && o.value.Type.name === 'Catalog');
  const pages: PdfDict[] = [];
  const walk = (node: PdfValue | undefined, inherited: PdfDict): void => {
    const d = get(node);
    if (!isDict(d)) return;
    const inh: PdfDict = { ...inherited, ...(d.Resources !== undefined ? { Resources: d.Resources } : {}) };
    if (isName(d.Type) && d.Type.name === 'Pages' && Array.isArray(d.Kids)) d.Kids.forEach((k) => walk(k, inh));
    else pages.push({ ...d, Resources: inh.Resources ?? null });
  };
  if (catalog !== undefined && isDict(catalog.value)) walk(catalog.value.Pages, {});
  else for (const o of objects.values()) if (isDict(o.value) && isName(o.value.Type) && o.value.Type.name === 'Page') pages.push(o.value);

  const cmaps = new Map<number, CMap | null>();
  const cmapOf = (fontRef: PdfValue | undefined): CMap | null => {
    const key = isRef(fontRef) ? fontRef.ref : -1;
    if (cmaps.has(key)) return cmaps.get(key) as CMap | null;
    const font = get(fontRef);
    let result: CMap | null = null;
    if (isDict(font) && isRef(font.ToUnicode)) {
      const stream = objects.get(font.ToUnicode.ref)?.stream;
      if (stream) result = parseCMap(stream.toString('latin1'));
    }
    cmaps.set(key, result);
    return result;
  };

  const perPage: string[][] = [];
  for (const page of pages) {
    const runs: string[] = [];
    perPage.push(runs);
    const resources = get(page.Resources ?? undefined);
    const fonts = isDict(resources) ? get(resources.Font) : undefined;
    const contentsRaw = get(page.Contents);
    const parts = Array.isArray(contentsRaw) ? contentsRaw : contentsRaw === undefined ? [] : [page.Contents as PdfValue];
    const streams = parts.map((p) => (isRef(p) ? objects.get(p.ref)?.stream : null)).filter((b): b is Buffer => b != null);
    const lex = new Lexer(Buffer.concat(streams.flatMap((b) => [b, Buffer.from('\n')])).toString('latin1'));
    let font: CMap | null = null;
    const operands: Array<PdfValue | { op: string }> = [];
    for (let t = lex.next(); t !== undefined; t = lex.next()) {
      if (t !== null && typeof t === 'object' && 'op' in t && !Array.isArray(t)) {
        const op = t.op;
        if (op === 'Tf') {
          const n = operands[operands.length - 2];
          font = isName(n as PdfValue) && isDict(fonts) ? cmapOf(fonts[(n as Name).name]) : null;
        } else if (op === 'Tj' || op === "'" || op === '"') {
          const str = operands[operands.length - 1];
          if (Buffer.isBuffer(str)) runs.push(decode(str, font));
        } else if (op === 'TJ') {
          const arr = operands[operands.length - 1];
          if (Array.isArray(arr)) runs.push(arr.filter((x): x is Buffer => Buffer.isBuffer(x)).map((b) => decode(b, font)).join(''));
        }
        operands.length = 0;
      } else operands.push(t as PdfValue);
    }
  }
  return perPage;
}

export function pdfTextRuns(pdf: Buffer): string[] {
  return pdfPageRuns(pdf).flat();
}
