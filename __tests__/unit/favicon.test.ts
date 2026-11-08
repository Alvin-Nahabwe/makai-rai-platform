import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PERF-02 (SRS line 3195): every page's first visit fetches /favicon.png (app/layout.tsx `metadata.icons.icon`), so
 * its bytes count against the 220 KB of every public page. It is a 32 by 32 image of few colours, so it is stored as an
 * indexed PNG of at most 64 colours with per-entry transparency, not as 32-bit RGBA. The 192 and 512 pixel icons are
 * fetched only by a device that installs the page, and are not changed.
 */

const FILE = 'public/favicon.png';

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  hasTransparency: boolean;
  /** The distinct palette indices the pixels use (8-bit indexed images only). */
  coloursUsed: number;
}

/** The PNG filter predictor (Paeth). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The palette indices of an 8-bit indexed, non-interlaced image's pixels, from its inflated IDAT data. */
function indices(raw: Buffer, width: number, height: number): Set<number> {
  const used = new Set<number>();
  let prev = Buffer.alloc(width);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const line = Buffer.from(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)));
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? line[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      const add = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (add === undefined) throw new Error(`unknown PNG filter ${filter}`);
      line[x] = (line[x] + add) & 0xff;
      used.add(line[x]);
    }
    prev = line;
  }
  return used;
}

/** Reads the header, palette and transparency chunks of a PNG. */
function readPng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString('hex'), 'PNG signature').toBe('89504e470d0a1a0a');
  const png: Png = { width: 0, height: 0, bitDepth: 0, colourType: -1, hasTransparency: false, coloursUsed: 0 };
  const idat: Buffer[] = [];
  for (let pos = 8; pos < buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      png.width = data.readUInt32BE(0);
      png.height = data.readUInt32BE(4);
      png.bitDepth = data[8];
      png.colourType = data[9];
      expect(data[12], 'not interlaced').toBe(0);
    } else if (type === 'tRNS') png.hasTransparency = true;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + length;
  }
  if (png.colourType === 3 && png.bitDepth === 8) png.coloursUsed = indices(inflateSync(Buffer.concat(idat)), png.width, png.height).size;
  return png;
}

describe('NFR-PERF-02: the favicon every page fetches is a small indexed PNG', () => {
  const buf = readFileSync(FILE);

  it('NFR-PERF-02: public/favicon.png is 32 by 32, indexed, at most 64 colours, keeps its transparency and is under 1 KB', () => {
    const png = readPng(buf);
    expect({ ...png, coloursUsed: undefined }).toEqual({ width: 32, height: 32, bitDepth: 8, colourType: 3, hasTransparency: true, coloursUsed: undefined });
    expect(png.coloursUsed).toBeGreaterThan(1);
    expect(png.coloursUsed).toBeLessThanOrEqual(64);
    expect(buf.length).toBeLessThanOrEqual(1_000);
  });

  it('NFR-PERF-02: public/favicon.png is the re-encoded file, pinned by size and sha256', () => {
    expect({ bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }).toEqual({
      bytes: 851,
      sha256: '8089a78c1dd94e3076f0faeaf4f562b226a0da259d75010e9f678d38f550bd0c',
    });
  });
});
