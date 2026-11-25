import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContentFrom, medianQuestionWords, questionWords } from '../../scripts/content/question-words.mjs';
import type { ContentIndexFile } from '@/types/content';
import { readFileSync } from 'node:fs';

/**
 * Per-question wording, Global Constraints (Length): the median over the questions of words(text) + words(expectedPractice) +
 * words(whyAsked) + words(the longest answerPrompt, or reasonPrompt for the gate) is, for a version whose questions carry
 * answerPrompts (owner ruling R19, 24 November 2026): at most 96 over the version, and for each stage at most 0.8 times that stage's
 * 5.1.0 median. Words are split on single spaces, as in audit B section 8, whose figure for 5.1.0 is 121.
 */

const CONTENT = join(process.cwd(), 'data', 'content');
const index = JSON.parse(readFileSync(join(CONTENT, 'index.json'), 'utf8')) as ContentIndexFile;
const load = (v: string) => loadContentFrom(join(CONTENT, v));

describe('questionWords and medianQuestionWords', () => {
  it('splits on single spaces and takes the longest answerPrompt, or reasonPrompt when there is none', () => {
    const base = { text: 'a b', expectedPractice: 'c d e', whyAsked: 'f' };
    expect(questionWords({ ...base, reasonPrompt: 'g h i j' } as never)).toBe(2 + 3 + 1 + 4);
    expect(
      questionWords({ ...base, answerPrompts: { done: 'x', partly: 'x y z', not_yet: 'x y', not_applicable: 'x y z w' } } as never),
    ).toBe(2 + 3 + 1 + 4);
  });

  it('the median of an odd count is the middle value and of an even count the mean of the two middle values', () => {
    const q = (n: number) => ({ text: Array(n).fill('w').join(' '), expectedPractice: 'e', whyAsked: 'w', reasonPrompt: 'r' });
    const c = (ns: number[]) => ({ questions: new Map(ns.map((n, i) => [`Q${i}`, q(n)])) }) as never;
    expect(medianQuestionWords(c([5, 1, 3]))).toBe(3 + 3);
    expect(medianQuestionWords(c([1, 2, 3, 4]))).toBe(2.5 + 3);
  });

  it("5.1.0 measures 121, the audit's figure", () => {
    expect(medianQuestionWords(load('5.1.0'))).toBe(121);
  });

  it("a version whose questions carry answerPrompts measures at most 96, and each stage at most 0.8 times that stage's 5.1.0 median", () => {
    const median = (v: number[]): number => {
      const s = [...v].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const stageMedian = (c: ReturnType<typeof load>, stage: string): number =>
      median([...c.questions.values()].filter((q) => q.stage === stage).map((q) => questionWords(q) as number));
    const was = load('5.1.0');
    for (const v of index.versions) {
      const c = load(v);
      if (![...c.questions.values()].some((q) => q.answerPrompts !== undefined)) continue;
      expect(medianQuestionWords(c), v).toBeLessThanOrEqual(96);
      for (const stage of new Set([...c.questions.values()].map((q) => q.stage as string))) {
        expect(stageMedian(c, stage), `${v} ${stage}`).toBeLessThanOrEqual(0.8 * stageMedian(was, stage));
      }
    }
  });
});
