import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Plan 1B Task 5, D16 option A (owner's answer to OD-1, 11 Nov 2026): after a sign-in, text another account left in this
 * browser is named as existing, never shown, before today's purge removes it (T5.1 to T5.8). The store's one addition,
 * `hasOtherAccounts`, is read-only (the permitted change of lib/client/drafts.ts).
 */
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), getSession: vi.fn() }));

const { openDraftStore, draftKey } = await import('@/lib/client/drafts');
const { afterSignIn, anyDrafts, LoginView, LoginRouteView, removeOtherLastProjectKeys } = await import('@/app/(public)/login/LoginClient');
const { OtherAccountTextConfirm } = await import('@/components/auth/OtherAccountTextConfirm');
const { AUTH_COPY } = await import('@/lib/auth/copy');

const NOW = new Date('2026-11-15T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const draftAt = (ms: number) => JSON.stringify({ baseVersionNumber: null, value: { reason: 'x' }, savedAt: new Date(ms).toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
const keyOf = (userId: string, q = 'Q-PP-01') => draftKey({ userId, orgId: 'o1', projectId: 'p1', target: { kind: 'question', questionId: q } });

/** A Storage held in a Map that counts every write and removal. */
function memory(entries: Array<[string, string]> = []) {
  const map = new Map<string, string>(entries);
  const calls = { set: 0, remove: 0 };
  const storage: Storage = {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { calls.set += 1; map.set(k, String(v)); },
    removeItem: (k: string) => { calls.remove += 1; map.delete(k); },
    clear: () => map.clear(),
  };
  return { storage, map, calls };
}
const throwing = { get length(): number { throw new Error('SecurityError'); }, key: () => { throw new Error('SecurityError'); },
  getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); }, clear: () => {} } as unknown as Storage;

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

describe('DraftStore.hasOtherAccounts', () => {
  it('own only: false; another account\'s: true; empty id: false; expired other: false; a key that does not parse: false', () => {
    const own = memory([[keyOf('a'), draftAt(NOW.getTime())]]);
    expect(openDraftStore(own.storage)!.hasOtherAccounts('a', NOW)).toBe(false);
    const other = memory([[keyOf('a'), draftAt(NOW.getTime())], [keyOf('b'), draftAt(NOW.getTime())]]);
    expect(openDraftStore(other.storage)!.hasOtherAccounts('a', NOW)).toBe(true);
    expect(openDraftStore(other.storage)!.hasOtherAccounts('', NOW)).toBe(false);
    const expired = memory([[keyOf('b'), draftAt(NOW.getTime() - 8 * DAY)]]);
    expect(openDraftStore(expired.storage)!.hasOtherAccounts('a', NOW)).toBe(false);
    const junk = memory([['makrai.draft.v1:probe', '1'], [keyOf('b'), 'not a draft'], ['makrai.draft.v1:b:x', draftAt(NOW.getTime())]]);
    expect(openDraftStore(junk.storage)!.hasOtherAccounts('a', NOW)).toBe(false);
  });

  it('permitted change: hasOtherAccounts writes nothing to storage, even with expired keys present', () => {
    const m = memory([[keyOf('b'), draftAt(NOW.getTime() - 8 * DAY)], [keyOf('c'), 'junk'], [keyOf('d'), draftAt(NOW.getTime())]]);
    const store = openDraftStore(m.storage)!;
    const before = { ...m.calls };   // the store's probe write at open is not this method's
    expect(store.hasOtherAccounts('a', NOW)).toBe(true);
    expect(store.hasOtherAccounts('d', NOW)).toBe(false);
    expect(m.calls).toEqual(before);
    expect(m.map.size).toBe(3);
  });
});

