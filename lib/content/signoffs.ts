import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/integrity/canonical.mjs';
import { questionsInStage } from '@/lib/content/loader';
import type { DocumentHelpFile, LoadedContent, ReasonCodeEntry } from '@/types/content';
import { DOCUMENT_TYPES, STAGES, type Stage } from '@/types/record';

/**
 * What an owner's sign-off covers, and its digest (FR-CNT-02, SRS line 693; 10.1.0 step 4, line 3891). There are seven
 * batches: the texts of each stage, a fourth batch of the document help lines and the reason-code list, and the
 * three question-set approvals over each stage's ids and stems. C-TXT's sign-off script writes a record with
 * `signOffHash` and `signOffItems` of `signOffPayload`, and the content check (`lib/content/validate.ts`) recomputes
 * them from the current files, so the writer and the checker hash the same bytes and a text changed after its
 * sign-off leaves its batch unsigned.
 */

export type QuestionSetBatch = `question-set:${Stage}`;
export type SignOffBatch = Stage | 'help-and-reason-codes' | QuestionSetBatch;
export type SignOffPayload =
  | {
      batch: Stage;
      questions: Array<{ id: string; text: string; expectedPractice: string; whyAsked: string; reasonPrompt: string;
        evidenceExamples: string[]; helpText: string | null; example: string | null }>;
    }
  | { batch: 'help-and-reason-codes'; documentHelp: DocumentHelpFile; reasonCodes: ReasonCodeEntry[] }
  | { batch: QuestionSetBatch; questions: Array<{ id: string; text: string }> };

const QUESTION_SET = 'question-set:';
const isStage = (v: string): v is Stage => (STAGES as readonly string[]).includes(v);

/**
 * The texts one batch covers, from loaded content: a stage's questions in `questionsInStage` order with their four
 * texts and the help text and example (`null` when absent, because `canonicalJson` refuses `undefined`); the help
 * lines in `DOCUMENT_TYPES` order and the reason codes in file order; or a stage's ids and stems. Every field is copied
 * by name, so the payload holds exactly the typed fields. Throws for a batch name that is not one of the seven.
 */
export function signOffPayload(c: LoadedContent, batch: SignOffBatch): SignOffPayload {
  if (batch === 'help-and-reason-codes') {
    const documentHelp = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, c.documentHelp[t]])) as DocumentHelpFile;
    const reasonCodes = c.reasonCodes.map(({ code, status, label, useWhen, reasonMustSay }) => ({ code, status, label, useWhen, reasonMustSay }));
    return { batch, documentHelp, reasonCodes };
  }
  if (isStage(batch)) {
    return {
      batch,
      questions: questionsInStage(c, batch).map((q) => ({
        id: q.id, text: q.text, expectedPractice: q.expectedPractice, whyAsked: q.whyAsked, reasonPrompt: q.reasonPrompt,
        evidenceExamples: [...q.evidenceExamples], helpText: q.helpText ?? null, example: q.example ?? null,
      })),
    };
  }
  const stage = batch.startsWith(QUESTION_SET) ? batch.slice(QUESTION_SET.length) : '';
  if (!isStage(stage)) throw new Error(`signOffPayload: unknown batch ${JSON.stringify(String(batch))}`);
  return { batch: `${QUESTION_SET}${stage}`, questions: questionsInStage(c, stage).map((q) => ({ id: q.id, text: q.text })) };
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `canonicalJson(p)`. */
export function signOffHash(p: SignOffPayload): string {
  return createHash('sha256').update(Buffer.from(canonicalJson(p), 'utf8')).digest('hex');
}

/** What a record lists as covered: the question ids, or `documentHelp:<type>` in `DOCUMENT_TYPES` order then `reasonCode:<code>`. */
export function signOffItems(p: SignOffPayload): string[] {
  if (p.batch === 'help-and-reason-codes') {
    const help = p as Extract<SignOffPayload, { batch: 'help-and-reason-codes' }>;
    return [...DOCUMENT_TYPES.map((t) => `documentHelp:${t}`), ...help.reasonCodes.map((r) => `reasonCode:${r.code}`)];
  }
  return (p as Exclude<SignOffPayload, { batch: 'help-and-reason-codes' }>).questions.map((q) => q.id);
}
