import { describe, it, expect } from 'vitest';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { draftErrors, draftFromCurrent, draftKeyFor, EMPTY_DATE, fillToday, isDraftValue, isStamped, keptDeciderIsOther, patchDraft, restoreDraft, stampDraft, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import { openDraftStore, type DraftStore, type StoredDraft } from '@/lib/client/drafts';
// The old builds' own code, as `git show` gives it (only the store's one relative import made absolute): v0.9.0 (b4a6cf2b), v0.11.0
// (d14d8859, whose lib/client/drafts.ts is unchanged since v0.9.0), and a100eb63, the head before this change.
import * as v090 from '../fixtures/old-drafts/draft-v0.9.0';
import * as v011 from '../fixtures/old-drafts/draft-v0.11.0';
import * as a100 from '../fixtures/old-drafts/draft-a100eb63';
import { openDraftStore as openOldStore } from '../fixtures/old-drafts/drafts-store-v0.11.0';

/**
 * Answer cost, Task 3 (design 2026-11-22 section 2 item 1 and section 8 "Browser drafts and the defaults"): the answer
 * form opens with "Decided by" and "Decided on" filled in, and a browser draft keeps who and when only when the person
 * changed them in it.
 */
const T = { day: '22', month: '11', year: '2026' };
const VIEWER = 'u-me';
const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Q', principle: 'Proportionality', gaps: [], expectedPractice: 'g', whyAsked: 'y',
  reasonPrompt: 'z', evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'M', order: 0,
} as LoadedQuestion;
const BY_MEMBER: DecisionVersionView = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'partly', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Theirs', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: 'u-m', name: 'Dr Okello', formerMember: false } } as never, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
const PANEL: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: QUESTION, runningQuestion: QUESTION,
  position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' }, current: null, historyCount: 0, seals: [],
  reasonCodes: [], members: [{ userId: 'u-m', name: 'Dr Okello' }], viewer: { userId: VIEWER, name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const withdrawn = { ...PANEL, current: { ...BY_MEMBER, status: 'withdrawn' as const, withdrawalCode: 'duplicate' as const, decidedBy: null, declaredDate: null } };
const changeOf = { ...PANEL, current: BY_MEMBER };
const viewer = { kind: 'member', userId: VIEWER };

describe('answer cost 3: the answer form opens with who and when filled in', () => {
  it('a first answer defaults decidedBy to the viewer and date to today', () => {
    expect(draftFromCurrent(PANEL, T)).toMatchObject({ decidedBy: viewer, date: T, whoWhenChanged: false });
  });

  it('after a withdrawal the same', () => {
    expect(draftFromCurrent(withdrawn, T)).toMatchObject({ status: null, decidedBy: viewer, date: T, whoWhenChanged: false });
  });

  it('a change keeps the current decider', () => {
    const d = draftFromCurrent(changeOf, T);
    expect(d.decidedBy).toEqual({ kind: 'member', userId: 'u-m' });
    expect(d).toMatchObject({ whoWhenChanged: false, status: 'partly', reason: 'Theirs' });
  });

  it('a change whose version has no decider falls back to the viewer', () => {
    expect(draftFromCurrent({ ...PANEL, current: { ...BY_MEMBER, decidedBy: null } }, T).decidedBy).toEqual(viewer);
  });

  it('a server render (today null) leaves the date empty, for every case', () => {
    for (const p of [PANEL, withdrawn, changeOf]) expect(draftFromCurrent(p, null).date).toEqual(EMPTY_DATE);
  });

  it('the date is a copy, so editing it never changes today or EMPTY_DATE', () => {
    const a = draftFromCurrent(PANEL, T);
    expect(a.date).not.toBe(T);
    expect(draftFromCurrent(PANEL, null).date).not.toBe(EMPTY_DATE);
  });
});

/**
 * D-425 (DEFERRED_REGISTER; owner, 23 Nov 2026, "Open, date empty"): on a change whose kept decider is not the viewer,
 * "Decided on" opens empty, as in v0.9.0, so one press of Save cannot record that person deciding today.
 */
describe('D-425: a change of someone else\'s decision opens with the date empty', () => {
  const byViewer = { ...PANEL, current: { ...BY_MEMBER, decidedBy: { kind: 'member', user: { userId: VIEWER, name: 'Amina N.', formerMember: false } } as never } };
  const byFormer = { ...PANEL, current: { ...BY_MEMBER, decidedBy: { kind: 'member', user: { userId: 'u-gone', name: 'Alice', formerMember: true } } as never } };
  const byRole = { ...PANEL, current: { ...BY_MEMBER, decidedBy: { kind: 'outside_role', role: 'principal_investigator' } as never } };

  it('another member\'s decision: the date is empty although today is known', () => {
    expect(draftFromCurrent(changeOf, T).date).toEqual(EMPTY_DATE);
    expect(keptDeciderIsOther(changeOf)).toBe(true);
  });

  it('a former member\'s decision: the same', () => {
    expect(draftFromCurrent(byFormer, T)).toMatchObject({ decidedBy: { kind: 'member', userId: 'u-gone' }, date: EMPTY_DATE });
    expect(keptDeciderIsOther(byFormer)).toBe(true);
  });

  it('an outside role\'s decision: the same', () => {
    expect(draftFromCurrent(byRole, T)).toMatchObject({ decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, date: EMPTY_DATE });
    expect(keptDeciderIsOther(byRole)).toBe(true);
  });

  it('the viewer\'s own decision keeps today ("Prefill today")', () => {
    expect(draftFromCurrent(byViewer, T).date).toEqual(T);
    expect(keptDeciderIsOther(byViewer)).toBe(false);
  });

  it('a version with no decider falls back to the viewer and keeps today', () => {
    const none = { ...PANEL, current: { ...BY_MEMBER, decidedBy: null } };
    expect(draftFromCurrent(none, T).date).toEqual(T);
    expect(keptDeciderIsOther(none)).toBe(false);
  });

  it('a first answer and a withdrawal are not changes of someone else\'s decision', () => {
    expect(keptDeciderIsOther(PANEL)).toBe(false);
    expect(keptDeciderIsOther(withdrawn)).toBe(false);
  });

  it('the form\'s mount fill of today (fillToday) leaves the date empty on someone else\'s decision, and fills it otherwise', () => {
    expect(fillToday(draftFromCurrent(byFormer, null), byFormer, T).date).toEqual(EMPTY_DATE);
    expect(fillToday(draftFromCurrent(byRole, null), byRole, T).date).toEqual(EMPTY_DATE);
    expect(fillToday(draftFromCurrent(byViewer, null), byViewer, T).date).toEqual(T);
    expect(fillToday(draftFromCurrent(PANEL, null), PANEL, T).date).toEqual(T);
    // a date the person set is theirs, whoever decided
    const own = { ...draftFromCurrent(PANEL, null), date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: true, dateChanged: true };
    expect(fillToday(own, PANEL, T).date).toEqual(own.date);
  });

  it('one press of Save on the opened draft is refused on the date, so it cannot record the earlier decider deciding today', () => {
    const d = { ...draftFromCurrent(byFormer, T), status: 'done' as const };
    expect(draftErrors(d, byFormer, new Date('2026-11-22T12:00:00Z')).map((e) => e.field)).toContain('declaredDate');
  });
});

describe('answer cost 3: a stored draft keeps who and when only if the person changed them', () => {
  const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: 'Typed.', decidedBy: null,
    date: { day: '', month: '', year: '' }, evidenceIds: ['e1'], notUploaded: ['a.pdf'], href: '/old/href', ...over,
  });

  it('restoreDraft of a v0.9.0 draft (decidedBy null, empty date, no whoWhenChanged) applies the defaults and keeps its status and reason', () => {
    const r = restoreDraft(stored(), PANEL, T, false)!;
    expect(r).toMatchObject({
      status: 'done', reason: 'Typed.', evidenceIds: ['e1'], notUploaded: ['a.pdf'],
      decidedBy: viewer, date: T, whoWhenChanged: false, href: '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01',
    });
  });

  it('restoreDraft with whoWhenChanged true keeps the stored decider and date, even a date from an earlier day', () => {
    const own = { decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: true };
    expect(restoreDraft(stored(own), PANEL, T, false)).toMatchObject(own);
  });

  it('restoreDraft with whoWhenChanged false uses the defaults, so the date is today and the stored decider is not trusted', () => {
    const old = { decidedBy: { kind: 'member', userId: 'u-other' }, date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: false };
    expect(restoreDraft(stored(old), PANEL, T, false)).toMatchObject({ decidedBy: viewer, date: T, whoWhenChanged: false });
    // D-425: the kept decider is not the viewer, so the date opens empty there too.
    expect(restoreDraft(stored(old), changeOf, T, false)).toMatchObject({ decidedBy: { kind: 'member', userId: 'u-m' }, date: EMPTY_DATE });
  });

  it('a flagless (v0.9.0) draft with a typed date keeps its date and decider, and counts as changed', () => {
    const own = { decidedBy: { kind: 'member', userId: 'u-other' }, date: { day: '3', month: '11', year: '2026' } };
    expect(restoreDraft(stored(own), PANEL, T, false)).toMatchObject({ ...own, whoWhenChanged: true });
    expect(restoreDraft(stored(own), PANEL, null, false)).toMatchObject({ ...own, whoWhenChanged: true });
  });

  it('a flagless draft with a typed date and no decider keeps the date and takes the default decider, never an empty one', () => {
    const date = { day: '3', month: '11', year: '2026' };
    expect(restoreDraft(stored({ decidedBy: null, date }), PANEL, T, false)).toMatchObject({ decidedBy: viewer, date, whoWhenChanged: true });
    expect(restoreDraft(stored({ decidedBy: null, date }), changeOf, T, false)).toMatchObject({ decidedBy: { kind: 'member', userId: 'u-m' }, date, whoWhenChanged: true });
  });

  it('a flagless draft with a decider but an empty date takes the defaults for both', () => {
    expect(restoreDraft(stored({ decidedBy: { kind: 'member', userId: 'u-other' } }), PANEL, T, false)).toMatchObject({ decidedBy: viewer, date: T, whoWhenChanged: false });
  });

  it('a flagged draft with whoWhenChanged false and a typed date still gets the defaults', () => {
    expect(restoreDraft(stored({ date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: false }), PANEL, T, false)).toMatchObject({ date: T, whoWhenChanged: false });
  });

  it('restoreDraft on a server render (today null) gives an empty date unless the person changed it', () => {
    expect(restoreDraft(stored(), PANEL, null, false)!.date).toEqual(EMPTY_DATE);
  });

  it('restoreDraft returns null for a value isDraftValue rejects', () => {
    for (const bad of [null, 'x', 7, [], {}, stored({ reason: 5 }), stored({ date: null }), stored({ whoWhenChanged: 'yes' })]) {
      expect(isDraftValue(bad)).toBe(false);
      expect(restoreDraft(bad, PANEL, T, false)).toBeNull();
    }
  });

  it('isDraftValue ignores a hand-edited decider, status or scope answer the form could never have written', () => {
    const bad = [
      { decidedBy: {} }, { decidedBy: [] }, { decidedBy: { kind: 'member' } }, { decidedBy: { kind: 'member', userId: '' } },
      { decidedBy: { kind: 'outside_role', role: 'astronaut' } }, { decidedBy: { kind: 'admin', userId: 'u-x' } },
      { status: 'withdrawn' }, { status: 'yes' }, { scopeAnswer: 'maybe' },
    ];
    for (const over of bad) {
      expect(isDraftValue(stored(over))).toBe(false);
      expect(restoreDraft(stored({ ...over, whoWhenChanged: true, date: { day: '3', month: '11', year: '2026' } }), PANEL, T, false)).toBeNull();
    }
    const good = [
      { decidedBy: null }, { decidedBy: { kind: 'member', userId: 'u-other' } }, { decidedBy: { kind: 'outside_role', role: 'principal_investigator' } },
      { status: null }, { status: 'not_applicable' }, { scopeAnswer: 'not_sure' },
    ];
    for (const over of good) expect(isDraftValue(stored(over))).toBe(true);
  });

  it('isDraftValue accepts a draft without whoWhenChanged and one with a boolean', () => {
    expect(isDraftValue(stored())).toBe(true);
    expect(isDraftValue(stored({ whoWhenChanged: true }))).toBe(true);
  });
});

