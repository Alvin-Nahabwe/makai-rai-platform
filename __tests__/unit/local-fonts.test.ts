import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PRIV-04 (unit FONTS). The two typefaces are served from this repository, not fetched from Google at
 * build time (`next/font/google`; register row D-279). The four font files are byte copies of what that loader
 * downloaded: Source Sans 3 (variable weight) and DM Serif Display 400, each in a `latin` and a `latin-ext`
 * subset. Each family's SIL Open Font License text sits beside its files, because the licence requires the
 * text to travel with any copy of the font software.
 */

const DIR = join(process.cwd(), 'app', 'fonts');

/** The file name, the byte size of the copy taken from the built output, and what the file is. */
const FONT_FILES = [
  { name: 'source-sans-3-latin.woff2', bytes: 28_804 },
  { name: 'source-sans-3-latin-ext.woff2', bytes: 60_048 },
  { name: 'dm-serif-display-latin.woff2', bytes: 17_844 },
  { name: 'dm-serif-display-latin-ext.woff2', bytes: 6_800 },
] as const;

/** The licence file and the copyright line of the family it covers, as the upstream text opens. */
const LICENCES = [
  { name: 'OFL-SourceSans3.txt', copyright: /^Copyright 2010-2020 Adobe \(http:\/\/www\.adobe\.com\/\), with Reserved Font Name 'Source'/ },
  { name: 'OFL-DMSerifDisplay.txt', copyright: /^Copyright 2014-2018 Adobe \(http:\/\/www\.adobe\.com\/\).*Copyright 2019 Google LLC\./ },
] as const;

describe('NFR-PRIV-04: the typeface files are committed under app/fonts', () => {
  for (const { name, bytes } of FONT_FILES) {
    it(`NFR-PRIV-04: ${name} exists, is a WOFF2 file and is ${bytes} bytes`, () => {
      const path = join(DIR, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const file = readFileSync(path);
      expect(file.subarray(0, 4).toString('latin1'), 'WOFF2 signature').toBe('wOF2');
      expect(statSync(path).size).toBe(bytes);
    });
  }

  for (const { name, copyright } of LICENCES) {
    it(`NFR-PRIV-04: ${name} exists and opens with its family's copyright line`, () => {
      const path = join(DIR, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.split('\n')[0]).toMatch(copyright);
      expect(text, 'licence name').toContain('SIL OPEN FONT LICENSE Version 1.1');
    });
  }
});
