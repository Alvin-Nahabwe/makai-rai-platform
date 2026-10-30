/**
 * Tests of the question-set coverage check and the table renderer
 * (SRS 10.1.0 step 2, CW-00; contract: the proposal format of types/content.ts).
 *
 * Every bank here is synthetic (ids Q-T-nn, areas A1 to A3, controls C1 to C4),
 * never the real content, so no test depends on which real ids survive a revision
 * (SRS line 5200, call R-62).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkCoverage,
  questionAreas,
  questionControlPairs,
  revisedQuestionControlPairs,
  reviseQuestions,
  scanSrsIds,
  scanSrsSections,
  type CoverageAreas,
  type CoverageBank,
  type CoverageFieldMap,
  type CoverageQuestion,
} from '@/scripts/content/coverage';
import { runCli } from '@/scripts/content/question-set-coverage';
import {
  canonicalJson,
  questionSetBatchHash,
  questionSetPayload,
  renderQuestionSetTables,
} from '@/scripts/content/render-tables';
import type {
  OptionMapping,
  QuestionSetProposal,
  RevisionAction,
  Stage,
} from '@/scripts/content/types';

// ---------------------------------------------------------------------------
// Fixture: five questions in two stages, three areas, four controls.
//   A1 -> C1, C2    A2 -> C2, C3    A3 -> C4
//   Q-T-01 A1 | Q-T-02 A2 | Q-T-03 (checklist) A1 via o1, A2 via o2 | Q-T-04 A3 | Q-T-05 A3
//   pairs: 2 + 2 + 3 + 1 + 1 = 9
// ---------------------------------------------------------------------------

function question(
  id: string,
  type: string,
  gaps: string[],
  optionGapMap?: Record<string, Array<string | OptionMapping>>,
): CoverageQuestion {
  const q: CoverageQuestion = { id, type, text: `Stem of ${id}?`, gaps };
  if (optionGapMap) {
    q.optionGapMap = optionGapMap;
    q.options = Object.keys(optionGapMap);
  }
  return q;
}

function makeBank(): CoverageBank {
  return {
    stages: {
      'pre-processing': {
        modules: [
          {
            id: 'm-pre',
            questions: [
              question('Q-T-01', 'likert-5', ['A1']),
              question('Q-T-02', 'likert-5', ['A2']),
              question('Q-T-03', 'checklist', [], {
                o1: [{ area: 'A1', role: 'primary' }],
                o2: ['A2'],
              }),
            ],
          },
        ],
      },
      'in-processing': {
        modules: [
          {
            id: 'm-in',
            questions: [question('Q-T-04', 'likert-5', ['A3']), question('Q-T-05', 'likert-5', ['A3'])],
          },
        ],
      },
      'post-processing': { modules: [] },
    },
  };
}

function makeAreas(): CoverageAreas {
  return {
    areas: [
      { id: 'A1', stage: 'pre-processing', controls: ['C1', 'C2'] },
      { id: 'A2', stage: 'pre-processing', controls: ['C2', 'C3'] },
      { id: 'A3', stage: 'in-processing', controls: ['C4'] },
    ],
    controls: [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }, { id: 'C4' }],
  };
}

const BASE_IDS = ['Q-T-01', 'Q-T-02', 'Q-T-03', 'Q-T-04', 'Q-T-05'];

function keep(id: string): RevisionAction {
  return { action: 'keep', id, originalText: `Stem of ${id}?`, reason: 'kept' };
}

/** All-keep actions, with `changes` replacing the action of the named ids. */
function actions(changes: Record<string, RevisionAction> = {}): RevisionAction[] {
  return BASE_IDS.map((id) => changes[id] ?? keep(id));
}

function proposal(over: Partial<QuestionSetProposal> = {}): QuestionSetProposal {
  return {
    base: { commit: 'd13be0c', file: 'data/questionBank.json', sha256: 'f'.repeat(64) },
    status: 'draft',
    actions: actions(),
    newQuestions: [],
    survivors: [],
    decisions: { 'OD-08': 'd8', 'OD-09': 'd9', 'OD-C3': 'dc3' },
    repoints: [],
    disputed: [],
    ...over,
  };
}

function cut(id: string): RevisionAction {
  return { action: 'cut', id, originalText: `Stem of ${id}?`, reason: 'cut' };
}
function merge(id: string, into: string): RevisionAction {
  return { action: 'merge', id, originalText: `Stem of ${id}?`, into, reason: 'merged' };
}
function replace(id: string, newId: string): RevisionAction {
  return { action: 'replace', id, originalText: `Stem of ${id}?`, newId, reason: 'replaced' };
}

function run(p: QuestionSetProposal, extra: { maps?: CoverageFieldMap[]; srsText?: string } = {}) {
  return checkCoverage({
    bank: makeBank(),
    areas: makeAreas(),
    proposal: p,
    maps: extra.maps ?? [],
    srsText: extra.srsText,
  });
}

