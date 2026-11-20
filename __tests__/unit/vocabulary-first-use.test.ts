import { describe, expect, it } from 'vitest';
import { DECISION_VERSION_IDS, firstUseViolations, ROLE_IDS, type TextNodeInfo } from '@/lib/vocabulary/firstUse';
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
const VERSION: Concept = { id: 'version-of-a-decision', term: 'version', defineOnFirstUse: true };

/** A node: plain text in block `block` unless told otherwise. */
function node(text: string, o: { block?: string; termIds?: string[]; defs?: string[]; role?: boolean; version?: boolean } = {}): TextNodeInfo {
  return { text, termIds: o.termIds ?? [], blockKey: o.block ?? 'b0', definitionIdsInBlock: o.defs ?? [], inRoleChoice: o.role ?? false, inDecisionVersion: o.version ?? false };
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

  it('ignores "version" outside [data-decision-version] and checks it inside (ruling X-1 (2))', () => {
    // "version 2 of the terms", "the questions' version": other senses of the word, not a decision's version.
    expect(firstUseViolations([node('Terms of service, version 2')], [VERSION])).toEqual([]);
    expect(firstUseViolations([node('Saved as version 3.', { version: true })], [VERSION])).toEqual([{ id: 'version-of-a-decision', text: 'Saved as version 3.' }]);
    // The first use is the first one inside the marker, even when a plain mention comes before it.
    const nodes = [node('Read version 2 of the terms.'), node('Version 3', { block: 'b1', version: true, termIds: ['version-of-a-decision'], defs: ['version-of-a-decision'] })];
    expect(firstUseViolations(nodes, [VERSION])).toEqual([]);
    expect(DECISION_VERSION_IDS).toEqual(['version-of-a-decision']);
  });

  it('checks a concept that is not a decision version inside [data-decision-version] as anywhere else', () => {
    expect(firstUseViolations([node('Raise a finding on version 3.', { version: true })], [FINDING])).toEqual([{ id: 'finding', text: 'Raise a finding on version 3.' }]);
  });

  it('does not check a role inside [data-decision-version] unless it is also inside [data-role-choice]', () => {
    expect(firstUseViolations([node('Decided by an Owner, version 3.', { version: true })], [OWNER])).toEqual([]);
  });

  it('skips a node whose whole text equals a skipped text: team-typed text, a framework or source name (ruling X-1 (3))', () => {
    const skip = new Set(['Seal the loan model', 'Finding Aid Review']);
    expect(firstUseViolations([node('Seal the loan model')], [SEAL], skip)).toEqual([]);
    expect(firstUseViolations([node('Finding Aid Review')], [FINDING], skip)).toEqual([]);
    // The first use is then the next node that holds the term.
    expect(firstUseViolations([node('Seal the loan model'), node('Each seal is final.', { block: 'b1' })], [SEAL], skip))
      .toEqual([{ id: 'seal', text: 'Each seal is final.' }]);
  });

  it('skips only an exact match: a node that holds a skipped text inside a longer sentence is still read', () => {
    const skip = new Set(['Seal the loan model']);
    expect(firstUseViolations([node('Open Seal the loan model.')], [SEAL], skip)).toEqual([{ id: 'seal', text: 'Open Seal the loan model.' }]);
    expect(firstUseViolations([node('seal the loan model')], [SEAL], skip)).toEqual([{ id: 'seal', text: 'seal the loan model' }]);
  });

  it('a skipped text with one trailing parenthesis (a resource link and its kind) is read as the parenthesis only', () => {
    const skip = new Set(['Deployment Controls']);
    const CONTROL = { id: 'control', term: 'control', defineOnFirstUse: true };
    expect(firstUseViolations([node('Deployment Controls (Framework, opens another site)')], [CONTROL], skip)).toEqual([]);
    expect(firstUseViolations([node('Deployment Controls (a seal of it)')], [SEAL], skip)).toEqual([{ id: 'seal', text: '(a seal of it)' }]);
    expect(firstUseViolations([node('Other Controls (Framework)')], [CONTROL], skip)).toEqual([{ id: 'control', text: 'Other Controls (Framework)' }]);
  });
  it('skips nothing when no skipped texts are given', () => {
    expect(firstUseViolations([node('Seal the loan model')], [SEAL])).toEqual([{ id: 'seal', text: 'Seal the loan model' }]);
    expect(firstUseViolations([node('Seal the loan model')], [SEAL], new Set())).toEqual([{ id: 'seal', text: 'Seal the loan model' }]);
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

  it('passes a plain word that carries a Term and a definition too: it is never checked', () => {
    expect(firstUseViolations([node('project', { termIds: ['project'], defs: ['project'] })], [PROJECT])).toEqual([]);
  });

  it('checks a concept that is not a role inside a role choice as anywhere else', () => {
    expect(firstUseViolations([node('Can raise a finding', { role: true })], [FINDING])).toEqual([{ id: 'finding', text: 'Can raise a finding' }]);
  });

  it('does not match a term touching an accented letter: "éseal" is not "seal"', () => {
    expect(firstUseViolations([node('éseal sealé')], [SEAL])).toEqual([]);
  });

  it('takes the plural on the last word only: "personals data question" is not a use', () => {
    expect(firstUseViolations([node('the personals data question')], [SCOPE])).toEqual([]);
  });

  it('matches a term beside a hyphen, as the word rule has it: "re-seal" is a use of "seal"', () => {
    expect(firstUseViolations([node('re-seal')], [SEAL])).toEqual([{ id: 'seal', text: 're-seal' }]);
  });

  it('lets a longer checked term consume a shorter one inside it (L2-28): "mitigation plan" is not a use of "mitigation"', () => {
    const MITIGATION: Concept = { id: 'mitigation', term: 'mitigation', defineOnFirstUse: true };
    const PLAN: Concept = { id: 'mitigation-plan', term: 'mitigation plan', defineOnFirstUse: true };
    const nodes = [node('Write the mitigation plans.', { termIds: ['mitigation-plan'], defs: ['mitigation-plan'] }), node('Add a mitigation.', { block: 'b1' })];
    expect(firstUseViolations(nodes, [MITIGATION, PLAN])).toEqual([{ id: 'mitigation', text: 'Add a mitigation.' }]);
    // In the same node, a use of the shorter term outside the longer one is still a use.
    expect(firstUseViolations([node('A mitigation plan and a mitigation.', { termIds: ['mitigation-plan'], defs: ['mitigation-plan'] })], [MITIGATION, PLAN]))
      .toEqual([{ id: 'mitigation', text: 'A mitigation plan and a mitigation.' }]);
    // Without the longer concept in the list, nothing is consumed.
    expect(firstUseViolations([node('Write the mitigation plan.')], [MITIGATION])).toHaveLength(1);
  });

  it('finds every first-use term of the vocabulary in a sentence that uses it', () => {
    const checked = Object.values(terms).filter((c) => c.defineOnFirstUse);
    expect(checked).toHaveLength(27);
    for (const c of checked) {
      const role = (ROLE_IDS as readonly string[]).includes(c.id);
      const version = (DECISION_VERSION_IDS as readonly string[]).includes(c.id);
      expect(firstUseViolations([node(`Before ${c.term}, after.`, { role, version })], [c]), c.id).toEqual([{ id: c.id, text: `Before ${c.term}, after.` }]);
    }
  });
});