describe('afterSignIn and anyDrafts', () => {
  it('no drafts: go; own only: go; another account\'s: confirm other; id null and any draft: confirm unknown', () => {
    expect(afterSignIn(memory().storage, 'a', NOW)).toEqual({ kind: 'go' });
    expect(afterSignIn(memory([[keyOf('a'), draftAt(NOW.getTime())]]).storage, 'a', NOW)).toEqual({ kind: 'go' });
    expect(afterSignIn(memory([[keyOf('b'), draftAt(NOW.getTime())]]).storage, 'a', NOW)).toEqual({ kind: 'confirm', who: 'other' });
    expect(afterSignIn(memory([[keyOf('a'), draftAt(NOW.getTime())]]).storage, null, NOW)).toEqual({ kind: 'confirm', who: 'unknown' });
    expect(afterSignIn(memory([['other-key', 'v']]).storage, null, NOW)).toEqual({ kind: 'go' });
  });

  it('T5.5: storage that throws or is absent means no warning', () => {
    expect(afterSignIn(throwing, 'a', NOW)).toEqual({ kind: 'go' });
    expect(afterSignIn(throwing, null, NOW)).toEqual({ kind: 'go' });
    expect(afterSignIn(null, 'a', NOW)).toEqual({ kind: 'go' });
    expect(afterSignIn(null, null, NOW)).toEqual({ kind: 'go' });
    expect(anyDrafts(throwing)).toBe(false);
    expect(anyDrafts(null)).toBe(false);
    expect(anyDrafts(memory([[keyOf('b'), 'junk']]).storage)).toBe(true);
  });
});

describe('T5.7: other accounts\' last-project keys go with their drafts on Remove', () => {
  it('removes every other account\'s last-project key, keeps this account\'s and every other key; all of them when the id is unknown', () => {
    const entries: Array<[string, string]> = [['makrai:last-project:a:acme', 'p'], ['makrai:last-project:b:acme', 'p'], ['makrai:last-project:ab:x', 'p'], ['other', 'v']];
    const m = memory(entries);
    removeOtherLastProjectKeys(m.storage, 'a');
    expect([...m.map.keys()].sort()).toEqual(['makrai:last-project:a:acme', 'other']);
    const n = memory(entries);
    removeOtherLastProjectKeys(n.storage, null);
    expect([...n.map.keys()]).toEqual(['other']);
    expect(() => removeOtherLastProjectKeys(throwing, 'a')).not.toThrow();
    expect(() => removeOtherLastProjectKeys(null, 'a')).not.toThrow();
  });
});

