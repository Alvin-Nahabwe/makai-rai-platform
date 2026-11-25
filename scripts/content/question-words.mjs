// The length measure for per-question wording (content 5.2.0, Global Constraints "Length").
//
//   node scripts/content/question-words.mjs <versionDir>
//
// Prints `median=<n>` and one `stage <stage> median=<n>` line per stage. A question's words are
// words(text) + words(expectedPractice) + words(whyAsked) + words(the longest answerPrompt, or the reasonPrompt for a
// question that has no answerPrompts, which is the gate). Words are split on single spaces, as in audit B section 8
// (jq `split(" ")`), whose figure for 5.1.0 is 121. The median is over the questions; an even count takes the mean of the
// two middle values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Words of one text, split on single spaces. */
const words = (s) => (typeof s === 'string' ? s.split(' ').length : 0);

/** The words of the longest of a question's answerPrompts, or of its reasonPrompt when it has none. */
function promptWords(q) {
  if (q.answerPrompts && typeof q.answerPrompts === 'object') return Math.max(0, ...Object.values(q.answerPrompts).map(words));
  return words(q.reasonPrompt);
}

/** @param {{ text: string, expectedPractice: string, whyAsked: string, answerPrompts?: Record<string,string>, reasonPrompt?: string }} q */
export function questionWords(q) {
  return words(q.text) + words(q.expectedPractice) + words(q.whyAsked) + promptWords(q);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {{ questions: ReadonlyMap<string, any> }} c a loaded content version (only `questions` is read) */
export function medianQuestionWords(c) {
  return median([...c.questions.values()].map(questionWords));
}

/** The questions of a version directory, in the shape the measure reads: `{ questions: Map<id, question + stage> }`. */
export function loadContentFrom(versionDir) {
  const bank = JSON.parse(readFileSync(join(versionDir, 'questionBank.json'), 'utf8'));
  const questions = new Map();
  for (const [stage, s] of Object.entries(bank.stages))
    for (const m of s.modules) for (const q of m.questions) questions.set(q.id, { ...q, stage });
  return { questions };
}

export function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: node scripts/content/question-words.mjs <versionDir>');
    return 2;
  }
  const c = loadContentFrom(argv[0]);
  console.log(`median=${medianQuestionWords(c)}`);
  const stages = [...new Set([...c.questions.values()].map((q) => q.stage))];
  for (const st of stages)
    console.log(`stage ${st} median=${median([...c.questions.values()].filter((q) => q.stage === st).map(questionWords))}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
