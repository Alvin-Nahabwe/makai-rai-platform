import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Plan 1B Task 4: the session warning says the rule the code applies (R10, defect 6), and the signed-out notice says why
 * the session ended (C12), with the hint S-01 reads (T2.1). The clock itself is __tests__/unit/idle.test.ts's.
 */
const { default: IdleWarning, IdleEndedNotice } = await import('@/components/layout/IdleWarning');
const { IDLE_TEXTS } = await import('@/lib/auth/session/copy');
const { AUTH_COPY } = await import('@/lib/auth/copy');
const { SIGNED_OUT_HINT_KEY, clearSignedOutHint, endReason, signInAgainHref, writeSignedOutHint } = await import('@/lib/auth/idle');

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

function memory(): Storage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>();
  const s = {
    map, writes: 0,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { s.writes += 1; map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return s;
}

describe('endReason', () => {
  it('idle, absolute (also when both have passed), or null while the session lasts', () => {
    expect(endReason({ secondsLeft: 10, absoluteSecondsLeft: 99, elapsedSeconds: 11 })).toBe('idle');
    expect(endReason({ secondsLeft: 99, absoluteSecondsLeft: 10, elapsedSeconds: 11 })).toBe('absolute');
    expect(endReason({ secondsLeft: 10, absoluteSecondsLeft: 10, elapsedSeconds: 11 })).toBe('absolute');
    expect(endReason({ secondsLeft: 99, absoluteSecondsLeft: 99, elapsedSeconds: 1 })).toBeNull();
    expect(endReason({ secondsLeft: 10, absoluteSecondsLeft: 99, elapsedSeconds: 10 })).toBe('idle');
  });
});

describe('C12: the signed-out hint', () => {
  it('is written once with the true reason and the time, under the hint key only', () => {
    const s = memory();
    writeSignedOutHint(s, 'absolute', 1_700_000_000_000);
    expect(s.writes).toBe(1);
    expect([...s.map.keys()]).toEqual([SIGNED_OUT_HINT_KEY]);
    expect(JSON.parse(s.map.get(SIGNED_OUT_HINT_KEY)!)).toEqual({ reason: 'absolute', at: 1_700_000_000_000 });
    expect(SIGNED_OUT_HINT_KEY.startsWith('makrai.draft')).toBe(false); // never a draft key (RF-3)
  });

  it('a throwing or absent storage changes nothing else and throws nothing', () => {
    const throwing = { setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(() => writeSignedOutHint(throwing, 'idle', 1)).not.toThrow();
    expect(() => writeSignedOutHint(null, 'idle', 1)).not.toThrow();
    expect(() => clearSignedOutHint(throwing)).not.toThrow();
    expect(() => clearSignedOutHint(null)).not.toThrow();
  });

  it('is cleared when the session is known to be alive (d2-sfh-1 finding 5)', () => {
    const s = memory();
    writeSignedOutHint(s, 'idle', 1);
    s.map.set('makrai.draft.v1:u:o:p:q:Q-PP-01', 'kept');
    clearSignedOutHint(s);
    expect([...s.map.keys()]).toEqual(['makrai.draft.v1:u:o:p:q:Q-PP-01']);
  });
});

describe('the words (R10, L5-10)', () => {
  it('H3: signInAgainHref is byte-for-byte as at v0.6.0', () =>
    expect(signInAgainHref('/orgs/a/projects/p', '?x=1')).toBe('/login?callbackUrl=%2Forgs%2Fa%2Fprojects%2Fp%3Fx%3D1'));

  it('defect 6: no "nothing has happened" in any idle text, and the warning says the rule and to save', () => {
    const all = Object.values(IDLE_TEXTS).join(' ');
    expect(all).not.toMatch(/nothing has happened|inactiv/i);
    expect(IDLE_TEXTS.warningBody).toMatch(/12 hours after you sign in, or after you last chose Stay signed in/);
    // I-4 (amends L5-10): the dialog makes the page inert, so the person stays signed in first, then saves.
    expect(IDLE_TEXTS.warningBody).toMatch(/Choose Stay signed in, then save your work\.$/);
    expect(IDLE_TEXTS.warningBody).not.toMatch(/Save your work now/);
    expect(all).not.toMatch(/[–—]/);
  });

  it('AUTH_COPY carries the same session words, and S-01 says the same reason sentence as the notice (M-5)', () => {
    expect(AUTH_COPY.signedOutIdle).toBe(IDLE_TEXTS.endedIdle);
    expect(AUTH_COPY.signedOutAbsolute).toBe(IDLE_TEXTS.endedAbsolute);
    expect(AUTH_COPY.endedIdle).toBe(IDLE_TEXTS.endedIdle);
    expect(AUTH_COPY.endedAbsolute).toBe(IDLE_TEXTS.endedAbsolute);
    expect(AUTH_COPY.warningBody).toBe(IDLE_TEXTS.warningBody);
  });
});

describe('the warning and the notice', () => {
  it('the warning is the kit\'s native dialog with the title, the rule and what is kept, and Stay signed in', () => {
    const h = html(<IdleWarning idleSeconds={43200} secondsLeft={600} absoluteSecondsLeft={100000} />);
    expect(h).toContain(`>${IDLE_TEXTS.warningTitle}</h2>`);
    expect(h.indexOf(IDLE_TEXTS.warningBody)).toBeLessThan(h.indexOf(IDLE_TEXTS.warningKept));
    expect(h).toContain(`>${IDLE_TEXTS.stay}</button>`);
    expect(h).not.toContain(IDLE_TEXTS.endedKept); // the notice is a later state
  });

  it('the notice is not a dialog and has the sign-in link', () => {
    const h = html(<IdleEndedNotice signInHref="/login?x" reason="absolute" />);
    expect(h).not.toMatch(/<dialog|role="dialog"|aria-modal|\binert\b/);
    expect(h).toMatch(/^<div[^>]*role="alert"/);
    expect(h).toContain(AUTH_COPY.endedAbsolute);
    expect(h).toContain(IDLE_TEXTS.endedKept);
    // I-7: Sign in again is a link drawn as the kit's primary button (44 px), under the text at every width.
    expect(h).toMatch(new RegExp(`<a class="ui-button ui-button--primary" href="/login\\?x"[^>]*>${IDLE_TEXTS.signInAgain}</a>`));
    expect(h).not.toContain('ui-banner__action');
    expect(h.indexOf(IDLE_TEXTS.endedKept)).toBeLessThan(h.indexOf(IDLE_TEXTS.signInAgain));
    expect(h).toContain('ui-banner--session');
  });

  it('each reason says its own sentence; an end the clock cannot explain says no reason (d2-sfh-1 finding 3)', () => {
    const idle = html(<IdleEndedNotice signInHref="/l" reason="idle" />);
    expect(idle).toContain(IDLE_TEXTS.endedIdle);
    expect(idle).not.toContain(IDLE_TEXTS.endedAbsolute);
    const unknown = html(<IdleEndedNotice signInHref="/l" reason={null} />);
    expect(unknown).toContain(IDLE_TEXTS.endedElsewhere);
    expect(unknown).not.toMatch(/12 hours|7 days/);
  });

  it('IdleWarning writes the hint only with a reason, and clears it at mount and on an extension', () => {
    const src = readFileSync('components/layout/IdleWarning.tsx', 'utf8');
    expect(src.match(/writeSignedOutHint\(/g)).toHaveLength(1);
    expect(src).toMatch(/if \(reason !== null\) writeSignedOutHint\(tabStorage\(\), reason, Date\.now\(\)\)/);
    expect(src.match(/clearSignedOutHint\(tabStorage\(\)\)/g)).toHaveLength(2);
    // B-1: one tabStorage, beside the hint's key in lib/auth/idle.ts.
    expect(src).toMatch(/import \{[^}]*\btabStorage\b[^}]*\} from '@\/lib\/auth\/idle'/);
    expect(src).not.toMatch(/function tabStorage/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|makrai\.draft|purge|removeItem|setItem/);
  });
});

vi.restoreAllMocks();
