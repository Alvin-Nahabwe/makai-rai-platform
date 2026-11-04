import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDraftStore } from '@/lib/client/drafts';
import { AcceptedSaved, AcceptedSentence } from '@/components/findings/AcceptRiskForm';
import { FailureText } from '@/components/findings/FindingActions';
import { MitigationConflictView, MitigationStatusWord, NotAttached } from '@/components/findings/MitigationForm';
import {
  conflictAction, emptyMitigationValue, isNewerVersion, mitigationDraftKey, mitigationDraftTarget, restoreMitigationDraft, shouldWriteDraft, writeMitigationDraft,
} from '@/lib/findings/formRules';
import type { MitigationVersionView } from '@/types/api';

/**
 * UX-26 (draft read-back), 7.4.4 (the conflict view) and obligation B6. vitest runs in `node` with no jsdom (an install is a
 * download), so the effects of MitigationForm are tested as the pure functions they call (`restoreMitigationDraft`,
 * `shouldWriteDraft`, `conflictAction`) over the real draft store on an in-memory Storage, and the view as static markup.
 */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
const K = { userId: 'u1', orgId: 'o1', projectId: 'p1', findingId: 'f1', mitigationId: 'm1' };
const V = (n: number, o: Partial<MitigationVersionView> = {}) => ({
  id: `mv${n}`, mitigationId: 'm1', findingId: 'f1', versionNumber: n, what: 'Relabel the class', dueDate: '2026-11-10', status: 'planned',
  owner: { userId: 'u-joseph', name: 'Joseph K.', formerMember: false }, enteredBy: { userId: 'u-grace', name: 'Grace A.', formerMember: false },
  followsControl: null, closureNote: null, cancelReason: null, evidence: [], receivedAt: '2026-11-02T08:00:00.000Z', changeNote: null, ...o,
}) as unknown as MitigationVersionView;
const NOW = new Date('2026-11-03T08:00:00.000Z');
const MINE = { ...emptyMitigationValue(null), what: 'My wording', due: { day: '20', month: '11', year: '2026' } };

