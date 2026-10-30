import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The GIZ credit line (FR-PUB-02). The words live in `data/credit.json` so legal
 * can replace them without a code change; until then the file holds the
 * CC BY-SA 4.0 attribution elements: the source title, GIZ, the licence, its
 * address, and "Changes were made".
 *
 * The literal `data` prefix after `process.cwd()` is deliberate: the build
 * traces the file from a static path, and a computed segment would make it
 * trace the whole project (contract, "Static read paths").
 *
 * Callers render `text` as a React text child, never as markup (NFR-SEC-11).
 */
export type CreditLine = { text: string; href: string; licence: string };

function fieldOf(raw: unknown, field: keyof CreditLine): string {
  const value = (raw as Record<string, unknown> | null)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`data/credit.json: "${field}" must be a non-empty string`);
  }
  return value;
}

export function readCreditLine(): CreditLine {
  const text = readFileSync(join(process.cwd(), 'data', 'credit.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error('data/credit.json: not valid JSON', { cause });
  }
  const credit = {
    text: fieldOf(raw, 'text'),
    href: fieldOf(raw, 'href'),
    licence: fieldOf(raw, 'licence'),
  };
  if (!credit.href.startsWith('https://')) {
    throw new Error('data/credit.json: "href" must start with https://');
  }
  if (!credit.text.includes('GIZ')) {
    throw new Error('data/credit.json: "text" must name GIZ');
  }
  return credit;
}
