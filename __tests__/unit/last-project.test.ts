import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

/**
 * The last project a person opened in an organisation (plan 1A Task 12, rulings P2/L2-64 and S4, Review Focus 1): one
 * storage module, keyed by the person's own id, that never throws and never lets a broken storage reach the rail.
 *
 * vitest runs in `node` with no jsdom (an install is a download), so `localStorage` and `window` are stubbed per case;
 * the browser behaviour itself is e2e/help-and-findings.spec.ts.
 */

type Store = { map: Map<string, string>; storage: Storage };

function memoryStorage(entries: [string, string][] = []): Store {
  const map = new Map(entries);
  const storage = {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
  return { map, storage };
}

function throwingStorage(): Storage {
  const fail = () => { throw new DOMException('denied', 'SecurityError'); };
  return { get length() { return fail(); }, key: fail, getItem: fail, setItem: fail, removeItem: fail, clear: fail } as unknown as Storage;
}

async function load() {
  vi.resetModules();
  return import('@/lib/client/lastProject');
}

afterEach(() => { vi.unstubAllGlobals(); });

const P1 = '0b5c3f7e-4c1d-4d8e-9a3b-1f2e3d4c5b6a';

describe('lib/client/lastProject', () => {
  it('L2-64: the key carries the person\'s id and the organisation\'s slug, and nav.ts re-exports the same key', async () => {
    const m = await load();
    expect(m.LAST_PROJECT_PREFIX).toBe('makrai:last-project:');
    expect(m.LAST_PROJECT_KEY('u1', 'acme')).toBe('makrai:last-project:u1:acme');
    const nav = await import('@/lib/shell/nav');
    expect(nav.LAST_PROJECT_KEY).toBe(m.LAST_PROJECT_KEY);
    expect(nav.LAST_PROJECT_PREFIX).toBe(m.LAST_PROJECT_PREFIX);
  });

  it('L2-64: remembers and reads back the last project of this person in this organisation', async () => {
    const { storage, map } = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', new EventTarget());
    const m = await load();
    expect(m.readLastProject('u1', 'acme')).toBeNull();
    m.rememberLastProject('u1', 'acme', P1);
    expect(map.get('makrai:last-project:u1:acme')).toBe(P1);
    expect(m.readLastProject('u1', 'acme')).toBe(P1);
    expect(m.readLastProject('u2', 'acme')).toBeNull();
    expect(m.readLastProject('u1', 'other')).toBeNull();
  });

  it('Review Focus 1: findings link falls back when storage throws: readLastProject gives null when getItem throws', async () => {
    vi.stubGlobal('localStorage', throwingStorage());
    const m = await load();
    expect(m.readLastProject('u1', 'acme')).toBeNull();
  });

  it('Review Focus 1: findings link falls back when storage is absent: readLastProject gives null with no localStorage', async () => {
    // node 22 has no global localStorage: reading it is a ReferenceError the module must swallow.
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe('undefined');
    const m = await load();
    expect(m.readLastProject('u1', 'acme')).toBeNull();
  });

  it('Review Focus 1: rememberLastProject does nothing, and throws nothing, when setItem throws', async () => {
    vi.stubGlobal('localStorage', throwingStorage());
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener('makrai:last-project', heard);
    vi.stubGlobal('window', target);
    const m = await load();
    expect(() => m.rememberLastProject('u1', 'acme', P1)).not.toThrow();
    expect(heard).not.toHaveBeenCalled();
  });

  it('P2: a write is announced, so a subscribed rail reads the new value; unsubscribing stops it', async () => {
    const { storage } = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', new EventTarget());
    const m = await load();
    const seen: (string | null)[] = [];
    const stop = m.subscribeLastProject(() => { seen.push(m.readLastProject('u1', 'acme')); });
    m.rememberLastProject('u1', 'acme', P1);
    expect(seen).toEqual([P1]);
    stop();
    m.rememberLastProject('u1', 'acme', '11111111-2222-4333-8444-555555555555');
    expect(seen).toEqual([P1]);
  });

  it('S4: clearLastProjects(u1) removes u1\'s keys only, and leaves u10\'s, u2\'s and every other key', async () => {
    const { storage, map } = memoryStorage([
      ['makrai:last-project:u1:a', P1], ['makrai:last-project:u1:b', P1],
      ['makrai:last-project:u10:a', P1], ['makrai:last-project:u2:a', P1],
      ['makrai.draft.v1:u1:x', '{}'], ['makrai-theme', 'dark'],
    ]);
    vi.stubGlobal('localStorage', storage);
    const m = await load();
    m.clearLastProjects('u1');
    expect([...map.keys()].sort()).toEqual(['makrai-theme', 'makrai.draft.v1:u1:x', 'makrai:last-project:u10:a', 'makrai:last-project:u2:a']);
  });

  it('S4: clearLastProjects(\'\') removes nothing, and a storage that throws makes it throw nothing', async () => {
    const { storage, map } = memoryStorage([['makrai:last-project:u1:a', P1]]);
    vi.stubGlobal('localStorage', storage);
    let m = await load();
    m.clearLastProjects('');
    expect(map.size).toBe(1);
    vi.stubGlobal('localStorage', throwingStorage());
    m = await load();
    expect(() => m.clearLastProjects('u1')).not.toThrow();
  });

  it('S4 (silent-failure hunt F2): one refused removal does not keep the person\'s other keys, and is said once', async () => {
    const { storage, map } = memoryStorage([['makrai:last-project:u1:a', P1], ['makrai:last-project:u1:b', P1]]);
    let refused = false;
    const remove = storage.removeItem;
    storage.removeItem = (k: string) => {
      if (!refused) { refused = true; throw new DOMException('denied', 'SecurityError'); }
      remove(k);
    };
    vi.stubGlobal('localStorage', storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await load();
    m.clearLastProjects('u1');
    expect(map.size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('L2-75: remembering removes every other person\'s last-project key, and keeps this person\'s other organisations and every other key', async () => {
    const { storage, map } = memoryStorage([
      ['makrai:last-project:u1:a', P1], ['makrai:last-project:u10:b', P1], ['makrai:last-project:u2:other', P1],
      ['makrai.draft.v1:u1:x', '{}'], ['makrai-theme', 'dark'], ['theme', 'light'],
    ]);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', new EventTarget());
    const m = await load();
    m.rememberLastProject('u2', 'a', P1);
    expect([...map.keys()].sort()).toEqual(['makrai-theme', 'makrai.draft.v1:u1:x', 'makrai:last-project:u2:a', 'makrai:last-project:u2:other', 'theme']);
  });

  it('L2-75: a removeItem or key() that throws neither throws nor stops the write, and says nothing', async () => {
    for (const broken of ['removeItem', 'key'] as const) {
      const { storage, map } = memoryStorage([['makrai:last-project:u1:a', P1], ['makrai:last-project:u3:a', P1]]);
      storage[broken] = (() => { throw new DOMException('denied', 'SecurityError'); }) as never;
      vi.stubGlobal('localStorage', storage);
      const target = new EventTarget();
      const heard = vi.fn();
      target.addEventListener('makrai:last-project', heard);
      vi.stubGlobal('window', target);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const m = await load();
      expect(() => m.rememberLastProject('u2', 'a', P1), broken).not.toThrow();
      expect(map.get('makrai:last-project:u2:a'), broken).toBe(P1);
      expect(heard, broken).toHaveBeenCalledTimes(1);
      expect(warn, broken).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  });

  it('L2-64: the module imports nothing, so it stays small on every page that loads it', () => {
    const src = readFileSync('lib/client/lastProject.ts', 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe('L2-66 S4: every person-started sign-out clears this person\'s last-project keys', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('L2-66 (3): the drafts guard\'s "Delete them and sign out" clears them beside purgeAccount, before signOut', () => {
    expect(read('components/decision/SignOutWithDraftsGuard.tsx')).toMatch(
      /openDraftStore\(\)\?\.purgeAccount\(userId\);\s*clearLastProjects\(userId\);\s*await signOut\(/,
    );
  });

  it('L2-66 (4): Sign out everywhere clears them in the same callback that purges the drafts', () => {
    expect(read('components/account/SignOutEverywhere.tsx')).toMatch(
      /\(\) => \{\s*openDraftStore\(\)\?\.purgeAccount\(userId\);\s*clearLastProjects\(userId\);\s*\}/,
    );
  });

  it('L2-66 (5): account deletion clears them beside purgeAccount, before signOut', () => {
    expect(read('components/account/PersonalExportAndDeletionForm.tsx')).toMatch(
      /openDraftStore\(\)\?\.purgeAccount\(userId\);\s*clearLastProjects\(userId\);\s*try \{\s*await signOut\(/,
    );
  });

  it('L2-66 (second route): every client file that calls signOut( also clears the keys, except the password change', () => {
    const files = ['components', 'lib', 'app'].flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith('app/api/'));
    const callers = files.filter((f) => /\bsignOut\(/.test(read(f))).sort();
    expect(callers).toEqual([
      'app/(authenticated)/change-password/ChangePasswordForm.tsx',
      'components/account/PersonalExportAndDeletionForm.tsx',
      'components/account/SignOutEverywhere.tsx',
      'components/decision/SignOutWithDraftsGuard.tsx',
      'components/layout/Rail.tsx',
      'lib/client/signOutClearingDrafts.ts',
    ]);
    for (const f of callers.filter((c) => !c.includes('change-password') && !c.endsWith('signOutClearingDrafts.ts'))) expect(read(f), f).toMatch(/clearLastProjects\(/);
    // signOutClearingDrafts is on two public pages, so it sweeps the keys itself (fix round 1, F1c), with no import of the store.
    expect(read('lib/client/signOutClearingDrafts.ts')).toMatch(/sweepLastProjects\(userId\);/);
    expect(read('lib/client/signOutClearingDrafts.ts')).not.toMatch(/from '@\/lib\/client\/lastProject'/);
    expect(read('app/(authenticated)/change-password/ChangePasswordForm.tsx')).not.toMatch(/clearLastProjects/);
  });
});

describe('signOutClearingDrafts sweeps the keys itself (fix round 1, F1c)', () => {
  async function signOutWith(storage: Storage) {
    vi.resetModules();
    const signOut = vi.fn(async () => {});
    vi.doMock('next-auth/react', () => ({ signOut }));
    vi.doMock('@/lib/client/drafts', () => ({ openDraftStore: () => null }));
    vi.stubGlobal('localStorage', storage);
    const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
    await signOutClearingDrafts('u1', '/login');
    vi.doUnmock('next-auth/react');
    vi.doUnmock('@/lib/client/drafts');
    return signOut;
  }

  it('F1c (silent-failure hunt 2, F4): a key() that throws still signs out, silently', async () => {
    const { storage } = memoryStorage([['makrai:last-project:u1:a', P1]]);
    storage.key = (() => { throw new DOMException('denied', 'SecurityError'); }) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await signOutWith(storage)).toHaveBeenCalledWith({ callbackUrl: '/login' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('F1c (silent-failure hunt 2, F4): one refused removal keeps neither the other keys nor the sign-out back, and is said once in fixed words', async () => {
    const { storage, map } = memoryStorage([['makrai:last-project:u1:a', P1], ['makrai:last-project:u1:b', P1], ['makrai:last-project:u2:a', P1]]);
    let refused = false;
    const remove = storage.removeItem;
    storage.removeItem = (k: string) => {
      if (!refused) { refused = true; throw new DOMException('denied', 'SecurityError'); }
      remove(k);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await signOutWith(storage)).toHaveBeenCalledWith({ callbackUrl: '/login' });
    expect([...map.keys()].filter((k) => k.includes(':u1:'))).toHaveLength(1);
    expect(map.has('makrai:last-project:u2:a')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/u1/);
    warn.mockRestore();
  });
});

describe('RememberProject', () => {
  it('Review Focus 1: renders nothing', async () => {
    const { default: RememberProject } = await import('@/components/layout/RememberProject');
    expect(renderToStaticMarkup(createElement(RememberProject, { userId: 'u1', orgSlug: 'acme', projectId: P1 }))).toBe('');
  });

  it('S9 L2-64: one effect that stores the three props it was given, only when all three are non-empty, through rememberLastProject', () => {
    const src = readFileSync('components/layout/RememberProject.tsx', 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['@/lib/client/lastProject', 'react']);
    expect(src).toMatch(/useEffect\(/);
    expect(src).toMatch(/rememberLastProject\(userId, orgSlug, projectId\)/);
    expect(src).toMatch(/userId !== '' && orgSlug !== '' && projectId !== ''/);
    expect(src).not.toMatch(/localStorage/);
  });
});
