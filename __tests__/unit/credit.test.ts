import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/**
 * FR-PUB-02: the GIZ credit line is read from `data/credit.json`, so legal can
 * replace the words without a code change. `lib/credit.ts` reads it with
 * `readFileSync`; the mock below delegates to the real one unless a case sets
 * a one-off return value, so the first case reads the committed file.
 */
const fsMock = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, default: actual, readFileSync: fsMock.readFileSync };
});

import { readCreditLine } from '@/lib/credit';

const GOOD = {
  text: 'This platform draws on Responsible AI Assessments by GIZ (FAIR Forward), licensed under CC BY-SA 4.0. Changes were made.',
  href: 'https://creativecommons.org/licenses/by-sa/4.0/',
  licence: 'CC BY-SA 4.0',
};

beforeEach(() => {
  fsMock.readFileSync.mockClear();
});

describe('readCreditLine', () => {
  it('FR-PUB-02: the credit line holds the CC BY-SA 4.0 attribution elements, read from the file', () => {
    const c = readCreditLine();
    expect(c).toEqual(JSON.parse(realReadFileSync('data/credit.json', 'utf8')));
    expect(c.text).toContain('Responsible AI Assessments');
    expect(c.text).toContain('GIZ');
    expect(c.text).toContain('CC BY-SA 4.0');
    expect(c.text).toMatch(/Changes were made\./);
    expect(c.licence).toBe('CC BY-SA 4.0');
    expect(c.href).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
  });

  it('NFR-SEC-11 FR-PUB-02: the credit line renders as text', () => {
    fsMock.readFileSync.mockReturnValueOnce(
      JSON.stringify({ ...GOOD, text: '<b>x</b> GIZ' }),
    );
    const html = renderToStaticMarkup(createElement('p', null, readCreditLine().text));
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('FR-PUB-02: a credit file without https or without GIZ is refused at read', () => {
    fsMock.readFileSync.mockReturnValueOnce(
      JSON.stringify({ ...GOOD, href: 'http://creativecommons.org/licenses/by-sa/4.0/' }),
    );
    expect(() => readCreditLine()).toThrow(/href/);

    fsMock.readFileSync.mockReturnValueOnce(
      JSON.stringify({ ...GOOD, text: 'This platform draws on Responsible AI Assessments. Changes were made.' }),
    );
    expect(() => readCreditLine()).toThrow(/text/);
  });

  it('FR-PUB-02: a credit file that is not JSON is refused, naming the file', () => {
    fsMock.readFileSync.mockReturnValueOnce('{ not json');
    expect(() => readCreditLine()).toThrow(/data\/credit\.json/);
  });
});