describe('answer cost 3: the new field never leaves the browser', () => {
  it('toSaveBody does not carry whoWhenChanged', () => {
    const d = { ...draftFromCurrent(PANEL, T), status: 'done' as const };
    expect(Object.keys(toSaveBody(d, PANEL, null))).not.toContain('whoWhenChanged');
  });
});

describe('answer cost 3: patchDraft records that the person changed who or when', () => {
  const base = draftFromCurrent(PANEL, T);

  it('a decidedBy patch sets whoWhenChanged', () => {
    expect(patchDraft(base, { decidedBy: { kind: 'outside_role', role: 'principal_investigator' } })).toMatchObject({ decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, whoWhenChanged: true });
  });

  it('a date patch sets whoWhenChanged', () => {
    const date = { day: '1', month: '2', year: '2026' };
    expect(patchDraft(base, { date })).toMatchObject({ date, whoWhenChanged: true });
  });

  it('a status, reason or reasonCode patch leaves the flag as it was, in both states', () => {
    for (const flag of [false, true]) {
      const d = { ...base, whoWhenChanged: flag };
      expect(patchDraft(d, { status: 'done' }).whoWhenChanged).toBe(flag);
      expect(patchDraft(d, { reason: 'x' }).whoWhenChanged).toBe(flag);
      expect(patchDraft(d, { reasonCode: 'na_other' }).whoWhenChanged).toBe(flag);
    }
  });

  it('keeps the other fields and does not change its input', () => {
    const out = patchDraft(base, { reason: 'x' });
    expect(out).toEqual({ ...base, reason: 'x' });
    expect(base.reason).toBe('');
  });
});