const FIELD_MAPS: CoverageFieldMap[] = [
  {
    documentType: 'data_card',
    fields: [
      {
        fieldId: 'DC-01',
        label: 'Purpose',
        sources: [{ kind: 'record', questionId: 'Q-T-02' }, { kind: 'typed' }],
      },
    ],
  },
  {
    documentType: 'model_card',
    fields: [
      {
        fieldId: 'MC-01',
        label: 'Known limits',
        sources: [{ kind: 'record_option', questionId: 'Q-T-03', option: 'o1' }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------

describe('questionAreas and questionControlPairs (FULL reading, QC-02)', () => {
  it('QC-02 FR-CNT-01: a question maps to its gaps and to every area of its optionGapMap, strings and objects alike', () => {
    const bank = makeBank();
    const q3 = bank.stages['pre-processing'].modules[0].questions[2];
    expect([...questionAreas(q3)].sort()).toEqual(['A1', 'A2']);
    expect([...questionAreas(question('Q-T-09', 'likert-5', ['A3', 'A1']))].sort()).toEqual(['A1', 'A3']);
    expect(questionAreas(question('Q-T-10', 'gate', [])).size).toBe(0);
  });

  it('QC-02 FR-CNT-01: question-control pairs are each question\'s areas\' controls, 9 in the fixture', () => {
    const pairs = questionControlPairs(makeBank(), makeAreas());
    expect(Object.fromEntries([...pairs].map(([id, set]) => [id, [...set].sort()]))).toEqual({
      'Q-T-01': ['C1', 'C2'],
      'Q-T-02': ['C2', 'C3'],
      'Q-T-03': ['C1', 'C2', 'C3'],
      'Q-T-04': ['C4'],
      'Q-T-05': ['C4'],
    });
    expect([...pairs.values()].reduce((n, s) => n + s.size, 0)).toBe(9);
  });

  it('QC-02: a question that maps to an area the areas file lacks stops the check', () => {
    const bank = makeBank();
    bank.stages['pre-processing'].modules[0].questions[0].gaps = ['A9'];
    expect(() => questionControlPairs(bank, makeAreas())).toThrow(/Q-T-01.*A9/);
  });
});

describe('checkCoverage (CW-00 step 2)', () => {
  it('CW-00 FR-CNT-01: an all-keep proposal passes and keeps every pair', () => {
    const r = run(proposal());
    expect(r.failures).toEqual([]);
    expect(r.affectedSrsIds).toEqual([]);
    expect(r.thinnedAreas).toEqual([]);
    const kept = revisedQuestionControlPairs(makeBank(), makeAreas(), proposal());
    expect([...kept.values()].reduce((n, s) => n + s.size, 0)).toBe(9);
    expect(kept).toEqual(questionControlPairs(makeBank(), makeAreas()));
  });

  it('CW-00 FR-CNT-01: fails when a risk area is mapped from no kept question', () => {
    const r = run(proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': cut('Q-T-05') }) }));
    expect(r.failures).toContainEqual(expect.stringMatching(/risk area A3 is mapped from no kept question/));
  });

  it('CW-00 FR-CNT-01: fails when a control is unreachable from the kept questions', () => {
    const r = run(proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': cut('Q-T-05') }) }));
    expect(r.failures).toContainEqual(expect.stringMatching(/control C4 is unreachable from the kept questions/));
    // C1 to C3 stay reachable: no other control is named
    expect(r.failures.filter((f) => /^control /.test(f))).toHaveLength(1);
  });

  it('CW-00 FR-CNT-01: fails when a control is in no area list at all', () => {
    const areas = makeAreas();
    areas.controls.push({ id: 'C9' });
    const r = checkCoverage({ bank: makeBank(), areas, proposal: proposal(), maps: [] });
    expect(r.failures).toEqual(['control C9 is unreachable from the kept questions']);
  });

  it('CW-00 R-61: fails when a merge survivor lacks the union of the merged areas', () => {
    // Q-T-02 (A2) merges into Q-T-01 (A1): the survivor must map A1 and A2.
    const lacking = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1'] }],
    });
    expect(run(lacking).failures).toContainEqual(
      expect.stringMatching(/merge survivor Q-T-01 lacks risk area A2 of Q-T-02/),
    );

    const complete = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
    });
    expect(run(complete).failures).toEqual([]);
  });

  it('CW-00 R-61: the union counts option areas, and a checklist survivor may carry them in optionGapMap', () => {
    // Q-T-02 (A2) merges into the checklist Q-T-03 (A1 and A2 through options o1, o2), both pre-processing:
    // union A1, A2, where A1 comes only through an option, so a survivor entry without the map would lack it.
    const viaOptions = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-03') }),
      survivors: [{ id: 'Q-T-03', gaps: ['A2'], optionGapMap: { o1: [{ area: 'A1', role: 'primary' }], o2: ['A2'] } }],
    });
    expect(run(viaOptions).failures).toEqual([]);
    const pairs = revisedQuestionControlPairs(makeBank(), makeAreas(), viaOptions);
    expect([...(pairs.get('Q-T-03') as Set<string>)].sort()).toEqual(['C1', 'C2', 'C3']);
    expect(pairs.has('Q-T-02')).toBe(false);
    const withoutMap = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-03') }),
      survivors: [{ id: 'Q-T-03', gaps: ['A2'] }],
    });
    expect(run(withoutMap).failures).toContainEqual('merge survivor Q-T-03 lacks risk area A1 of Q-T-03');
  });

  it('CW-00 R-61: fails when a merge survivor maps beyond the union, or has no survivors entry, or survivors names a non-survivor', () => {
    const beyond = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2', 'A3'] }],
    });
    expect(run(beyond).failures).toContainEqual(
      expect.stringMatching(/merge survivor Q-T-01 maps risk area A3, outside the union/),
    );

    const none = proposal({ actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }), survivors: [] });
    expect(run(none).failures).toContainEqual(expect.stringMatching(/merge survivor Q-T-01 has no entry in survivors/));

    const stray = proposal({ survivors: [{ id: 'Q-T-05', gaps: ['A3'] }] });
    expect(run(stray).failures).toContainEqual(expect.stringMatching(/survivors names Q-T-05, which no merge absorbs into/));

    const unknownArea = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2', 'A9'] }],
    });
    expect(run(unknownArea).failures).toContainEqual(expect.stringMatching(/Q-T-01 maps risk area A9, which is not in the areas file/));
  });

  it('CW-00: fails when a document field reads a cut or merged question and has no re-point', () => {
    const p = proposal({
      actions: actions({ 'Q-T-02': cut('Q-T-02'), 'Q-T-03': merge('Q-T-03', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
    });
    const failures = run(p, { maps: FIELD_MAPS }).failures;
    expect(failures).toContainEqual(expect.stringMatching(/field data_card DC-01 reads Q-T-02 \(cut\) and has no re-point/));
    expect(failures).toContainEqual(
      expect.stringMatching(/field model_card MC-01 reads Q-T-03 \(merged into Q-T-01\) and has no re-point/),
    );

    const repointed = proposal({
      ...p,
      repoints: [
        { documentType: 'data_card', fieldId: 'DC-01', from: 'Q-T-02', to: 'typed_only' },
        { documentType: 'model_card', fieldId: 'MC-01', from: 'Q-T-03', to: 'Q-T-01' },
      ],
    });
    expect(run(repointed, { maps: FIELD_MAPS }).failures).toEqual([]);
  });

  it('CW-00: fails when a document field reads a replaced question and has no re-point', () => {
    const p = proposal({
      actions: actions({ 'Q-T-02': replace('Q-T-02', 'Q-T-06') }),
      newQuestions: [{ id: 'Q-T-06', stage: 'pre-processing', moduleId: 'm-pre', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A2'] }],
    });
    expect(run(p, { maps: FIELD_MAPS }).failures).toContainEqual(
      expect.stringMatching(/field data_card DC-01 reads Q-T-02 \(replaced by Q-T-06\) and has no re-point/),
    );
  });

  it('CW-00: fails on a field that reads a question the base lacks', () => {
    const maps: CoverageFieldMap[] = [
      { documentType: 'data_card', fields: [{ fieldId: 'DC-02', label: 'x', sources: [{ kind: 'record', questionId: 'Q-T-99' }] }] },
    ];
    expect(run(proposal(), { maps }).failures).toContainEqual(
      expect.stringMatching(/field data_card DC-02 reads Q-T-99, which is not a v0\.5\.0 question/),
    );
  });

  it('CW-00: fails on a re-point that names no field, a source the field does not read, a kept question, or a target that is not kept', () => {
    const cutP = (repoints: QuestionSetProposal['repoints']) =>
      proposal({
        actions: actions({ 'Q-T-02': cut('Q-T-02') }),
        repoints: [{ documentType: 'data_card', fieldId: 'DC-01', from: 'Q-T-02', to: 'typed_only' }, ...repoints],
      });
    const failuresOf = (repoints: QuestionSetProposal['repoints']) => run(cutP(repoints), { maps: FIELD_MAPS }).failures;

    expect(failuresOf([{ documentType: 'data_card', fieldId: 'DC-99', from: 'Q-T-02', to: 'typed_only' }])).toContainEqual(
      expect.stringMatching(/re-point data_card DC-99 names a field no field map holds/),
    );
    expect(failuresOf([{ documentType: 'model_card', fieldId: 'MC-01', from: 'Q-T-05', to: 'typed_only' }])).toContainEqual(
      expect.stringMatching(/re-point model_card MC-01 takes the field from Q-T-05, which the field does not read/),
    );
    expect(failuresOf([{ documentType: 'model_card', fieldId: 'MC-01', from: 'Q-T-03', to: 'typed_only' }])).toContainEqual(
      expect.stringMatching(/re-point model_card MC-01 takes the field from Q-T-03, which the proposal keeps/),
    );
    expect(failuresOf([{ documentType: 'data_card', fieldId: 'DC-01', from: 'Q-T-02', to: 'Q-T-02' }])).toContainEqual(
      expect.stringMatching(/re-point data_card DC-01 points to Q-T-02, which is not a kept question/),
    );
    expect(failuresOf([{ documentType: 'data_card', fieldId: 'DC-01', from: 'Q-T-02', to: 'typed_only' }])).toContainEqual(
      expect.stringMatching(/re-point data_card DC-01 from Q-T-02 is listed twice/),
    );
  });

  it('CW-00 R-61: fails when an id is reused (a cut id kept elsewhere, or a newId equal to a base id)', () => {
    const newQ = (id: string, stage: Stage = 'in-processing') => ({
      id, stage, moduleId: 'm-in', type: 'likert-5' as const, text: 'New?', principle: 'p', gaps: ['A3'],
    });

    // newId equal to a base id that is kept
    const keptId = proposal({ actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-04') }), newQuestions: [newQ('Q-T-04')] });
    expect(run(keptId).failures).toContainEqual(expect.stringMatching(/new id Q-T-04 reuses a v0\.5\.0 id/));

    // newId equal to a cut id
    const cutId = proposal({
      actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': replace('Q-T-05', 'Q-T-04') }),
      newQuestions: [newQ('Q-T-04')],
    });
    expect(run(cutId).failures).toContainEqual(expect.stringMatching(/new id Q-T-04 reuses a v0\.5\.0 id/));

    // the replaced question's own id is reused by its replacement
    const ownId = proposal({ actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-05') }), newQuestions: [newQ('Q-T-05')] });
    expect(run(ownId).failures).toContainEqual(expect.stringMatching(/new id Q-T-05 reuses a v0\.5\.0 id/));

    // a merge whose survivor is a cut id keeps the cut id alive elsewhere
    const survivorCut = proposal({
      actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': merge('Q-T-05', 'Q-T-04') }),
      survivors: [{ id: 'Q-T-04', gaps: ['A3'] }],
    });
    expect(run(survivorCut).failures).toContainEqual(expect.stringMatching(/merge of Q-T-05 into Q-T-04, which the proposal cuts/));

    // two replacements with one new id
    const twice = proposal({
      actions: actions({ 'Q-T-04': replace('Q-T-04', 'Q-T-07'), 'Q-T-05': replace('Q-T-05', 'Q-T-07') }),
      newQuestions: [newQ('Q-T-07')],
    });
    expect(run(twice).failures).toContainEqual(expect.stringMatching(/new id Q-T-07 is named by more than one replace/));
  });

  it('CW-00 R-61: fails on a replace without its new question, a new question without a replace, or a new id in another stage', () => {
    const noNew = proposal({ actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }) });
    expect(run(noNew).failures).toContainEqual(expect.stringMatching(/replace of Q-T-05 names new id Q-T-06, but newQuestions has no entry for it/));

    const orphan = proposal({
      newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A3'] }],
    });
    expect(run(orphan).failures).toContainEqual(expect.stringMatching(/newQuestions holds Q-T-06, which no replace names/));

    const otherStage = proposal({
      actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }),
      newQuestions: [{ id: 'Q-T-06', stage: 'pre-processing', moduleId: 'm-pre', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A3'] }],
    });
    expect(run(otherStage).failures).toContainEqual(
      expect.stringMatching(/new id Q-T-06 is in stage pre-processing but replaces Q-T-05 of in-processing/),
    );
  });

  it('CW-00: a replacement counts for coverage like any other question, and a different mapping is listed, not failed', () => {
    // Q-T-04 and Q-T-05 both map A3; replace both: only the new questions keep A3 covered.
    const newQ = (id: string, gaps: string[]) => ({
      id, stage: 'in-processing' as Stage, moduleId: 'm-in', type: 'likert-5' as const, text: 'New?', principle: 'p', gaps,
    });
    const covered = proposal({
      actions: actions({ 'Q-T-04': replace('Q-T-04', 'Q-T-06'), 'Q-T-05': replace('Q-T-05', 'Q-T-07') }),
      newQuestions: [newQ('Q-T-06', ['A3']), newQ('Q-T-07', ['A3'])],
    });
    expect(run(covered).failures).toEqual([]);

    const unmapped = proposal({
      actions: actions({ 'Q-T-04': replace('Q-T-04', 'Q-T-06'), 'Q-T-05': replace('Q-T-05', 'Q-T-07') }),
      newQuestions: [newQ('Q-T-06', []), newQ('Q-T-07', [])],
    });
    expect(run(unmapped).failures).toContainEqual(expect.stringMatching(/risk area A3 is mapped from no kept question/));
  });

  it('CW-00: fails unless the actions cover every base id exactly once', () => {
    const missing = proposal({ actions: actions().filter((a) => a.id !== 'Q-T-05') });
    expect(run(missing).failures).toContainEqual(expect.stringMatching(/no action for v0\.5\.0 question Q-T-05/));

    const twice = proposal({ actions: [...actions(), cut('Q-T-01')] });
    expect(run(twice).failures).toContainEqual(expect.stringMatching(/Q-T-01 has more than one action/));

    const unknown = proposal({ actions: [...actions(), keep('Q-T-99')] });
    expect(run(unknown).failures).toContainEqual(expect.stringMatching(/action names Q-T-99, which is not a v0\.5\.0 question/));
  });

  it('CW-00 R-61: fails when an action states a stem that is not the v0.5.0 stem', () => {
    const p = proposal({
      actions: actions({
        'Q-T-01': { action: 'reword', id: 'Q-T-01', originalText: 'Some other stem?', text: 'New?', reason: 'r' },
      }),
    });
    expect(run(p).failures).toEqual(['originalText of Q-T-01 is not the v0.5.0 stem']);
  });

  it('CW-00: lists SRS-named ids the proposal cuts, merges or replaces, without failing', () => {
    const srsText = [
      '# Spec',
      '## 1. Introduction',
      'Q-T-02 is mentioned in section 1, which is not scanned.',
      '## 3. User journeys',
      'A journey reads Q-T-02 and Q-T-01 (kept).',
      '### 3.1 A sub-section',
      'The sub-section names Q-T-04.',
      '## 5. Data requirements',
      'Q-T-05 is mentioned in section 5, which is not scanned.',
      '## 12. Verification',
      'The check reads Q-T-03 and `Q-T-0` is not an id.',
    ].join('\n');
    const p = proposal({
      actions: actions({
        'Q-T-02': cut('Q-T-02'),
        'Q-T-03': merge('Q-T-03', 'Q-T-01'),
        'Q-T-04': replace('Q-T-04', 'Q-T-06'),
        'Q-T-05': cut('Q-T-05'),
      }),
      newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A3'] }],
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
    });
    const r = run(p, { srsText });
    expect(r.failures).toEqual([]);
    expect(r.affectedSrsIds).toEqual(['Q-T-02', 'Q-T-03', 'Q-T-04']);

    // without an SRS text nothing is listed
    expect(run(p).affectedSrsIds).toEqual([]);
  });

  it('CW-00: scanSrsIds expands the SRS shorthand for several ids and ignores other sections', () => {
    const text = [
      '## 4. Functional requirements',
      'Follow-ups `Q-IP-EXTRA-01/02` and `Q-PO-EXTRA-01..04`, then Q-PP-GATE-SENSITIVE and Q-PP-08.',
      '## 6. External interfaces',
      'Q-PP-99 is outside the scanned sections.',
    ].join('\n');
    const found = scanSrsIds(text);
    expect([...found.keys()].sort()).toEqual([
      'Q-IP-EXTRA-01',
      'Q-IP-EXTRA-02',
      'Q-PO-EXTRA-01',
      'Q-PO-EXTRA-02',
      'Q-PO-EXTRA-03',
      'Q-PO-EXTRA-04',
      'Q-PP-08',
      'Q-PP-GATE-SENSITIVE',
    ]);
    expect(found.get('Q-PO-EXTRA-03')).toEqual([2]);
  });

  it('CW-00: lists risk areas whose question count falls in a stage, without failing', () => {
    // Q-T-05 (A3) is cut: A3 goes from 2 questions to 1 and stays covered.
    const r = run(proposal({ actions: actions({ 'Q-T-05': cut('Q-T-05') }) }));
    expect(r.failures).toEqual([]);
    expect(r.thinnedAreas).toEqual([{ area: 'A3', stage: 'in-processing', before: 2, after: 1 }]);
  });

  it('CW-00 R-61: a merge that moves a mapping onto the survivor keeps an area\'s count when the survivor carries it', () => {
    // Q-T-02 (A2) into Q-T-01 (A1 and A2): A2 had Q-T-02 and Q-T-03, has Q-T-01 and Q-T-03.
    const r = run(
      proposal({
        actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
        survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
      }),
    );
    expect(r.failures).toEqual([]);
    expect(r.thinnedAreas).toEqual([]);
    const pairs = revisedQuestionControlPairs(
      makeBank(),
      makeAreas(),
      proposal({
        actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
        survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
      }),
    );
    expect([...(pairs.get('Q-T-01') as Set<string>)].sort()).toEqual(['C1', 'C2', 'C3']);
    expect(pairs.has('Q-T-02')).toBe(false);
  });

  it('CW-00: counts thinned areas per stage of the questions, so a loss in one stage is not hidden in another', () => {
    // Q-T-04 (in-processing) also maps the pre-processing area A1. Cutting it lowers A1 among in-processing
    // questions (1 to 0) while A1's pre-processing count (Q-T-01, Q-T-03) is unchanged.
    const bank = makeBank();
    bank.stages['in-processing'].modules[0].questions[0] = question('Q-T-04', 'likert-5', ['A3', 'A1']);
    const r = checkCoverage({ bank, areas: makeAreas(), proposal: proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04') }) }), maps: [] });
    expect(r.failures).toEqual([]);
    expect(r.thinnedAreas).toEqual([
      { area: 'A1', stage: 'in-processing', before: 1, after: 0 },
      { area: 'A3', stage: 'in-processing', before: 2, after: 1 },
    ]);
  });

  it('CW-00 R-61: fails on a merge across stages, which no single stage sitting would see whole', () => {
    // Q-T-04 (in-processing, A3) into Q-T-01 (pre-processing, A1): the union is complete, the stages differ.
    const crossing = proposal({
      actions: actions({ 'Q-T-04': merge('Q-T-04', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A3'] }],
    });
    expect(run(crossing).failures).toEqual([
      'merge of Q-T-04 (in-processing) into Q-T-01 (pre-processing) crosses stages',
    ]);
  });

  it('CW-00 FR-CNT-01: fails on a new question with no principle, which content 5.0.0 requires (contract NewQuestion)', () => {
    const withPrinciple = (principle: unknown) =>
      proposal({
        actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }),
        newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'likert-5', text: 'New?', principle, gaps: ['A3'] } as never],
      });
    expect(run(withPrinciple('p')).failures).toEqual([]);
    expect(run(withPrinciple(' ')).failures).toContainEqual('new question Q-T-06 has no principle');
    expect(run(withPrinciple(undefined)).failures).toContainEqual('new question Q-T-06 has no principle');
  });
});

describe('renderQuestionSetTables and the batch hash (CW-00 step 1 output, FR-CNT-02 sign-off)', () => {
  const rewordedProposal = () =>
    proposal({
      actions: actions({
        'Q-T-01': { action: 'reword', id: 'Q-T-01', originalText: 'Stem of Q-T-01?', text: 'New stem?', reason: 'clearer' },
        'Q-T-02': replace('Q-T-02', 'Q-T-06'),
        'Q-T-03': merge('Q-T-03', 'Q-T-01'),
        'Q-T-05': cut('Q-T-05'),
      }),
      newQuestions: [{ id: 'Q-T-06', stage: 'pre-processing', moduleId: 'm-pre', type: 'likert-5', text: 'Replacement?', principle: 'p', gaps: ['A2'] }],
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
      repoints: [
        { documentType: 'data_card', fieldId: 'DC-01', from: 'Q-T-02', to: 'typed_only' },
        { documentType: 'model_card', fieldId: 'MC-01', from: 'Q-T-03', to: 'Q-T-01' },
      ],
    });

  it('NFR-MNT-05 FR-CNT-02: canonicalJson sorts keys by UTF-16 code unit, keeps array order and normalises strings to NFC', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: null, c: true }] })).toBe('{"a":[3,1,{"c":true,"d":null}],"b":1}');
    expect(canonicalJson('é')).toBe(JSON.stringify('é'));
    // U+1F600 is the surrogate pair D83D DE00 and sorts before U+FF5E
    expect(canonicalJson({ '～': 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"～":1}');
    expect(() => canonicalJson(1.5)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
  });

  it('FR-CNT-02: the question-set payload holds the approved stems in content order, a replacement in its predecessor\'s place', () => {
    expect(questionSetPayload(makeBank(), rewordedProposal(), 'pre-processing')).toEqual({
      batch: 'question-set:pre-processing',
      questions: [
        { id: 'Q-T-01', text: 'New stem?' },
        { id: 'Q-T-06', text: 'Replacement?' },
      ],
    });
    expect(questionSetPayload(makeBank(), rewordedProposal(), 'in-processing').questions).toEqual([
      { id: 'Q-T-04', text: 'Stem of Q-T-04?' },
    ]);
    expect(questionSetPayload(makeBank(), rewordedProposal(), 'post-processing').questions).toEqual([]);
  });

  it('FR-CNT-02: the batch hash is the SHA-256 of the canonical JSON of the payload, and a changed stem changes it', () => {
    const expected = createHash('sha256')
      .update(
        '{"batch":"question-set:pre-processing","questions":[{"id":"Q-T-01","text":"New stem?"},{"id":"Q-T-06","text":"Replacement?"}]}',
        'utf8',
      )
      .digest('hex');
    expect(questionSetBatchHash(makeBank(), rewordedProposal(), 'pre-processing')).toBe(expected);

    const changed = rewordedProposal();
    changed.actions = changed.actions.map((a) => (a.id === 'Q-T-01' && a.action === 'reword' ? { ...a, text: 'New stem!' } : a));
    expect(questionSetBatchHash(makeBank(), changed, 'pre-processing')).not.toBe(expected);
  });

  it('CW-00: each stage table lists every base id of the stage with its kind, action, reason and new stem or survivor, and ends with its batch hash', () => {
    const tables = renderQuestionSetTables({ bank: makeBank(), proposal: rewordedProposal(), maps: FIELD_MAPS });
    const pre = tables['pre-processing'];
    for (const id of ['Q-T-01', 'Q-T-02', 'Q-T-03']) expect(pre).toContain(`| ${id} |`);
    expect(pre).not.toContain('| Q-T-04 |');
    // the Kind column is the SRS 10.1.8 kind, not the question type
    expect(pre).toMatch(/\| Q-T-01 \| practice \| reword \| clearer \| New stem\? \|/);
    expect(pre).toMatch(/\| Q-T-02 \| practice \| replace \| replaced \| Q-T-06: Replacement\? \|/);
    expect(pre).toMatch(/\| Q-T-03 \| checklist \| merge \| merged \| Merged into Q-T-01 \|/);
    expect(tables['in-processing']).toMatch(/\| Q-T-05 \| practice \| cut \| cut \| Removed \|/);

    // the stage's re-pointed fields, with labels from the maps and each field's sources after C-MAP's rule
    expect(pre).toMatch(/\| data_card \| DC-01 \| Purpose \| Q-T-02 \| typed only \| typed \|/);
    expect(pre).toMatch(/\| model_card \| MC-01 \| Known limits \| Q-T-03 \| Q-T-01 \| Q-T-01 option 'o1' \|/);

    // the three proposed decisions, in every stage's table
    for (const stage of ['pre-processing', 'in-processing', 'post-processing'] as const) {
      expect(tables[stage]).toContain('**OD-08.** d8');
      expect(tables[stage]).toContain('**OD-09.** d9');
      expect(tables[stage]).toContain('**OD-C3.** dc3');
    }

    // the last non-empty line is the stage's batch hash
    const lastLine = pre.trimEnd().split('\n').pop() as string;
    expect(lastLine).toContain(questionSetBatchHash(makeBank(), rewordedProposal(), 'pre-processing'));
    expect(lastLine).toContain('question-set:pre-processing');
  });

  it('CW-00: the Kind column names the gate, the gate-dependent questions and the follow-ups (SRS 10.1.8 kinds)', () => {
    const bank = makeBank();
    const pre = bank.stages['pre-processing'].modules[0].questions;
    pre.push({ id: 'Q-T-GATE', type: 'gate', text: 'Stem of Q-T-GATE?', gaps: [] });
    pre.push({ id: 'Q-T-07', type: 'likert-5', text: 'Stem of Q-T-07?', gaps: ['A2'], condition: { questionId: 'Q-T-GATE' } });
    bank.stages['in-processing'].modules[0].questions.push(question('Q-T-EXTRA-01', 'likert-5', ['A3']));
    const ids = [...BASE_IDS, 'Q-T-GATE', 'Q-T-07', 'Q-T-EXTRA-01'];
    const t = renderQuestionSetTables({ bank, proposal: proposal({ actions: ids.map(keep) }) });
    expect(t['pre-processing']).toMatch(/\| Q-T-GATE \| gate \| keep \|/);
    expect(t['pre-processing']).toMatch(/\| Q-T-07 \| gate-dependent \| keep \|/);
    expect(t['in-processing']).toMatch(/\| Q-T-EXTRA-01 \| follow-up \| keep \|/);
  });

  it('CW-00: sources after the re-point apply C-MAP\'s rule: typed only drops the source and adds typed once; a re-point keeps the parts', () => {
    const maps: CoverageFieldMap[] = [
      {
        documentType: 'model_card',
        fields: [
          { fieldId: 'MC-31', label: 'Held', sources: [{ kind: 'record', questionId: 'Q-T-02', parts: ['status', 'evidence'] }] },
          {
            fieldId: 'MC-20',
            label: 'Measures',
            sources: [{ kind: 'typed' }, { kind: 'record', questionId: 'Q-T-02', parts: ['reason'] }, { kind: 'record', questionId: 'Q-T-01', parts: ['status'] }],
          },
        ],
      },
    ];
    const p = proposal({
      actions: actions({ 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
      repoints: [
        { documentType: 'model_card', fieldId: 'MC-31', from: 'Q-T-02', to: 'typed_only' },
        { documentType: 'model_card', fieldId: 'MC-20', from: 'Q-T-02', to: 'Q-T-01' },
      ],
    });
    const pre = renderQuestionSetTables({ bank: makeBank(), proposal: p, maps })['pre-processing'];
    expect(pre).toMatch(/\| model_card \| MC-31 \| Held \| Q-T-02 \| typed only \| typed \|/);
    expect(pre).toMatch(/\| model_card \| MC-20 \| Measures \| Q-T-02 \| Q-T-01 \| typed; Q-T-01 reason; Q-T-01 status \|/);

    // without field maps the column says so; with maps that lack the field the renderer stops
    expect(renderQuestionSetTables({ bank: makeBank(), proposal: p })['pre-processing']).toMatch(/\| MC-31 \| - \| Q-T-02 \| typed only \| field maps not given \|/);
    expect(() => renderQuestionSetTables({ bank: makeBank(), proposal: p, maps: [{ documentType: 'model_card', fields: [] }] })).toThrow(
      /re-point model_card MC-31 names a field the field maps lack/,
    );
  });
});

describe('runCli (CW-00 step 2: FAIL and LIST lines, exit 1 on any FAIL)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qs-coverage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function bankStages() {
    // the CLI reads the real file format: modules with questions under stages
    return makeBank();
  }
  function setup(name: string, over: Partial<QuestionSetProposal> = {}, mapsToWrite: CoverageFieldMap[] = []) {
    const root = path.join(dir, name);
    const mapsDir = path.join(root, 'fieldmaps');
    mkdirSync(mapsDir, { recursive: true });
    const bankText = JSON.stringify(bankStages());
    writeFileSync(path.join(root, 'bank.json'), bankText);
    writeFileSync(path.join(root, 'areas.json'), JSON.stringify(makeAreas()));
    const sha = createHash('sha256').update(bankText).digest('hex');
    const p = proposal({ base: { commit: 'd13be0c', file: 'data/questionBank.json', sha256: sha }, ...over });
    writeFileSync(path.join(root, 'proposal.json'), JSON.stringify(p));
    for (const m of mapsToWrite) writeFileSync(path.join(mapsDir, `${m.documentType}.json`), JSON.stringify(m));
    return [
      '--bank', path.join(root, 'bank.json'),
      '--areas', path.join(root, 'areas.json'),
      '--proposal', path.join(root, 'proposal.json'),
      '--fieldmaps', mapsDir,
    ];
  }
  const threeMaps: CoverageFieldMap[] = [
    ...FIELD_MAPS,
    { documentType: 'mitigation_plan', fields: [{ fieldId: 'MP-01', label: 'Scope', sources: [{ kind: 'meta' }] }] },
  ];

  it('CW-00 FR-CNT-01: an all-keep proposal prints no FAIL, the pair count, and exits 0', () => {
    const r = runCli(setup('ok', {}, threeMaps));
    expect(r.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.lines).toContain('LIST pairs=9');
    expect(r.lines).toContain('LIST pairs-base=9');
    expect(r.exitCode).toBe(0);
  });

  it('CW-00 FR-CNT-01: a failing proposal prints FAIL lines and exits 1', () => {
    const r = runCli(setup('bad', { actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': cut('Q-T-05') }) }, threeMaps));
    expect(r.lines).toContain('FAIL risk area A3 is mapped from no kept question');
    expect(r.exitCode).toBe(1);
  });

  it('CW-00 NFR-MNT-05: fails when the bank file is not the input the proposal names (base.sha256)', () => {
    const argv = setup('sha', { base: { commit: 'd13be0c', file: 'data/questionBank.json', sha256: '0'.repeat(64) } }, threeMaps);
    const r = runCli(argv);
    expect(r.lines.some((l) => /^FAIL bank file sha256 [0-9a-f]{64} is not proposal base sha256 0{64}$/.test(l))).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  it('CW-00 FR-DOC-01: fails when the field-map directory lacks a map for one of the three documents', () => {
    const r = runCli(setup('nomap', {}, FIELD_MAPS));
    expect(r.lines).toContain('FAIL no field map for mitigation_plan in the --fieldmaps directory');
    expect(r.exitCode).toBe(1);
  });

  it('CW-00: an unknown argument stops the run', () => {
    expect(() => runCli(['--bogus', 'x'])).toThrow(/--bogus/);
    expect(() => runCli(['--bank', 'b'])).toThrow(/--areas/);
  });
});

// ---------------------------------------------------------------------------
// Findings of the silent-failure review of the first version: each input below
// used to give `failures=[]` or exit 0 although the proposal was defective.
// ---------------------------------------------------------------------------

describe('a defective proposal never passes quietly (CW-00 step 2: "fails loudly")', () => {
  const unknownKind = (id: string, kind: string | undefined) =>
    ({ ...(kind === undefined ? {} : { action: kind }), id, originalText: `Stem of ${id}?`, reason: 'r' }) as unknown as RevisionAction;

  it('CW-00 R-61: fails on an action kind that is not keep, reword, merge, cut or replace', () => {
    // A field reads Q-T-05; "remove" is a typo of "cut" and used to drop the question with no re-point FAIL.
    const maps: CoverageFieldMap[] = [
      { documentType: 'data_card', fields: [{ fieldId: 'DC-05', label: 'x', sources: [{ kind: 'record', questionId: 'Q-T-05' }] }] },
    ];
    for (const kind of ['remove', 'Cut', 'kept', undefined]) {
      const r = run(proposal({ actions: actions({ 'Q-T-05': unknownKind('Q-T-05', kind) }) }), { maps });
      expect(r.failures).toContainEqual(
        expect.stringContaining(`action of Q-T-05 is '${String(kind)}', not one of keep, reword, merge, cut, replace`),
      );
    }
  });

  it('CW-00 R-61: fails on a merge into a question whose action kind is unknown', () => {
    const p = proposal({
      actions: actions({ 'Q-T-01': unknownKind('Q-T-01', 'kept'), 'Q-T-02': merge('Q-T-02', 'Q-T-01') }),
      survivors: [{ id: 'Q-T-01', gaps: ['A1', 'A2'] }],
    });
    expect(run(p).failures).toContainEqual(expect.stringContaining("action of Q-T-01 is 'kept'"));
  });

  it('CW-00 R-61: the revised set and the sign-off payload stop on an unknown action kind instead of dropping the question', () => {
    const p = proposal({ actions: actions({ 'Q-T-05': unknownKind('Q-T-05', 'remove') }) });
    expect(() => reviseQuestions(makeBank(), p)).toThrow(/Q-T-05.*remove/);
    expect(() => questionSetPayload(makeBank(), p, 'in-processing')).toThrow(/Q-T-05.*remove/);
    expect(() => renderQuestionSetTables({ bank: makeBank(), proposal: p })).toThrow(/Q-T-05.*remove/);
  });

  it('CW-00 FR-DOC-01: fails on a field source of an unknown kind or a record source with no question id', () => {
    const mapOf = (source: Record<string, unknown>): CoverageFieldMap[] => [
      { documentType: 'data_card', fields: [{ fieldId: 'DC-05', label: 'x', sources: [source as never] }] },
    ];
    const cutP = proposal({ actions: actions({ 'Q-T-05': cut('Q-T-05') }) });
    expect(run(cutP, { maps: mapOf({ kind: 'record', questionID: 'Q-T-05' }) }).failures).toContainEqual(
      expect.stringMatching(/field data_card DC-05 has a record source with no questionId/),
    );
    expect(run(cutP, { maps: mapOf({ kind: 'record-option', questionId: 'Q-T-05', option: 'x' }) }).failures).toContainEqual(
      expect.stringMatching(/field data_card DC-05 has a source of kind 'record-option', which is not a field-source kind/),
    );
    expect(run(cutP, { maps: mapOf({ kind: 'record_option', questionId: 'Q-T-03' }) }).failures).toContainEqual(
      expect.stringMatching(/field data_card DC-05 has a record_option source with no option/),
    );
  });

  it('CW-00 R-61: fails on an optionGapMap that sits on a question that is not a checklist, or names an option the question lacks', () => {
    // The engine reads optionGapMap only on checklists (components/report/useFindingsData.ts:269).
    const likertSurvivor = proposal({
      actions: actions({ 'Q-T-03': merge('Q-T-03', 'Q-T-04') }),
      survivors: [{ id: 'Q-T-04', gaps: ['A3'], optionGapMap: { o1: [{ area: 'A1' }], o2: ['A2'] } }],
    });
    expect(run(likertSurvivor).failures).toContainEqual(
      expect.stringMatching(/merge survivor Q-T-04 carries an optionGapMap, but it is not a checklist/),
    );

    const wrongOption = proposal({
      actions: actions({ 'Q-T-04': merge('Q-T-04', 'Q-T-03') }),
      survivors: [{ id: 'Q-T-03', gaps: ['A3'], optionGapMap: { o1: [{ area: 'A1' }], o2: ['A2'], o9: ['A2'] } }],
    });
    expect(run(wrongOption).failures).toContainEqual(
      expect.stringMatching(/merge survivor Q-T-03 maps option 'o9', which the question does not offer/),
    );

    const newLikert = proposal({
      actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }),
      newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A3'], optionGapMap: { x: ['A3'] } }],
    });
    expect(run(newLikert).failures).toContainEqual(
      expect.stringMatching(/new question Q-T-06 carries an optionGapMap, but it is not a checklist/),
    );
    const newWrongOption = proposal({
      actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }),
      newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'checklist', text: 'New?', principle: 'p', options: ['a'], gaps: ['A3'], optionGapMap: { b: ['A3'] } }],
    });
    expect(run(newWrongOption).failures).toContainEqual(
      expect.stringMatching(/new question Q-T-06 maps option 'b', which the question does not offer/),
    );
  });

  it('CW-00 R-61: fails on a new id that is malformed or outside the replaced question\'s series', () => {
    const newQ = (id: string, stage: Stage = 'in-processing') => ({
      id, stage, moduleId: 'm-in', type: 'likert-5' as const, text: 'New?', principle: 'p', gaps: ['A3'],
    });
    const wrongSeries = proposal({ actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-IP-06') }), newQuestions: [newQ('Q-IP-06')] });
    expect(run(wrongSeries).failures).toContainEqual(
      expect.stringMatching(/new id Q-IP-06 is not in the Q-T-nn series of Q-T-05/),
    );
    const trailingSpace = proposal({ actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-05 ') }), newQuestions: [newQ('Q-T-05 ')] });
    expect(run(trailingSpace).failures).toContainEqual(expect.stringMatching(/new id 'Q-T-05 ' is not in the Q-T-nn series of Q-T-05/));
  });

  it('CW-00 R-61: fails on a reword with no text and on a new question with no text, no gaps list, an unknown module or an unknown type', () => {
    const noText = proposal({ actions: actions({ 'Q-T-01': { action: 'reword', id: 'Q-T-01', originalText: 'Stem of Q-T-01?', text: '', reason: 'r' } }) });
    expect(run(noText).failures).toContainEqual('reword of Q-T-01 has no text');

    const bad = (over: Record<string, unknown>) =>
      proposal({
        actions: actions({ 'Q-T-05': replace('Q-T-05', 'Q-T-06') }),
        newQuestions: [{ id: 'Q-T-06', stage: 'in-processing', moduleId: 'm-in', type: 'likert-5', text: 'New?', principle: 'p', gaps: ['A3'], ...over } as never],
      });
    expect(run(bad({ text: '' })).failures).toContainEqual('new question Q-T-06 has no text');
    expect(run(bad({ gaps: undefined })).failures).toContainEqual('new question Q-T-06 has no gaps list');
    expect(run(bad({ moduleId: 'm-pre' })).failures).toContainEqual('new question Q-T-06 names module m-pre, which in-processing does not have');
    expect(run(bad({ type: 'essay' })).failures).toContainEqual("new question Q-T-06 has type 'essay', which is not likert-5, checklist or gate");
  });

  it('CW-00 FR-CNT-04: fails when a kept question depends on a gate the proposal removes', () => {
    const gated = () => {
      const bank = makeBank();
      const [gate, dependent] = bank.stages['in-processing'].modules[0].questions;
      gate.type = 'gate';
      dependent.condition = { questionId: 'Q-T-04' };
      return bank;
    };
    const run2 = (p: QuestionSetProposal, bank = gated()) =>
      checkCoverage({ bank, areas: makeAreas(), proposal: p, maps: [] }).failures;

    expect(run2(proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04') }) }))).toContainEqual(
      'question Q-T-05 depends on gate Q-T-04, which the proposal removes',
    );
    expect(run2(proposal())).toEqual([]);

    // a condition on an ordinary question is an unlock rule 5.0.0 removes (SRS line 3916): not a failure
    const ordinary = makeBank();
    ordinary.stages['in-processing'].modules[0].questions[1].condition = { questionId: 'Q-T-04' };
    expect(run2(proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04') }) }), ordinary)).not.toContainEqual(
      expect.stringMatching(/depends on gate/),
    );
  });

  it('CW-00: scanSrsIds names the sections it found, so a wrong file is told from a clean result', () => {
    expect(scanSrsSections('## 3. A\n## 4. B\n### 4.1 sub\n## 7. C\n## 12. D\n## 13. E')).toEqual([3, 4, 7, 12]);
    expect(scanSrsSections('# Plan\n## 1. Intro\n## 2. Scope')).toEqual([]);
  });

  describe('the command line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qs-coverage-cli-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const root = path.resolve(__dirname, '../..');
    const tsx = path.join(root, 'node_modules/.bin/tsx');

    it('CW-00: both commands run when started through a symlinked path (they used to print nothing and exit 0)', () => {
      const linked = path.join(dir, 'linked');
      symlinkSync(path.join(root, 'scripts/content'), linked);
      for (const file of ['question-set-coverage.ts', 'render-tables.ts']) {
        const r = spawnSync(tsx, [path.join(linked, file)], { encoding: 'utf8', cwd: root });
        expect(r.status, `${file}: ${r.stdout}${r.stderr}`).toBe(1);
        expect(r.stderr).toMatch(/missing --bank|usage: render-tables\.ts/);
      }
    });

    it('CW-00: a repeated flag, or an SRS file without the four scanned sections, stops or fails the run', () => {
      expect(() => runCli(['--bank', 'a', '--bank', 'b'])).toThrow(/--bank given twice/);

      const root2 = path.join(dir, 'srs');
      mkdirSync(path.join(root2, 'fieldmaps'), { recursive: true });
      const bankText = JSON.stringify(makeBank());
      writeFileSync(path.join(root2, 'bank.json'), bankText);
      writeFileSync(path.join(root2, 'areas.json'), JSON.stringify(makeAreas()));
      writeFileSync(path.join(root2, 'proposal.json'), JSON.stringify(proposal({ base: { commit: 'd13be0c', file: 'data/questionBank.json', sha256: createHash('sha256').update(bankText).digest('hex') } })));
      for (const type of ['data_card', 'model_card', 'mitigation_plan']) {
        writeFileSync(path.join(root2, 'fieldmaps', `${type}.json`), JSON.stringify({ documentType: type, fields: [] }));
      }
      writeFileSync(path.join(root2, 'wrong.md'), '# Plan\n## 1. Intro\n');
      writeFileSync(path.join(root2, 'srs.md'), '## 3. A\n## 4. B\n## 7. C\n## 12. D\n');
      const argv = (srs: string) => ['--bank', path.join(root2, 'bank.json'), '--areas', path.join(root2, 'areas.json'), '--proposal', path.join(root2, 'proposal.json'), '--fieldmaps', path.join(root2, 'fieldmaps'), '--srs', path.join(root2, srs)];

      const wrong = runCli(argv('wrong.md'));
      expect(wrong.lines).toContain('FAIL --srs file lacks the section headings ## 3., ## 4., ## 7. and ## 12.: it has none of them');
      expect(wrong.exitCode).toBe(1);
      const right = runCli(argv('srs.md'));
      expect(right.lines).toContain('LIST srs-scanned sections=3,4,7,12 ids=0');
      expect(right.exitCode).toBe(0);
    });
  });
});

describe('render-tables refuses what it cannot render honestly (FR-CNT-02)', () => {
  it('SRS 10.1.0 step 3: a disputed item reaches the stage of its question, a new id its new stage, a decision every stage', () => {
    const p = proposal({
      actions: actions({ 'Q-T-02': replace('Q-T-02', 'Q-T-06') }),
      newQuestions: [{ id: 'Q-T-06', stage: 'pre-processing', moduleId: 'm-pre', type: 'likert-5', text: 'Replacement?', principle: 'p', gaps: ['A2'] }],
      disputed: [
        { id: 'Q-T-06', proposer: 'keep the new id', checker: 'reject' },
        { id: 'Q-T-05', proposer: 'keep', checker: 'cut' },
        { id: 'OD-08', proposer: 'show', checker: 'hide' },
      ],
    });
    const t = renderQuestionSetTables({ bank: makeBank(), proposal: p });
    expect(t['pre-processing']).toContain('| Q-T-06 | keep the new id | reject |');
    expect(t['pre-processing']).not.toContain('| Q-T-05 |  keep');
    expect(t['in-processing']).toContain('| Q-T-05 | keep | cut |');
    for (const stage of ['pre-processing', 'in-processing', 'post-processing'] as const) {
      expect(t[stage]).toContain('| OD-08 | show | hide |');
    }
    const lastLine = (s: string) => s.trimEnd().split('\n').pop() as string;
    expect(lastLine(t['pre-processing'])).toContain('Batch hash');

    const stray = proposal({ disputed: [{ id: 'Q-X-99', proposer: 'a', checker: 'b' }] });
    expect(() => renderQuestionSetTables({ bank: makeBank(), proposal: stray })).toThrow(/disputed item Q-X-99/);
  });

  it('CW-00: it stops on a duplicated action, and on a proposal the coverage check fails when the areas are given', () => {
    const twice = proposal({ actions: [...actions(), cut('Q-T-05')] });
    expect(() => renderQuestionSetTables({ bank: makeBank(), proposal: twice })).toThrow(/Q-T-05 has more than one action/);
    expect(() => questionSetPayload(makeBank(), twice, 'in-processing')).toThrow(/Q-T-05 has more than one action/);

    const failing = proposal({ actions: actions({ 'Q-T-04': cut('Q-T-04'), 'Q-T-05': cut('Q-T-05') }) });
    expect(() => renderQuestionSetTables({ bank: makeBank(), proposal: failing, areas: makeAreas(), maps: [] })).toThrow(
      /risk area A3 is mapped from no kept question/,
    );
    expect(renderQuestionSetTables({ bank: makeBank(), proposal: proposal(), areas: makeAreas(), maps: [] })['pre-processing']).toContain(
      'Batch hash',
    );
  });
});
