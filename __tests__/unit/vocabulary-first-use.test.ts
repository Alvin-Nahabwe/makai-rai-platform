import { describe, expect, it } from 'vitest';
import { firstUseViolations, ROLE_IDS, type TextNodeInfo } from '@/lib/vocabulary/firstUse';
import * as terms from '@/lib/vocabulary/terms';

/**
 * Plan 1A, Task 9: a screen's first use of a defined term sits beside its definition. The rule is pure; the browser
 * spec e2e/vocabulary-first-use.spec.ts collects the text nodes of `main` (outside `nav`) and calls it. Each fixture
 * below is a list of nodes in document order, as that collector returns them.
 */

type Concept = { id: string; term: string; defineOnFirstUse: boolean };

const FINDING: Concept = { id: 'finding', term: 'finding', defineOnFirstUse: true };
const SEAL: Concept = { id: 'seal', term: 'seal', defineOnFirstUse: true };
const PROJECT: Concept = { id: 'project', term: 'project', defineOnFirstUse: false };
const SCOPE: Concept = { id: 'personal-data-question-scope-question', term: 'the personal data question', defineOnFirstUse: true };
const OWNER: Concept = { id: 'owner', term: 'Owner', defineOnFirstUse: true };

/** A node: plain text in block `block` unless told otherwise. */
function node(text: string, o: { block?: string; termIds?: string[]; defs?: string[]; role?: boolean } = {}): TextNodeInfo {
  return { text, termIds: o.termIds ?? [], blockKey: o.block ?? 'b0', definitionIdsInBlock: o.defs ?? [], inRoleChoice: o.role ?? false };
}

/** The first use, marked with Term and with the definition in its block. */
const defined = (text: string, id: string, block = 'b0') => node(text, { block, termIds: [id], defs: [id] });

describe('firstUseViolations', () => {
  it('passes a first use whose block holds its definition', () => {
    expect(firstUseViolations([defined('finding', 'finding'), node('A gap your team has noted.', { defs: ['finding'] })], [FINDING])).toEqual([]);
  });

  it('fails a first use with no definition, naming the id and the text', () => {
    expect(firstUseViolations([node('Raise a finding for this question.')], [FINDING])).toEqual([{ id: 'finding', text: 'Raise a finding for this question.' }]);
  });

  it('passes a later use without a definition', () => {
    const nodes = [defined('finding', 'finding', 'b0'), node('Open the finding later.', { block: 'b1' })];
    expect(firstUseViolations(nodes, [FINDING])).toEqual([]);
  });

  it('matches a plural on the last word', () => {
    expect(firstUseViolations([node('Two findings are open.')], [FINDING])).toEqual([{ id: 'finding', text: 'Two findings are open.' }]);
    expect(firstUseViolations([node('Answer the personal data questions.')], [SCOPE])).toHaveLength(1);
  });

  it('never reports a plain word (defineOnFirstUse false), with or without a definition', () => {
    expect(firstUseViolations([node('Create a project.')], [PROJECT])).toEqual([]);
  });

  it('passes a term whose first appearance is in nav once its first main-content use has its definition', () => {
    // The collector leaves out every node inside `nav`, so the sidebar's "Findings" is not in the list: the first node
    // the rule sees is the main content's use. The browser spec's collector self-test checks that `nav` is left out.
    expect(firstUseViolations([node('Projects'), defined('finding', 'finding', 'b1')], [FINDING])).toEqual([]);
  });

  it('ignores a role named outside [data-role-choice] and checks one inside it', () => {
    expect(firstUseViolations([node('Ask an Owner to invite you.')], [OWNER])).toEqual([]);
    expect(firstUseViolations([node('Owner', { role: true })], [OWNER])).toEqual([{ id: 'owner', text: 'Owner' }]);
    // The first use is the first one inside a role choice, even when a plain mention comes before it.
    const nodes = [node('Ask an Owner.'), node('Owner', { block: 'b1', role: true, termIds: ['owner'], defs: ['owner'] })];
    expect(firstUseViolations(nodes, [OWNER])).toEqual([]);
    expect(ROLE_IDS).toEqual(['owner', 'admin', 'assessor', 'reviewer', 'viewer']);
  });

  it('matches a term of several words within one text node only', () => {
    expect(firstUseViolations([node('Answer the personal data question first.')], [SCOPE])).toHaveLength(1);
    expect(firstUseViolations([node('Answer the personal'), node('data question first.')], [SCOPE])).toEqual([]);
  });

  it('matches whole words only: "sealed" is not "seal", "seals" is', () => {
    expect(firstUseViolations([node('The stage is sealed.')], [SEAL])).toEqual([]);
    expect(firstUseViolations([node('Unseal nothing.')], [SEAL])).toEqual([]);
    expect(firstUseViolations([node('Two seals.')], [SEAL])).toEqual([{ id: 'seal', text: 'Two seals.' }]);
  });

  it('matches case-insensitively', () => {
    expect(firstUseViolations([node('FINDING')], [FINDING])).toHaveLength(1);
    expect(firstUseViolations([node('the Personal Data Question')], [SCOPE])).toHaveLength(1);
  });

  it('takes the first use in document order across blocks', () => {
    const late = [node('A finding here.', { block: 'b0' }), defined('finding', 'finding', 'b1')];
    expect(firstUseViolations(late, [FINDING])).toEqual([{ id: 'finding', text: 'A finding here.' }]);
    const early = [defined('finding', 'finding', 'b0'), node('A finding here.', { block: 'b1' })];
    expect(firstUseViolations(early, [FINDING])).toEqual([]);
  });

  it('fails a first use not marked with Term even when its block holds the definition', () => {
    expect(firstUseViolations([node('finding', { defs: ['finding'] })], [FINDING])).toEqual([{ id: 'finding', text: 'finding' }]);
  });

  it('fails a first use whose block holds the definition of another term only', () => {
    expect(firstUseViolations([node('finding', { termIds: ['finding'], defs: ['seal'] })], [FINDING])).toEqual([{ id: 'finding', text: 'finding' }]);
  });

  it('gives no violation for an empty node list or a page that never uses the term', () => {
    expect(firstUseViolations([], [FINDING, SEAL, OWNER])).toEqual([]);
    expect(firstUseViolations([node('Nothing to see.')], [FINDING])).toEqual([]);
  });

  it('reports each checked concept once, in the order the concepts are given', () => {
    const nodes = [node('A seal and a finding.'), node('Another finding.', { block: 'b1' })];
    expect(firstUseViolations(nodes, [FINDING, SEAL])).toEqual([{ id: 'finding', text: 'A seal and a finding.' }, { id: 'seal', text: 'A seal and a finding.' }]);
  });

  it('finds every first-use term of the vocabulary in a sentence that uses it', () => {
    const checked = Object.values(terms).filter((c) => c.defineOnFirstUse);
    expect(checked).toHaveLength(26);
    for (const c of checked) {
      const role = (ROLE_IDS as readonly string[]).includes(c.id);
      expect(firstUseViolations([node(`Before ${c.term}, after.`, { role })], [c]), c.id).toEqual([{ id: c.id, text: `Before ${c.term}, after.` }]);
    }
  });
});