describe('draft read-back and the conflict (UX-26, 7.4.4)', () => {
  const stored = () => {
    const store = openDraftStore(new MemoryStorage())!;
    const key = mitigationDraftTarget({ ...K, mitigationId: 'm1' });
    store.write(key, { baseVersionNumber: 1, value: MINE, savedAt: NOW.toISOString(), savePressedAt: null, retry: { requestId: 'r1', sentBody: 'b' } });
    return { store, key };
  };

  it('UX-26: a draft started from version 1, read when the current version is 2, comes back with the conflict and its request id', () => {
    const { store, key } = stored();
    const r = restoreMitigationDraft(store, key, NOW, V(2));
    expect(r).toMatchObject({ kind: 'restored', conflict: { versionNumber: 2 }, retry: { requestId: 'r1' } });
    expect(r.kind === 'restored' && r.value.what).toBe('My wording');
  });

  it('UX-26 (M-1): the form\'s own write is skipped while a conflict is pending, and goes through without one, so the check can fail', () => {
    const { store, key } = stored();
    const state = { restored: true, dirty: true, value: MINE, upload: { uploading: [], failed: [] }, savePressedAt: null, retry: { requestId: null, sentBody: null }, now: NOW };
    expect(writeMitigationDraft(store, key, { ...state, base: V(2), conflict: V(2) })).toBeNull();
    expect(store.read(key, NOW)?.baseVersionNumber).toBe(1);
    expect(writeMitigationDraft(store, key, { ...state, base: V(2), conflict: null })).toBe(true);
    expect(store.read(key, NOW)?.baseVersionNumber).toBe(2);
    expect(writeMitigationDraft(store, key, { ...state, dirty: false, base: V(3), conflict: null })).toBeNull();
  });

  it('UX-26 (SFH-1): while a conflict is pending the draft is not written, so it keeps its own base and a remount shows the conflict again', () => {
    const { store, key } = stored();
    const first = restoreMitigationDraft(store, key, NOW, V(2));
    // The effects after mount: restored, dirty, and the conflict pending.
    const write = shouldWriteDraft({ restored: true, dirty: true, hasStore: true, conflictPending: first.kind === 'restored' && first.conflict !== null });
    expect(write).toBe(false);
    expect(store.read(key, NOW)?.baseVersionNumber).toBe(1);
    expect(restoreMitigationDraft(store, key, NOW, V(2))).toMatchObject({ kind: 'restored', conflict: { versionNumber: 2 } });
  });

  it('UX-26: no conflict, no draft, and a draft of another shape are each told apart', () => {
    const { store, key } = stored();
    expect(restoreMitigationDraft(store, key, NOW, V(1))).toMatchObject({ kind: 'restored', conflict: null });
    expect(restoreMitigationDraft(store, mitigationDraftTarget({ ...K, mitigationId: null }), NOW, null)).toEqual({ kind: 'none' });
    store.write(key, { baseVersionNumber: 1, value: { what: 3 } as never, savedAt: NOW.toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
    expect(restoreMitigationDraft(store, key, NOW, V(1))).toEqual({ kind: 'dropped' });
    expect(store.read(key, NOW)).toBeNull();
  });

  it('UX-26: a write needs a store, a restored form and edits, and waits while a conflict is pending', () => {
    const ok = { restored: true, dirty: true, hasStore: true, conflictPending: false };
    expect(shouldWriteDraft(ok)).toBe(true);
    for (const off of ['restored', 'dirty', 'hasStore'] as const) expect(shouldWriteDraft({ ...ok, [off]: false }), off).toBe(false);
    expect(shouldWriteDraft({ ...ok, conflictPending: true })).toBe(false);
  });

  it('7.4.4: each of the three actions moves to the newer version, and only Discard drops the draft and takes the newer wording', () => {
    const newer = V(3, { what: 'Their wording' });
    expect(conflictAction('save_mine', newer, MINE)).toMatchObject({ base: newer, keepDraft: true, send: true });
    expect(conflictAction('edit_first', newer, MINE)).toMatchObject({ base: newer, keepDraft: true, send: false });
    expect(conflictAction('edit_first', newer, MINE).value.what).toBe('My wording');
    const d = conflictAction('discard', newer, MINE);
    expect(d).toMatchObject({ base: newer, keepDraft: false, send: false });
    expect(d.value.what).toBe('Their wording');
  });

  it('7.4.4 / 7.5.8 (CR-3): the conflict view names the three actions, who saved the newer version, and writes dates as "10 Nov 2026"', () => {
    const html = renderToStaticMarkup(<MitigationConflictView newer={V(3)} mine={MINE} userId="u1" busy={false} alert={null} status={null}
      onSaveMine={() => {}} onEditFirst={() => {}} onDiscard={() => {}} />);
    for (const b of ['Save mine as version 4', 'Edit mine first', 'Discard mine']) expect(html).toMatch(new RegExp(`<button[^>]*>${b}</button>`));
    expect(html).toContain('Version 3 was saved by <bdi>Grace A.</bdi>');
    expect(html).toContain('Review it, then save yours as version 4 or discard it.');
    expect(html).toContain('10 Nov 2026'); expect(html).toContain('20 Nov 2026'); expect(html).not.toContain('2026-11-10');
  });

  it('7.4.4 (CR-3): the same account reads the earlier-attempt text, and a version with no wording leaves the clause out', () => {
    const html = renderToStaticMarkup(<MitigationConflictView newer={V(3, { what: null, enteredBy: { userId: 'u1', name: 'Me', formerMember: false } })} mine={MINE}
      userId="u1" busy={false} alert={null} status={null} onSaveMine={() => {}} onEditFirst={() => {}} onDiscard={() => {}} />);
    expect(html).toContain('saved by you');
    expect(html).toContain('probably by an earlier attempt from this device or another device');
    expect(html).not.toContain('The newer version: <bdi></bdi>');
  });

  it('CR-5: a conflict body that is not a mitigation version is refused before the view reads it', () => {
    expect(isNewerVersion(V(3))).toBe(true);
    for (const bad of [undefined, null, {}, { versionNumber: 3 }, { versionNumber: '3', enteredBy: { userId: 'u' }, dueDate: '2026-11-10' }]) expect(isNewerVersion(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('names in sentences (SFH-3, I-2, M-4)', () => {
  it('NFR-SEC-11 (I-2): the conflict view\'s closed-by alert puts the closer\'s name inside <bdi>', () => {
    const name = 'Ev\u202Eil';
    const html = renderToStaticMarkup(<MitigationConflictView newer={V(3)} mine={MINE} userId="u1" busy={false} status={null}
      alert={{ text: `This finding was closed by ${name} at 10:42 EAT.`, name }} onSaveMine={() => {}} onEditFirst={() => {}} onDiscard={() => {}} />);
    expect(html).toContain(`This finding was closed by <bdi>${name}</bdi> at 10:42 EAT.`);
  });

  it('NFR-SEC-11 (M-4): the accepter in the two acceptance sentences sits inside <bdi>', () => {
    const name = 'Ev\u202Eil';
    const names = new Map([['u-x', name]]);
    expect(renderToStaticMarkup(<AcceptedSentence choice={{ kind: 'member', userId: 'u-x' }} names={names} />))
      .toBe(`The finding will show as &quot;Closed: risk accepted by <bdi>${name}</bdi>&quot;.`);
    expect(renderToStaticMarkup(<AcceptedSaved choice={{ kind: 'member', userId: 'u-x' }} names={names} />)).toBe(`Closed: risk accepted by <bdi>${name}</bdi>.`);
    expect(renderToStaticMarkup(<AcceptedSentence choice={null} names={names} />)).toBe('');
  });

  it('NFR-SEC-11 (SFH-3): the member\'s name in the closed-by sentence is inside <bdi>, so U+202E cannot reorder the time after it', () => {
    const name = 'Ev\u202Eil';
    expect(renderToStaticMarkup(<FailureText text={`This finding was closed by ${name} at 10:42 EAT.`} name={name} />))
      .toBe(`This finding was closed by <bdi>${name}</bdi> at 10:42 EAT.`);
    expect(renderToStaticMarkup(<FailureText text="This finding is closed." />)).toBe('This finding is closed.');
  });
});

describe('B6 and the status line (UX-26, NFR-PRIV-06, UX-30)', () => {
  it('UX-26 NFR-PRIV-06 (SO-1): the form builds its key with the helper the test pins, not an inline object', () => {
    expect(mitigationDraftKey({ userId: 'u1', orgId: 'o1', projectId: 'p1', findingId: 'f1', mitigationId: null })).toBe('makrai.draft.v1:u1:o1:p1:m:f1:new');
    const source = readFileSync('components/findings/MitigationForm.tsx', 'utf8');
    expect(source).not.toMatch(/kind: 'mitigation'/);
    expect(source.match(/mitigationDraftTarget\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('UX-30 (CO-1): "Not attached:" lists each file name inside <bdi>', () => {
    const html = renderToStaticMarkup(<NotAttached names={['plan.pdf', 'a\u202Eb.pdf']} />);
    expect(html).toBe('Not attached: <span><bdi>plan.pdf</bdi></span><span>, <bdi>a\u202Eb.pdf</bdi></span>.');
  });

  it('FR-PUB-01: the status words carry no data-claims-allowed marker (the claims allow-list names "In progress" in this file), and a note stays in <bdi>', () => {
    expect(renderToStaticMarkup(<MitigationStatusWord status="in_progress" />)).toBe('<span class="status-label">In progress</span>');
    for (const status of ['planned', 'done', 'cancelled'] as const) expect(renderToStaticMarkup(<MitigationStatusWord status={status} />)).not.toContain('data-claims-allowed');
    expect(renderToStaticMarkup(<MitigationStatusWord status="done" noArtefactNote="Deployment stopped" />)).toContain('Done, no artefact: <bdi>Deployment stopped</bdi>');
  });
});
