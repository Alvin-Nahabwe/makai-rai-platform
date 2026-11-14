import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatasetSize } from '@prisma/client';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';

describe('lib/project/labels (owner default B37, FR-DOC-02)', () => {
  it('FR-DOC-02 (helper): the dataset size words are the contract\'s, in order', () => {
    expect(Object.entries(DATASET_SIZE_WORDS)).toEqual([
      ['small_lt1k', 'Under 1,000 records'], ['medium_1k_100k', '1,000 to 100,000 records'], ['large_100k_1m', '100,000 to 1 million records'],
      ['very_large_gt1m', 'Over 1 million records'], ['unknown', 'Not known'],
    ]);
  });

  it('FR-DOC-02 (helper): the personal data words are Yes and No', () => {
    expect(PERSONAL_DATA_WORDS).toEqual({ true: 'Yes', false: 'No' });
    expect(Object.keys(PERSONAL_DATA_WORDS).sort()).toEqual(['false', 'true']);
    expect(PERSONAL_DATA_WORDS[`${true}`]).toBe('Yes');
    expect(PERSONAL_DATA_WORDS[`${false}`]).toBe('No');
  });

  it('FR-DOC-02 (helper): the dataset size keys are the DatasetSize enum\'s values, in the enum\'s order, in the client and in the schema', () => {
    expect(Object.keys(DATASET_SIZE_WORDS)).toEqual(Object.values(DatasetSize));
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const block = /enum DatasetSize \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    const values = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    expect(values.length).toBeGreaterThan(0);
    expect(Object.keys(DATASET_SIZE_WORDS)).toEqual(values);
  });

  it('FR-DOC-02 (helper): every word is plain text a page can print: no empty word, no digit grouping other than commas, no dash', () => {
    for (const w of [...Object.values(DATASET_SIZE_WORDS), ...Object.values(PERSONAL_DATA_WORDS)]) {
      expect(w.length).toBeGreaterThan(0);
      expect(w).toBe(w.trim());
      expect(w).not.toMatch(/[–—]|\s{2}|[‘’“”]/);
    }
  });

  it('NFR-MNT-01 (helper): the module is constants only and imports nothing, so a client component can import it', () => {
    const src = readFileSync('lib/project/labels.ts', 'utf8');
    expect(src).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
    expect(src).not.toMatch(/\bfunction\b|=>/);
  });
});