describe('the confirmation (T5.2, Review Focus 4)', () => {
  const props = { onRemove: noop, onSignOut: noop, removing: false, leaving: false, message: null };
  /** The markup with React's generated ids and the icons' drawing taken out: what is left is what the page says and marks. */
  const said = (h: string) => h.replace(/ (id|aria-labelledby|aria-describedby)="[^"]*"/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');

  it('T5.2: the confirmation shows no count, key or id', () => {
    // The fixed words are taken out first: consequenceLeave's "7 days" is the drafts' rule, not a count of anything kept.
    const fixed = [AUTH_COPY.consequenceLeave];
    for (const kind of ['other', 'unknown'] as const) {
      const h = fixed.reduce((acc, f) => acc.split(f).join(''), said(html(createElement(OtherAccountTextConfirm, { kind, ...props }))));
      expect(h).not.toMatch(/\d|makrai\.draft|makrai:last-project|data-(user|key|count)/);
    }
  });

  it('other: the body names no one; the choices in order, Sign out and leave it first, Remove destructive; no box in the card (M-3)', () => {
    const h = html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props }));
    expect(h).toContain(AUTH_COPY.otherTextBody);
    expect(h).not.toContain('ui-confirm');   // the two choices are drawn here, not in InlineConfirm's bordered box (L5-27)
    expect(h.indexOf(AUTH_COPY.consequenceLeave)).toBeLessThan(h.indexOf(AUTH_COPY.consequenceRemove));
    expect(h.indexOf(`>${AUTH_COPY.signOutAndLeave}</button>`)).toBeLessThan(h.indexOf(`>${AUTH_COPY.removeAndContinue}</button>`));
    expect(h).toMatch(new RegExp(`class="ui-button ui-button--destructive"[^>]*>${AUTH_COPY.removeAndContinue}</button>`));
    expect(h).not.toMatch(/orange|ui-button--primary/);
  });

  it('Review Focus 4: unknown account warns with the cannot-check wording', () => {
    const t = html(createElement(OtherAccountTextConfirm, { kind: 'unknown', ...props }));
    expect(t).toContain(AUTH_COPY.unknownTextBody);
    expect(t).not.toContain(AUTH_COPY.otherTextBody);
  });

  it('a failed Sign out and leave it is said in an alert region that exists before its text (d2-sfh-1 finding 2)', () => {
    expect(html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props }))).toMatch(/<div role="alert" class="ui-status ui-status--error"><\/div>/);
    expect(html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props, message: 'M-STILL' }))).toMatch(/<div role="alert"[^>]*>.*M-STILL/);
  });

  it('L5-27 (I-3): S-01 shows the confirmation in place of the form; its question is the page\'s h1, not "Sign in"; no footer', () => {
    for (const [who, title] of [['other', AUTH_COPY.otherTextTitle], ['unknown', AUTH_COPY.unknownTextTitle]] as const) {
      const h = html(createElement(LoginView, {
        email: 'b@x.test', password: 'pw', showPassword: false, error: '', notice: null, loading: true, signedOut: null,
        onEmail: noop, onPassword: noop, onToggleShow: noop, onSubmit: noop,
        confirm: { who, ...props },
      }));
      expect(h.match(/<h1\b[^>]*>([^<]*)<\/h1>/)?.[1]).toBe(title);
      expect(h).not.toMatch(/<form\b|id="password"/);
      expect(h).not.toContain(AUTH_COPY.noAccount);
    }
  });

  it('A-2: each choice shows its own progress: Sign out and leave it while it runs, Remove only when pressed', () => {
    const busyButtons = (h: string) => [...h.matchAll(/<button[^>]*aria-busy="true"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(busyButtons(html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props, leaving: true })))).toEqual([AUTH_COPY.signOutAndLeave]);
    expect(busyButtons(html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props, removing: true })))).toEqual([AUTH_COPY.removeAndContinue]);
    expect(busyButtons(html(createElement(OtherAccountTextConfirm, { kind: 'other', ...props })))).toEqual([]);
  });

  it('L5-27: the route marks Sign in done and names the question the current stop, while it is asked', () => {
    const signIn = html(createElement(LoginRouteView, { step: 'signIn' }));
    expect(signIn).toMatch(/aria-current="step"><span class="gate-route__here">[^<]*<\/span> Sign in</);
    const asking = html(createElement(LoginRouteView, { step: 'confirm' }));
    expect(asking).toMatch(new RegExp(`aria-current="step"><span class="gate-route__here">[^<]*</span> ${AUTH_COPY.loginStops.unsavedText}<`));
    expect(asking).toMatch(/gate-route__stop--done[^>]*>.*?Sign in/);
  });
});

describe('T5.3 and T5.6: what each choice runs (source level; e2e/shared-browser.spec.ts runs them in a browser)', () => {
  const src = readFileSync('app/(public)/login/LoginClient.tsx', 'utf8');
  const body = (name: string) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n  }\n', src.indexOf(`function ${name}(`)));

  it('T5.3: Remove calls purgeDraftsAfterSignIn with the same id, after the other last-project keys, then navigates', () => {
    const remove = body('removeAndGoOn');
    expect(remove.indexOf('removeOtherLastProjectKeys(undefined, pending.userId)')).toBeGreaterThan(-1);
    expect(remove.indexOf('goOn(pending.userId)')).toBeGreaterThan(remove.indexOf('removeOtherLastProjectKeys('));
    const go = body('goOn');
    expect(go.indexOf('purgeDraftsAfterSignIn(undefined, userId)')).toBeGreaterThan(-1);
    expect(go.indexOf('router.push(callbackUrl)')).toBeGreaterThan(go.indexOf('purgeDraftsAfterSignIn('));
  });

  it('T5.1: the check runs only after a sign-in that worked, with the id the session read gave', () => {
    const submit = body('onSubmit');
    expect(submit.indexOf("if (outcome.kind === 'error')")).toBeLessThan(submit.indexOf('afterSignIn(undefined, outcome.userId, new Date())'));
    expect(submit).not.toMatch(/afterSignIn\([^)]*email/);
  });

  it('T5.6: Sign out and leave it is the sign-out press, with this account\'s id, to S-01', () => {
    expect(src).toContain("const leave = useSignOutPress(pending?.userId ?? '', '/login');");
    expect(src).toMatch(/onSignOut: leave\.press/);
  });
});
