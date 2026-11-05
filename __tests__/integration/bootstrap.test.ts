import { describe, expect, it } from 'vitest';
import { deriveSlug } from '../../lib/data/preauth';

describe('deriveSlug', () => {
  // The accented cases are real institution names from the target market
  // (AGENTS.md: primary adopter is African university teams, including
  // Francophone institutions), not an abstract Unicode-property exercise —
  // this documents the product requirement, not just the code's behaviour.
  // Expected values computed empirically (`node -e`, see fix-round-1 report
  // in the SDD workspace), not hand-simulated: NFKD normalisation is easy to
  // get wrong by inspection, which is exactly the error being fixed here.
  it.each([
    ['Makerere AI Lab', 'makerere-ai-lab'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere'],
    ['Université de Kinshasa', 'universite-de-kinshasa'],
    ['École Polytechnique', 'ecole-polytechnique'],
    ['São Paulo Institute', 'sao-paulo-institute'],
    ['Åbo Akademi', 'abo-akademi'],
    ['a'.repeat(80), 'a'.repeat(48)],
  ])('derives %j to %j', (input, expected) => expect(deriveSlug(input)).toBe(expected));
});
