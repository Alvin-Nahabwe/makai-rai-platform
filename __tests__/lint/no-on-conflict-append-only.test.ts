import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';

/**
 * NFR-INT-02 (SRS line 3081) and SRS 5.3 item 4 (line 1261): a write to an append-only table
 * selects, then inserts, with the unique index as the backstop; it never uses
 * `INSERT ... ON CONFLICT` or Prisma's `upsert`, which on a table whose BEFORE INSERT trigger
 * has side effects reproduced a hazard on PostgreSQL 16.15 (R5 section B.7), and which the
 * append-only refusal triggers would refuse anyway on the conflict path.
 *
 * Reads every .ts and .tsx file under app/ and lib/ (generated, not hand-listed) and flags a
 * line with `ON CONFLICT` or `.upsert(` that names an append-only table or its Prisma model
 * (from prisma/schema.prisma, so the model names are a second root) on that line or the five
 * before it.
 */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** The Prisma model accessor (camel-cased model name) of each append-only table, read from the schema. */
function appendOnlyNames(): string[] {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const out: string[] = [...APPEND_ONLY_TABLES];
  for (const [, model, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const map = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    if (map && APPEND_ONLY_TABLES.includes(map)) out.push(model[0].toLowerCase() + model.slice(1));
  }
  return out;
}

type Hit = { file: string; line: number; text: string };

function grepAppAndLib(pattern: RegExp, sources: Array<{ file: string; text: string }>): Array<Hit & { window: string }> {
  const out: Array<Hit & { window: string }> = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (pattern.test(l)) out.push({ file, line: i + 1, text: l.trim(), window: lines.slice(Math.max(0, i - 5), i + 1).join('\n') });
    });
  }
  return out;
}

/** An `.upsert(` names its model on its own line (`tx.<model>.upsert(`); an `ON CONFLICT` follows its `INSERT INTO <table>`. */
function touchesAppendOnlyModel(names: readonly string[]) {
  return (h: { text: string; window: string }) => {
    if (/\.upsert\(/i.test(h.text)) return names.some((n) => new RegExp(`\\b${n}\\s*\\.\\s*upsert\\(`).test(h.text));
    return names.some((n) => new RegExp(`INTO\\s+"?${n}"?\\b`, 'i').test(h.window));
  };
}

const PATTERN = /ON\s+CONFLICT|\.upsert\(/i;

describe('NFR-INT-02 select-then-insert on append-only tables', () => {
  it('NFR-INT-02: no ON CONFLICT or upsert on an append-only model', () => {
    const sources = [...files('app'), ...files('lib')].map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    expect(sources.length).toBeGreaterThan(50);
    const names = appendOnlyNames();
    expect(names).toEqual(expect.arrayContaining(['decision_versions', 'decisionVersion', 'requestReceipt', 'consentRecord', 'evidenceBlob']));
    expect(grepAppAndLib(PATTERN, sources).filter(touchesAppendOnlyModel(names)).map(({ file, line, text }) => ({ file, line, text }))).toEqual([]);
  });

  it('NFR-INT-02 (lint self-test): an upsert or ON CONFLICT on an append-only model is caught, and one on another table is not', () => {
    const names = appendOnlyNames();
    const probe = [{ file: 'probe.ts', text: [
      'await tx.decisionVersion.upsert({ where, create, update });',
      'await tx.project.upsert({ where, create, update });',
      'await tx.$executeRaw`INSERT INTO "request_receipts" (id) VALUES (1)',
      '  ON CONFLICT DO NOTHING`;',
    ].join('\n') }];
    expect(grepAppAndLib(PATTERN, probe).filter(touchesAppendOnlyModel(names)).map((h) => h.line)).toEqual([1, 4]);
  });
});
