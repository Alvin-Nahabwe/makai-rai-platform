import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * O-6 (2026-08-19 practices/maturity split plan, Task 9).
 *
 * The defect this whole branch fixes was two numbers being added together:
 * `calculateAreaScores` summed a weighted likert average (per-question
 * weights 0.05-0.2) and a role-weighted checklist count (per-OPTION weights
 * 1.0/0.6/0.3) into one denominator. One ticked box outweighed five to
 * twenty judgement questions; five of 78 questions carried 75.1% of all
 * area scoring weight; a team answering "Minimally" to every judgement
 * question while ticking every box was rated strong in 13 of 21 areas.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. A comment saying "do not add
 * these together" would not have prevented the original defect -- the
 * original code had no such comment because nobody writing it thought of
 * the checklist count and the likert average as "the same kind of thing
 * being combined"; they were just two numbers in scope. The only guard
 * that survives that blind spot is one that reads the code, not the
 * author's intent.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (AGENTS.md §2, the D-191 check).
 * The PROPERTY is "the assessed-maturity percentage and the
 * practices-in-place count are never combined into one number". What this
 * test CAUSES is: every tracked line under components/, lib/ and app/ that
 * is not a comment is scanned for a line naming both `maturity` and
 * `practices`/`inPlace` alongside an arithmetic operator. That is a
 * SINGLE-LINE, TEXTUAL heuristic -- it entails the property only for
 * blending expressions that both readings and an operator share a line.
 * It does NOT catch:
 *   - a blending expression split across two or more lines (e.g. an
 *     operand on one line, the operator and other operand on the next);
 *   - a blend performed through intermediate variables with different
 *     names (`const m = score.maturity; const p = score.practices.inPlace;
 *     const x = m + p;` -- neither `m + p` line names "maturity" or
 *     "practices"/"inPlace");
 *   - a blend performed via a function call rather than an infix operator
 *     (`combine(score.maturity, score.practices.inPlace)`).
 * These are stated limits, not claimed coverage.
 *
 * SCOPE: components/, lib/, app/ only -- the same three roots the brief
 * specifies, generated from `git ls-files` so a new source file is in
 * scope the moment it is tracked (AGENTS.md §3, "generate a list rather
 * than writing it"). `__tests__/` is deliberately NOT scanned: test code
 * legitimately constructs both readings side by side to assert they stay
 * independent (see e.g. the fixtures Task 8's PDF/report tests build), and
 * scanning it would force exactly the kind of exception list this test is
 * trying to avoid needing in the FIRST place. Excluding the whole
 * directory tree by never globbing it is a boundary decision, not an
 * exception carved out of a broader scan.
 *
 * WHY COMMENTS ARE STRIPPED BEFORE SCANNING. The first version of this
 * test scanned raw source text (per the brief) and found 7 "offenders" on
 * first run, e.g. `components/report/PrincipleScorecard.tsx:20`:
 *   * `pct` (maturity) and `practices` (checklist coverage) are the two
 * and `lib/engine/AssessmentEngine.js:52`:
 *   * each return an EvidenceScore (maturity + practices) instead of a
 * Every one was a JSDoc or inline comment written BY this plan's own
 * tasks to explain that the two readings are independent -- exactly the
 * documentation this guard should want to exist. A regex cannot tell "this
 * line's prose mentions both concepts, one of the +/- surrounding words or
 * the / in a doc-comment path reference" from "this line computes a
 * blend". Per AGENTS.md §3 ("tighten the rule rather than adding an
 * exception list -- an exception list is where the next real violation
 * hides"), the fix is to narrow WHAT is scanned (code, not prose) rather
 * than to allowlist these specific files/lines, which would have hidden a
 * real future violation in any of them.
 *
 * The comment stripper is a line-oriented state machine, not a real
 * parser: it tracks `//` and `/* *\/`-style comments correctly but does
 * NOT understand string or template-literal contents, so a code line
 * containing a string with `//` or `/*` in it could be mis-split. No line
 * in the current scan trips that edge case (verified by inspecting every
 * match before and after stripping); it is a stated limitation of the
 * heuristic, not a claim of a full lexer.
 *
 * Non-vacuity (O-7): proven by hand, not merely asserted. Added
 * `const blended = (score.maturity + score.practices.inPlace) / 2;` to
 * `components/report/useFindingsData.ts` after the existing `const pct =
 * score.maturity;` line, re-ran, and confirmed the failure names that
 * exact file and line; removed it and confirmed a clean pass. Both raw
 * outputs are recorded in this task's report, not reproduced here.
 */

/** Tracked files only -- generated from git, not a hand-maintained glob
 *  (the convention `node-version-alignment.test.ts` documents). `glob` is
 *  not a dependency of this repo. */
function scannedFiles(): string[] {
  return execFileSync('git', ['ls-files', 'components', 'lib', 'app'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx|js)$/.test(f));
}

/**
 * Strips `//` and `/* *\/` comments from a file's text, line by line,
 * returning one (possibly emptied) string per source line so reported
 * line numbers still match the original file. Deliberately NOT string- or
 * template-literal-aware -- see the file-level comment above.
 */
function stripComments(source: string): string[] {
  const lines = source.split('\n');
  const codeLines: string[] = [];
  let inBlockComment = false;

  for (const rawLine of lines) {
    let code = '';
    let i = 0;
    while (i < rawLine.length) {
      if (inBlockComment) {
        const close = rawLine.indexOf('*/', i);
        if (close === -1) {
          i = rawLine.length;
        } else {
          i = close + 2;
          inBlockComment = false;
        }
        continue;
      }
      const lineCommentAt = rawLine.indexOf('//', i);
      const blockCommentAt = rawLine.indexOf('/*', i);
      if (lineCommentAt !== -1 && (blockCommentAt === -1 || lineCommentAt < blockCommentAt)) {
        code += rawLine.slice(i, lineCommentAt);
        i = rawLine.length;
        break;
      }
      if (blockCommentAt !== -1) {
        code += rawLine.slice(i, blockCommentAt);
        i = blockCommentAt + 2;
        inBlockComment = true;
        continue;
      }
      code += rawLine.slice(i);
      i = rawLine.length;
    }
    codeLines.push(code);
  }
  return codeLines;
}

describe('O-6: nothing averages, sums or blends the two readings', () => {
  it('scan discovers a substantial, non-empty file set (guards against a vacuous pass)', () => {
    // A broken invocation (wrong cwd, git failure, wrong path args) returns
    // [] or near-empty, which would make the offenders check below pass by
    // finding nothing to scan. 50 is comfortably below the current count
    // (107) and comfortably above what a broken scan would produce.
    expect(scannedFiles().length).toBeGreaterThan(50);
  });

  it('has no code expression taking both maturity and practices as operands', () => {
    const offenders: string[] = [];

    for (const file of scannedFiles()) {
      const codeLines = stripComments(readFileSync(file, 'utf8'));
      codeLines.forEach((line, i) => {
        // An arithmetic operator with both readings named on the same
        // line of CODE (comments stripped) is the shape of the original
        // defect. Distinct units make this unlikely by accident, which is
        // exactly why it is worth pinning.
        if (/maturity/.test(line) && /practices|inPlace/.test(line) && /[+\-*/]/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
