/**
 * Plan 1A, Task 9: a screen's first use of a defined term sits beside its definition. Pure: the browser spec
 * e2e/vocabulary-first-use.spec.ts imports it into Playwright, so it imports nothing from React, the DOM, `server-only`
 * or data access.
 *
 * Only concepts with `defineOnFirstUse: true` are checked. For each, the first node in document order whose text
 * holds the term as whole words (case-insensitive, an optional plural `s` on the last word) is the first use. That
 * node must be marked with `Term` (its `termIds` hold the id) and its block must hold `Definition` for the id. A role
 * (ROLE_IDS) counts only where a screen asks the reader to choose one, inside `[data-role-choice]`; a decision's version
 * (DECISION_VERSION_IDS) counts only where a screen states one, inside `[data-decision-version]` (ruling X-1 (2)), so
 * "version 2 of the terms" is not a use. A longer checked term consumes a shorter one inside it: "mitigation plan" is a
 * use of `mitigation-plan`, not of `mitigation` (L2-28). A node whose whole text is one of `skipTexts` (what the team
 * typed, a framework or source name: ruling X-1 (3)) is not read at all; there is no exemption attribute (X-1 (4)).
 */

/** One text node of `main` outside `nav`, in document order, as the browser spec's collector reads it. */
export type TextNodeInfo = {
  text: string;
  /** The `data-term` ids of the node's ancestors. */
  termIds: readonly string[];
  /**
   * Stands for the node's block: its closest `p, li, dt, dd, label, legend, th, td, h1-h6, .ui-field, .ui-callout`.
   * Diagnostics only: the rule never reads it (`definitionIdsInBlock` carries the relation).
   */
  blockKey: string;
  /**
   * The `data-definition` ids beside the node: in its block, or tied to it as the collector's comment says (L2-29),
   * including a toggletip holding the vocabulary's exact sentence, closed or open (the owner's ruling of 15 November 2026).
   */
  definitionIdsInBlock: readonly string[];
  /** True when the node is inside `[data-role-choice]`. */
  inRoleChoice: boolean;
  /** True when the node is inside `[data-decision-version]`, an element that states a decision's version. */
  inDecisionVersion: boolean;
};

/** The role concepts: a use of one counts only inside `[data-role-choice]`. */
export const ROLE_IDS = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const;

const ROLES: ReadonlySet<string> = new Set(ROLE_IDS);

/** The concepts of a decision's version: a use of one counts only inside `[data-decision-version]` (ruling X-1 (2)). */
export const DECISION_VERSION_IDS = ['version-of-a-decision'] as const;

const DECISION_VERSIONS: ReadonlySet<string> = new Set(DECISION_VERSION_IDS);

/** Where a use of the concept counts: a role inside a role choice, a decision's version inside one, any other anywhere. */
function inScope(id: string): (n: TextNodeInfo) => boolean {
  if (ROLES.has(id)) return (n) => n.inRoleChoice;
  if (DECISION_VERSIONS.has(id)) return (n) => n.inDecisionVersion;
  return () => true;
}

/** The term as whole words: letters or digits may not touch either end, and the last word may take a plural `s`. */
function termPattern(term: string): RegExp {
  const words = term.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}s?(?![\\p{L}\\p{N}])`, 'iu');
}

export function firstUseViolations(
  nodes: readonly TextNodeInfo[],
  concepts: ReadonlyArray<{ id: string; term: string; defineOnFirstUse: boolean }>,
  skipTexts: ReadonlySet<string> = new Set(),
): Array<{ id: string; text: string }> {
  const violations: Array<{ id: string; text: string }> = [];
  const checked = concepts.filter((c) => c.defineOnFirstUse);
  const read = nodes.filter((n) => !skipTexts.has(n.text));
  for (const concept of checked) {
    const pattern = termPattern(concept.term);
    // L2-28: a longer checked term that holds this one ("mitigation plan" holds "mitigation") consumes it, so the
    // longer term's words are blanked before this term is looked for.
    const longer = checked.filter((c) => c !== concept && c.term.length > concept.term.length && pattern.test(c.term)).map((c) => new RegExp(termPattern(c.term).source, 'giu'));
    const outsideLonger = (text: string) => longer.reduce((t, re) => t.replace(re, ' '), text);
    const counts = inScope(concept.id);
    const first = read.find((n) => counts(n) && pattern.test(outsideLonger(n.text)));
    if (first === undefined) continue;
    if (!first.termIds.includes(concept.id) || !first.definitionIdsInBlock.includes(concept.id)) {
      violations.push({ id: concept.id, text: first.text });
    }
  }
  return violations;
}
