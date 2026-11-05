/**
 * Appends one owner sign-off record to content 5.0.0's `signoffs.json` (FR-CNT-02, SRS line 693; X2 in the brief).
 * A record is written only from the owner's answer as the controller relays it; the commit that adds it quotes that
 * answer and its time.
 *
 *   npx tsx scripts/content/sign-off.ts --batch <batch> --approver <text> --at <ISO instant with zone>
 *   npx tsx scripts/content/sign-off.ts --batch question-set:<stage> --from-proposal <proposal> --approver <text> --at <ISO>
 *
 * The record's `sha256` and `items` are `signOffHash` and `signOffItems` of `signOffPayload(loadContent('5.0.0'), batch)`
 * (lib/content/signoffs.ts, CNT), the same bytes the content check recomputes. With `--from-proposal`, the stage's
 * payload is first built from the proposal's approved stems in the bank's content order; any id or stem that differs
 * from the bank stops the command, and so does a hash that differs from CNT's. A record already present for the same
 * batch, approver, time and hash is not written twice.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { loadContent, questionsInStage } from '@/lib/content/loader';
import { SIGN_OFF_BATCHES, signOffHash, signOffItems, signOffPayload, type SignOffBatch } from '@/lib/content/signoffs';
import type { LoadedContent, SignOffRecord, SignOffsFile } from '@/types/content';
import { STAGES, type Stage } from '@/types/record';

import { isMainModule } from './cli';
import type { QuestionSetProposal } from './types';

const SIGNOFFS_FILE = 'data/content/5.0.0/signoffs.json';
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface Signer { approver: string; at: string }

function checkSigner(s: Signer): void {
  if (s.approver.trim() === '') throw new Error('sign-off: the approver is empty');
  if (!ZONED.test(s.at) || Number.isNaN(Date.parse(s.at))) throw new Error(`sign-off: at ${JSON.stringify(s.at)} is not an ISO instant with a zone`);
}

/** A record for one of the seven batches, from the loaded content. */
export function buildRecord(c: LoadedContent, batch: SignOffBatch, s: Signer): SignOffRecord {
  checkSigner(s);
  if (!SIGN_OFF_BATCHES.includes(batch)) throw new Error(`sign-off: unknown batch ${JSON.stringify(batch)}`);
  const payload = signOffPayload(c, batch);
  return { batch, approver: s.approver, at: s.at, sha256: signOffHash(payload), items: signOffItems(payload) };
}

/** The stems the proposal approves, by id: kept stems, reworded stems and new questions' stems. */
function approvedStems(p: QuestionSetProposal): Map<string, string> {
  const newById = new Map(p.newQuestions.map((n) => [n.id, n.text]));
  const out = new Map<string, string>();
  for (const a of p.actions) {
    if (a.action === 'keep') out.set(a.id, a.originalText);
    else if (a.action === 'reword') out.set(a.id, a.text);
    else if (a.action === 'replace') {
      const t = newById.get(a.newId);
      if (t === undefined) throw new Error(`sign-off: ${a.newId} has no newQuestions entry`);
      out.set(a.newId, t);
    }
  }
  return out;
}

/**
 * The `question-set:<stage>` record from the approved proposal: the stage's ids in the bank's content order, each with
 * the stem the proposal approves; refused unless that payload equals CNT's payload over the bank, byte for byte.
 */
export function buildQuestionSetRecord(c: LoadedContent, proposal: QuestionSetProposal, stage: Stage, s: Signer): SignOffRecord {
  if (proposal.status !== 'approved') throw new Error(`sign-off: the proposal's status is ${proposal.status}, not approved`);
  if (!STAGES.includes(stage)) throw new Error(`sign-off: unknown stage ${JSON.stringify(stage)}`);
  const stems = approvedStems(proposal);
  const inBank = questionsInStage(c, stage);
  const questions = inBank.map((q) => {
    const stem = stems.get(q.id);
    if (stem === undefined) throw new Error(`sign-off: ${q.id} is in the bank, but the proposal approves no stem for it`);
    if (stem !== q.text) throw new Error(`sign-off: ${q.id}'s stem in the bank is not the stem the proposal approves`);
    return { id: q.id, text: stem };
  });
  const prefix = { 'pre-processing': 'Q-PP-', 'in-processing': 'Q-IP-', 'post-processing': 'Q-PO-' }[stage];
  const banked = new Set(inBank.map((q) => q.id));
  const missing = [...stems.keys()].filter((id) => id.startsWith(prefix) && !banked.has(id));
  if (missing.length > 0) throw new Error(`sign-off: the proposal approves ${missing.join(', ')} for ${stage}, but the bank lacks them`);
  const batch = `question-set:${stage}` as const;
  const fromProposal = signOffHash({ batch, questions });   // the contract's payload and hash (C4 SIM-2)
  const record = buildRecord(c, batch, s);
  if (record.sha256 !== fromProposal) throw new Error(`sign-off: the proposal's ${batch} payload hashes to ${fromProposal}, CNT's to ${record.sha256}; no record written`);
  return record;
}

/** `file`'s records with `r` appended, unless an identical record is already there. */
export function appendRecord(file: SignOffsFile, r: SignOffRecord): SignOffsFile {
  const same = (x: SignOffRecord) => x.batch === r.batch && x.approver === r.approver && x.at === r.at && x.sha256 === r.sha256;
  return file.records.some(same) ? file : { records: [...file.records, r] };
}

function main(argv: string[]): void {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--batch', '--approver', '--at', '--from-proposal'].includes(k) || v === undefined || opts.has(k)) {
      throw new Error(`sign-off: bad argument ${JSON.stringify(k)}`);
    }
    opts.set(k, v);
  }
  const batch = opts.get('--batch');
  const approver = opts.get('--approver') ?? 'Product owner, MAK-AI';
  const at = opts.get('--at');
  if (batch === undefined || at === undefined) throw new Error('usage: sign-off.ts --batch <batch> --at <ISO> [--approver <text>] [--from-proposal <file>]');
  const c = loadContent('5.0.0');
  const proposalFile = opts.get('--from-proposal');
  let record: SignOffRecord;
  if (proposalFile !== undefined) {
    if (!batch.startsWith('question-set:')) throw new Error('sign-off: --from-proposal signs a question-set:<stage> batch only');
    const proposal = JSON.parse(readFileSync(proposalFile, 'utf8')) as QuestionSetProposal;
    record = buildQuestionSetRecord(c, proposal, batch.slice('question-set:'.length) as Stage, { approver, at });
  } else {
    record = buildRecord(c, batch as SignOffBatch, { approver, at });
  }
  const file = JSON.parse(readFileSync(SIGNOFFS_FILE, 'utf8')) as SignOffsFile;
  writeFileSync(SIGNOFFS_FILE, `${JSON.stringify(appendRecord(file, record), null, 2)}\n`);
  console.log(`${record.batch} ${record.sha256} (${record.items.length} items)`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
