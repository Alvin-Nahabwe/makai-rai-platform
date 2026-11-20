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
export type SignOffBatch = Stage | 'help-and-reason-codes' | QuestionSetBatch | 'risk-mapping';
export type SignOffPayload =
  | {
      batch: Stage;
      questions: Array<{ id: string; text: string; expectedPractice: string; whyAsked: string; reasonPrompt: string;
        evidenceExamples: string[]; helpText: string | null; example: string | null }>;
    }
  | { batch: 'help-and-reason-codes'; documentHelp: DocumentHelpFile; reasonCodes: ReasonCodeEntry[] }
  | { batch: QuestionSetBatch; questions: Array<{ id: string; text: string }> }
  | {
      batch: 'risk-mapping';
      questions: Array<{ id: string; gaps: string[]; optionAreas: Record<string, string[]> | null }>;
      areas: Array<{ id: string; controls: Array<{ id: string; name: string; type: string; description: string;
        resources: Array<{ title: string; url: string; type: string | null }> }> }>;
    };

const QUESTION_SET = 'question-set:';

/**
 * The seven batches, in this order: the three stages' texts, the help lines with the reason codes, and the three
 * question-set approvals. The content check requires a sign-off of each; C-TXT's sign-off script signs them.
 */
export const SIGN_OFF_BATCHES: readonly SignOffBatch[] = [...STAGES, 'help-and-reason-codes', ...STAGES.map((s) => `${QUESTION_SET}${s}` as const)];
/**
 * Batches that only a version with the control switch on (`controlSuggestionsApproved`) needs signed: the experts'
 * approval of the question -> risk area -> control mapping (G6). Kept apart from `SIGN_OFF_BATCHES` so a version
 * without the switch is complete with the seven; the requirement lives in `validateContentVersion`.
 */
export const CONDITIONAL_SIGN_OFF_BATCHES: readonly SignOffBatch[] = ['risk-mapping'];
const isStage = (v: string): v is Stage => (STAGES as readonly string[]).includes(v);

/**
 * The texts one batch covers, from loaded content: a stage's questions in `questionsInStage` order with their four
 * texts and the help text and example (`null` when absent, because `canonicalJson` refuses `undefined`); the help
 * lines in `DOCUMENT_TYPES` order and the reason codes in file order; or a stage's ids and stems. Every field is copied
 * by name, so the payload holds exactly the typed fields. Throws for a batch name that is not one of the seven or `risk-mapping`.
 */
export function signOffPayload(c: LoadedContent, batch: SignOffBatch): SignOffPayload {
  if (batch === 'help-and-reason-codes') {
    const documentHelp = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, c.documentHelp[t]])) as DocumentHelpFile;
    const reasonCodes = c.reasonCodes.map(({ code, status, label, useWhen, reasonMustSay }) => ({ code, status, label, useWhen, reasonMustSay }));
    return { batch, documentHelp, reasonCodes };
  }
  if (batch === 'risk-mapping') {
    // No version string anywhere in this payload, so the same mapping hashes the same under any semver. Option entries are
    // normalised to area ids (as `areaOfEntry` in suggestions.ts); a map's key order does not matter to `canonicalJson`.
    return {
      batch,
      questions: [...c.questions.values()].map((q) => ({
        id: q.id,
        gaps: [...q.gaps],
        optionAreas: q.optionGapMap === undefined ? null
          : Object.fromEntries(Object.entries(q.optionGapMap).map(([o, es]) => [o, es.map((e) => (typeof e === 'string' ? e : e.area))])),
      })),
      // Each area's controls with every field the question page and the report show, so a control's text changed after the
      // sign-off leaves this batch unsigned (anti-goal 3).
      areas: [...c.areas.values()].map((a) => ({
        id: a.id,
        controls: (a.controls ?? []).map((id) => {
          const k = c.controls.get(id);
          if (k === undefined) throw new Error(`signOffPayload: area ${a.id} lists control ${id}, which the content does not define`);
          return {
            id: k.id, name: k.name, type: k.type, description: k.description,
            resources: (k.resources ?? []).map((r) => ({ title: r.title, url: r.url, type: r.type ?? null })),
          };
        }),
      })),
    };
  }
  if (isStage(batch)) {
    return {
      batch,
      questions: questionsInStage(c, batch).map((q) => {
        // The loader does not check this field's shape; a spread of a string or a missing field would sign the wrong thing or throw unnamed.
        if (!Array.isArray(q.evidenceExamples)) throw new Error(`signOffPayload: question ${q.id} evidenceExamples is not a list`);
        return {
          id: q.id, text: q.text, expectedPractice: q.expectedPractice, whyAsked: q.whyAsked, reasonPrompt: q.reasonPrompt,
          evidenceExamples: [...q.evidenceExamples], helpText: q.helpText ?? null, example: q.example ?? null,
        };
      }),
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
  if (p.batch === 'risk-mapping') return [...p.questions.map((q) => q.id), ...p.areas.map((a) => `area:${a.id}`)];
  return (p as Exclude<SignOffPayload, { batch: 'help-and-reason-codes' | 'risk-mapping' }>).questions.map((q) => q.id);
}
