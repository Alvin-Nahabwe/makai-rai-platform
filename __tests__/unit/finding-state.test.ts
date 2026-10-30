import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveFindingState } from '@/lib/findings/state';

const S = (o: Partial<Parameters<typeof deriveFindingState>[0]>) =>
  deriveFindingState({ source: 'team', events: [], currentMitigations: [], acceptedRisks: [], ...o });

describe('deriveFindingState (SRS 5.3 item 11)', () => {
  it('FR-FND-07 (5.3 item 11 rule 1): a withdrawn event wins', () =>
    expect(S({ events: [{ kind: 'withdrawn', findingSeq: 1 }], acceptedRisks: [{ findingSeq: 2 }] })).toBe('withdrawn'));

  it('FR-FND-07 (rule 1): withdrawn wins over a done mitigation and a later reopen', () => {
    expect(S({ events: [{ kind: 'withdrawn', findingSeq: 1 }], currentMitigations: [{ status: 'done', findingSeq: 2 }] })).toBe('withdrawn');
    expect(S({ events: [{ kind: 'reopened', findingSeq: 3 }, { kind: 'withdrawn', findingSeq: 1 }] })).toBe('withdrawn');
  });

  it('FR-FND-07 (rule 2): an accepted risk after the latest reopen closes it', () =>
    expect(S({ events: [{ kind: 'reopened', findingSeq: 2 }], acceptedRisks: [{ findingSeq: 3 }] })).toBe('closed_accepted_risk'));

  it('FR-FND-07 (rule 2): an accepted risk before the reopen counts no longer', () =>
    expect(S({ acceptedRisks: [{ findingSeq: 1 }], events: [{ kind: 'reopened', findingSeq: 2 }] })).toBe('open'));

  it('FR-FND-07 (rule 2): with no reopen R is 0, so any accepted risk closes it; the latest reopen is the one that counts', () => {
    expect(S({ acceptedRisks: [{ findingSeq: 1 }] })).toBe('closed_accepted_risk');
    // two reopens: R is the higher findingSeq, whatever the order they are given in
    expect(S({ events: [{ kind: 'reopened', findingSeq: 4 }, { kind: 'reopened', findingSeq: 2 }], acceptedRisks: [{ findingSeq: 3 }] })).toBe('open');
    expect(S({ events: [{ kind: 'reopened', findingSeq: 2 }, { kind: 'reopened', findingSeq: 4 }], acceptedRisks: [{ findingSeq: 3 }, { findingSeq: 5 }] })).toBe('closed_accepted_risk');
  });

  it('FR-FND-07 (rule 2 before rule 3): an accepted risk closes it even when a mitigation is done', () =>
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }], acceptedRisks: [{ findingSeq: 2 }] })).toBe('closed_accepted_risk'));

  it('FR-FND-07 (rule 3): closed by mitigation needs a done after R and nothing planned or in progress', () => {
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }, { status: 'cancelled', findingSeq: 2 }] })).toBe('closed_mitigation');
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }, { status: 'planned', findingSeq: 2 }] })).toBe('open');
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }, { status: 'in_progress', findingSeq: 2 }] })).toBe('open');
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }], events: [{ kind: 'reopened', findingSeq: 2 }] })).toBe('open');
  });

  it('FR-FND-07 (rule 3): a done mitigation after the reopen closes it again; one before it does not count', () => {
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 3 }], events: [{ kind: 'reopened', findingSeq: 2 }] })).toBe('closed_mitigation');
    expect(S({ currentMitigations: [{ status: 'done', findingSeq: 1 }, { status: 'done', findingSeq: 3 }], events: [{ kind: 'reopened', findingSeq: 2 }] })).toBe('closed_mitigation');
  });

  it('FR-FND-07 (rule 4): otherwise open; all cancelled is open', () => {
    expect(S({ currentMitigations: [{ status: 'cancelled', findingSeq: 1 }] })).toBe('open');
    expect(S({})).toBe('open');
    expect(S({ currentMitigations: [{ status: 'planned', findingSeq: 1 }] })).toBe('open');
  });

  it('FR-FND-07 (rule 3 vs 4): a cancelled mitigation after the reopen is not a done one', () =>
    expect(S({ currentMitigations: [{ status: 'cancelled', findingSeq: 3 }], events: [{ kind: 'reopened', findingSeq: 2 }] })).toBe('open'));

  it('FR-FND-07 (helper): the source does not change the state, and the input is not changed', () => {
    const input = {
      events: [{ kind: 'reopened' as const, findingSeq: 2 }], currentMitigations: [{ status: 'done' as const, findingSeq: 3 }], acceptedRisks: [],
    };
    const before = JSON.stringify(input);
    expect(deriveFindingState({ source: 'shortfall', ...input })).toBe(deriveFindingState({ source: 'team', ...input }));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('FR-REV-04 (helper, gap G013): the body runs under plain Node with no TypeScript and imports nothing', () => {
    const file = resolve('lib/findings/state.mjs');
    expect(readFileSync(file, 'utf8')).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
    const script = `import(${JSON.stringify(file)}).then((m) => process.stdout.write(m.deriveFindingState({`
      + ` source: 'team', events: [{ kind: 'reopened', findingSeq: 2 }], currentMitigations: [{ status: 'done', findingSeq: 3 }], acceptedRisks: [] })))`;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe('closed_mitigation');
    // the typed re-export is the same function
    expect(readFileSync(resolve('lib/findings/state.ts'), 'utf8').trim()).toBe("export { deriveFindingState } from './state.mjs';");
  });
});
