import { describe, it, expect } from 'vitest';
import { questionExistsInBank } from '../../lib/data/evidence';

/**
 * Task 6, O-22. `questionExistsInBank` is the pure lookup the evidence
 * upload route uses to reject a questionId absent from the question bank.
 * Tested in isolation (no database) the same way __tests__/unit/
 * evidence-inspect.test.ts pins `inspect()` -- both are pure functions this
 * project's convention tests directly rather than only through the route
 * that calls them.
 */
describe('questionExistsInBank', () => {
  it('accepts a real question id from the first stage/module', () => {
    // data/questionBank.json: stages['pre-processing'].modules[0].questions[0].id
    expect(questionExistsInBank('Q-PP-01')).toBe(true);
  });

  it('accepts a question id from a DIFFERENT stage -- proves the lookup is not scoped to only the first stage it happens to check first', () => {
    // Confirmed present by direct inspection of data/questionBank.json's
    // 'in-processing' stage during this task's investigation.
    expect(questionExistsInBank('Q-IP-01')).toBe(true);
  });

  it('rejects a plausible-looking but nonexistent id', () => {
    expect(questionExistsInBank('Q-DOES-NOT-EXIST-ANYWHERE')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(questionExistsInBank('')).toBe(false);
  });

  it('is case-sensitive -- a real id with different casing is rejected, not fuzzy-matched', () => {
    expect(questionExistsInBank('q-pp-01')).toBe(false);
  });
});
