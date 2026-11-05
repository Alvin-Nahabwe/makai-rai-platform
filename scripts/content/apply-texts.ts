/**
 * Writes the drafted texts of the three stage files into content 5.0.0's question bank, in place (CW-01, CW-03).
 * Idempotent: run again on the same files it changes nothing.
 *
 *   npx tsx scripts/content/apply-texts.ts [--texts docs/content/texts-5.0.0] [--bank data/content/5.0.0/questionBank.json]
 *
 * Each stage file (`<stage>.json`) is keyed by question id and holds `expectedPractice`, `whyAsked`, `reasonPrompt`,
 * `evidenceExamples` and, where the drafter rewrote them, `helpText` and `example`. Every question of the stage must
 * have exactly one entry and every entry must name a question of that stage, or nothing is written. A field the
 * entry leaves out (`helpText`, `example`) keeps the bank's text. Plain-English polish goes into the stage files,
 * never into the bank by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { STAGES, type Stage } from '@/types/record';

import { isMainModule } from './coverage';

export interface TextEntry {
  expectedPractice: string;
  whyAsked: string;
  reasonPrompt: string;
  evidenceExamples: string[];
  helpText?: string;
  example?: string;
}
export type StageTexts = Record<string, TextEntry>;

type Json = Record<string, unknown>;
interface BankLike {
  stages: Record<Stage, { modules: Array<{ id: string; questions: Json[] }> }>;
}

const REQUIRED = ['expectedPractice', 'whyAsked', 'reasonPrompt'] as const;
const OPTIONAL = ['helpText', 'example'] as const;
const ALLOWED = new Set<string>([...REQUIRED, 'evidenceExamples', ...OPTIONAL]);

function checkEntry(id: string, e: unknown): TextEntry {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`apply-texts: the entry of ${id} is not an object`);
  const o = e as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) throw new Error(`apply-texts: the entry of ${id} has unknown fields ${extra.join(', ')}`);
  for (const k of REQUIRED) if (typeof o[k] !== 'string') throw new Error(`apply-texts: ${id}.${k} is not text`);
  for (const k of OPTIONAL) if (k in o && typeof o[k] !== 'string') throw new Error(`apply-texts: ${id}.${k} is not text`);
  if (!Array.isArray(o.evidenceExamples) || o.evidenceExamples.some((x) => typeof x !== 'string')) {
    throw new Error(`apply-texts: ${id}.evidenceExamples is not a list of texts`);
  }
  return o as unknown as TextEntry;
}

/** A copy of `bank` with every stage's texts written in. Throws unless entries and questions match one to one. */
export function applyTexts<B extends BankLike>(bank: B, texts: Record<Stage, StageTexts>): B {
  const out = structuredClone(bank);
  for (const stage of STAGES) {
    const entries = texts[stage];
    if (entries === undefined) throw new Error(`apply-texts: no texts for ${stage}`);
    const seen = new Set<string>();
    for (const m of out.stages[stage].modules) {
      for (const q of m.questions) {
        const id = q.id as string;
        if (!Object.hasOwn(entries, id)) throw new Error(`apply-texts: ${stage} question ${id} has no entry in the ${stage} texts`);
        const e = checkEntry(id, entries[id]);
        seen.add(id);
        for (const k of REQUIRED) q[k] = e[k];
        q.evidenceExamples = [...e.evidenceExamples];
        for (const k of OPTIONAL) if (e[k] !== undefined) q[k] = e[k];
      }
    }
    const stray = Object.keys(entries).filter((id) => !seen.has(id));
    if (stray.length > 0) throw new Error(`apply-texts: the ${stage} texts name ${stray.join(', ')}, which the ${stage} bank lacks`);
  }
  return out;
}

function main(argv: string[]): void {
  let textsDir = 'docs/content/texts-5.0.0';
  let bankFile = 'data/content/5.0.0/questionBank.json';
  for (let i = 0; i < argv.length; i += 2) {
    const v = argv[i + 1];
    if (argv[i] === '--texts' && v !== undefined) textsDir = v;
    else if (argv[i] === '--bank' && v !== undefined) bankFile = v;
    else throw new Error(`apply-texts: bad argument ${JSON.stringify(argv[i])}`);
  }
  const texts = Object.fromEntries(
    STAGES.map((s) => [s, JSON.parse(readFileSync(path.join(textsDir, `${s}.json`), 'utf8')) as StageTexts]),
  ) as Record<Stage, StageTexts>;
  const bank = JSON.parse(readFileSync(bankFile, 'utf8')) as BankLike;
  writeFileSync(bankFile, `${JSON.stringify(applyTexts(bank, texts), null, 2)}\n`);
  console.log(`applied the texts of ${textsDir} to ${bankFile}`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