/**
 * Design 2026-11-22 section 8, "A defaulted date in a draft from an earlier day becomes today", over whole stored records: the new
 * build's writes go through `stampDraft`, its restore is told whether the record it read carries that stamp, and the old builds
 * read and write through their own code (fixtures above). Old builds rebuild the outer record from scratch on every write, with
 * exactly the five fields below (components/decision/DecisionForm.tsx `keep({...})` calls at v0.9.0 and v0.11.0), so the stamp
 * says the last write was a new build's.
 */
describe('answer cost 3: a defaulted date never outlives its day, and a typed one is never replaced, across old and new builds', () => {
  const DAY1 = { day: '20', month: '11', year: '2026' };
  const DAY2 = { day: '21', month: '11', year: '2026' };
  const T2 = { day: '23', month: '11', year: '2026' };
  const PI = { kind: 'outside_role' as const, role: 'principal_investigator' as const };
  const NO_RETRY = { requestId: null, sentBody: null };
  const KEY = draftKeyFor(PANEL);
  const NOW = new Date('2026-11-22T09:00:00Z');

  /** A localStorage both builds share, as one browser profile does. */
  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
    };
  }
  const envelope = <V,>(value: V): StoredDraft<V> => ({ baseVersionNumber: null, value, savedAt: NOW.toISOString(), savePressedAt: null, retry: NO_RETRY });
  /** The new build: every write is stamped; a restore reads the stamp's presence from the record. */
  const newKeep = (s: DraftStore, v: DecisionDraft) => expect(s.write(KEY, stampDraft(envelope(v)))).toBe(true);
  const newRestore = (s: DraftStore, today: typeof T) => {
    const found = s.read<unknown>(KEY, NOW)!;
    return restoreDraft(found.value, PANEL, today, isStamped(found))!;
  };
  /** An old build's write: `keep({ baseVersionNumber, value, savedAt, savePressedAt, retry })`, the outer record built anew. */
  const oldKeep = (s: ReturnType<typeof openOldStore>, v: unknown) => expect(s!.write(KEY, envelope(v))).toBe(true);
  /** v0.9.0's restore (DecisionForm.tsx:357-358 at v0.9.0) and its only edit path (DecisionFields.tsx:61): spreads, whole. */
  const v090Restore = (found: unknown) => (v090.isDraftValue(found) ? { ...found, href: 'h' } : null);
  const v090Set = <V extends object>(value: V, patch: object): V => ({ ...value, ...patch });
  const stores = () => { const m = memoryStorage(); return { m, next: openDraftStore(m)!, old: openOldStore(m)! }; };
  /** The new build restores on T, writes the draft back (stamped), and restores again on T2: what a typed date must survive. */
  const twoNewRestores = (s: DraftStore) => {
    const first = newRestore(s, T);
    newKeep(s, first);
    return [first, newRestore(s, T2)] as const;
  };

  describe('the new build alone', () => {
    it('F1: a draft whose person changed only "Decided by" on an earlier day restores with today\'s date and that decider', () => {
      const { next } = stores();
      newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
      expect(newRestore(next, T)).toMatchObject({ decidedBy: PI, date: T });
    });

    it('two restores in a row: each takes its own day', () => {
      const { next } = stores();
      newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
      newKeep(next, { ...newRestore(next, T), reason: 'Later.' });
      expect(newRestore(next, T2)).toMatchObject({ decidedBy: PI, date: T2, reason: 'Later.' });
    });

    it('D-425: on a change of someone else\'s decision the restored date is empty, not the earlier day', () => {
      const { next } = stores();
      newKeep(next, patchDraft(draftFromCurrent(changeOf, DAY1), { decidedBy: PI }));
      const found = next.read<unknown>(KEY, NOW)!;
      expect(restoreDraft(found.value, changeOf, T, isStamped(found))).toMatchObject({ decidedBy: PI, date: EMPTY_DATE });
    });

    it('decider then date, and date then decider: both kept', () => {
      const typed = { day: '3', month: '11', year: '2026' };
      for (const order of [[{ decidedBy: PI }, { date: typed }], [{ date: typed }, { decidedBy: PI }]] as const) {
        const { next } = stores();
        newKeep(next, patchDraft(patchDraft(draftFromCurrent(PANEL, DAY1), order[0]), order[1]));
        expect(newRestore(next, T)).toMatchObject({ decidedBy: PI, date: typed });
      }
    });

    it('fillToday fills a date that is still the default, also after a "Decided by" change, and never a changed one', () => {
      const whoOnly = patchDraft(draftFromCurrent(PANEL, null), { decidedBy: PI });
      expect(fillToday(whoOnly, PANEL, T).date).toEqual(T);
      const typed = patchDraft(draftFromCurrent(PANEL, null), { date: { day: '3', month: '11', year: '2026' } });
      expect(fillToday(typed, PANEL, T).date).toEqual({ day: '3', month: '11', year: '2026' });
    });
  });

  describe('old and new builds on one stored draft', () => {
    it('an old build reads a stamped record without dropping it (v0.9.0 and v0.11.0 guards, store and value)', () => {
      const { next, old } = stores();
      newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
      const found = old.read<unknown>(KEY, NOW);
      expect(found).not.toBeNull();
      expect(v090Restore(found!.value)).not.toBeNull();
      expect(v011.restoreDraft(found!.value, PANEL, T)).not.toBeNull();
    });

    it('P1: a v0.9.0 tab re-enters the date it shows on an unchanged new draft; the new build keeps that date', () => {
      const { next, old } = stores();
      newKeep(next, draftFromCurrent(PANEL, DAY1));
      const shown = v090Restore(old.read<unknown>(KEY, NOW)!.value) as DecisionDraft;
      oldKeep(old, v090Set(shown, { date: { ...shown.date, day: '20' } }));
      for (const r of twoNewRestores(next)) expect(r.date).toEqual(DAY1);
    });

    it('P2: after a new "Decided by" change, a v0.11.0 tab re-enters the same date, or presses Today that day; the new build keeps it', () => {
      for (const date of [{ ...DAY1 }, { day: '20', month: '11', year: '2026' }]) {
        const { next, old } = stores();
        newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
        const shown = v011.restoreDraft(old.read<unknown>(KEY, NOW)!.value, PANEL, DAY1)!;
        oldKeep(old, v011.patchDraft(shown, { date }));
        for (const r of twoNewRestores(next)) expect(r).toMatchObject({ decidedBy: PI, date: DAY1 });
      }
    });

    it('P4: a v0.9.0 tab types another date into an unchanged new draft; the new build keeps it', () => {
      const { next, old } = stores();
      newKeep(next, draftFromCurrent(PANEL, DAY1));
      const shown = v090Restore(old.read<unknown>(KEY, NOW)!.value) as DecisionDraft;
      oldKeep(old, v090Set(shown, { date: { day: '3', month: '11', year: '2026' } }));
      for (const r of twoNewRestores(next)) expect(r.date).toEqual({ day: '3', month: '11', year: '2026' });
    });

    it('an old tab that only reads leaves the record stamped, so the new build still takes today', () => {
      const { next, old } = stores();
      newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
      v011.restoreDraft(old.read<unknown>(KEY, NOW)!.value, PANEL, DAY2);
      v090Restore(old.read<unknown>(KEY, NOW)!.value);
      expect(newRestore(next, T)).toMatchObject({ decidedBy: PI, date: T });
    });

    it('an old tab that edits only the reason: nothing worse than the old defect (the date it held is kept), and the reason and decider survive', () => {
      const { next, old } = stores();
      newKeep(next, patchDraft(draftFromCurrent(PANEL, DAY1), { decidedBy: PI }));
      const shown = v011.restoreDraft(old.read<unknown>(KEY, NOW)!.value, PANEL, DAY2)!;
      oldKeep(old, v011.patchDraft(shown, { reason: 'From the old tab.' }));
      for (const r of twoNewRestores(next)) expect(r).toMatchObject({ decidedBy: PI, date: shown.date, reason: 'From the old tab.' });
    });

    it('drafts stored by v0.9.0 to v0.11.0 (no stamp, no record of a date change) restore exactly as at a100eb63', () => {
      const legacy: Record<string, unknown>[] = [
        { decidedBy: null, date: { day: '', month: '', year: '' } },
        { decidedBy: PI, date: { day: '3', month: '11', year: '2026' } },
        { decidedBy: PI, date: { day: '', month: '', year: '' } },
        { decidedBy: PI, date: DAY1, whoWhenChanged: true },
        { decidedBy: PI, date: DAY1, whoWhenChanged: false },
        { decidedBy: null, date: { day: '5', month: '', year: '' }, whoWhenChanged: true },
      ].map((over) => ({ status: 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: 'Typed.', evidenceIds: [], notUploaded: [], href: '/old', ...over }));
      for (const v of legacy) {
        for (const [data, today] of [[PANEL, T], [changeOf, T], [PANEL, null]] as const) {
          const { next, old } = stores();
          oldKeep(old, v);
          const found = next.read<unknown>(KEY, NOW)!;
          const now = restoreDraft(found.value, data, today, isStamped(found))!;
          const then = a100.restoreDraft(found.value, data, today)!;
          const { dateChanged, ...rest } = now;
          expect(rest).toEqual(then);
          expect(dateChanged).toBe(then.whoWhenChanged);
        }
      }
    });
  });
});
