import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JWT } from 'next-auth/jwt';
import type { User } from 'next-auth';
import {
  ABSOLUTE_SESSION_SECONDS,
  IDLE_MARGIN_SECONDS,
  IDLE_WARNING_SECONDS,
  acceptIdleMessage,
  idleLimitSeconds,
  idlePhase,
  msToNextPhase,
  readSessionResponse,
  settleStay,
  signInAgainHref,
  stayOutcome,
  withMargin,
} from '@/lib/auth/idle';
import IdleWarning, { IdleEndedNotice } from '@/components/layout/IdleWarning';
import { IDLE_TEXTS } from '@/lib/auth/session/copy';
import { jwtCallback } from '@/lib/auth/callbacks';
import { resolveIdentity, SessionError } from '@/lib/auth/identity';

// resolveIdentity reads the user row only after its cheap checks. The cases below that reach the
// read stub it, so this file needs no database.
vi.mock('@/lib/data/identity', () => ({
  identityDb: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'user-1',
        email: 'a@example.test',
        name: 'A',
        role: 'assessor',
        isActive: true,
        mustChangePassword: false,
        sessionEpoch: 3,
      })),
    },
  },
}));

/**
 * UX-43 (SRS 7.6.1, line 2645; WCAG 2.2.1): two minutes before the session cookie's expiry
 * the page warns and offers "Stay signed in". Preventive obligations U-S1, U-S2, U-S7 and U-S9
 * of the unit brief are proved here; the browser half is in e2e/idle-warning.spec.ts and
 * e2e/shell-checks.spec.ts.
 */

const TWELVE_HOURS = 43200;

/** NodeJS.ProcessEnv in this project requires NODE_ENV; a test env holds only the variables under test. */
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

describe('idleLimitSeconds', () => {
  it('UX-43 NFR-SEC-07: the idle seam only shortens, and only with MAKRAI_TEST_SEAMS=1', () => {
    expect(IDLE_WARNING_SECONDS).toBe(120);
    expect(idleLimitSeconds(env({}))).toBe(TWELVE_HOURS);
    // The test variable alone does nothing: the gate is MAKRAI_TEST_SEAMS.
    expect(idleLimitSeconds(env({ MAKRAI_TEST_IDLE_SECONDS: '180' }))).toBe(TWELVE_HOURS);
    expect(idleLimitSeconds(env({ MAKRAI_TEST_SEAMS: '1', MAKRAI_TEST_IDLE_SECONDS: '180' }))).toBe(180);
    // Out of range, not a whole number, or not a number at all: the real limit.
    for (const v of ['90', '179', '43201', '99999', '180.5', 'x', '', ' 180', '180 ', '+180', '1e3', '0x100', '-180']) {
      expect(idleLimitSeconds(env({ MAKRAI_TEST_SEAMS: '1', MAKRAI_TEST_IDLE_SECONDS: v })), JSON.stringify(v)).toBe(TWELVE_HOURS);
    }
    // Only the exact string "1" opens the seam.
    for (const gate of ['true', 'yes', '0', '', ' 1', '1 ']) {
      expect(idleLimitSeconds(env({ MAKRAI_TEST_SEAMS: gate, MAKRAI_TEST_IDLE_SECONDS: '180' })), JSON.stringify(gate)).toBe(TWELVE_HOURS);
    }
    // The ceiling is the real limit, so the seam can never lengthen it.
    expect(idleLimitSeconds(env({ MAKRAI_TEST_SEAMS: '1', MAKRAI_TEST_IDLE_SECONDS: '43200' }))).toBe(TWELVE_HOURS);
    expect(idleLimitSeconds(env({ MAKRAI_TEST_SEAMS: '1', MAKRAI_TEST_IDLE_SECONDS: '43199' }))).toBe(43199);
  });

  it('UX-43 NFR-SEC-07: with no argument it reads process.env, and reads no other variable', () => {
    const source = stripComments(readFileSync('lib/auth/idle.ts', 'utf8'));
    const names = [...source.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(names)]).toEqual(['MAKRAI_TEST_IDLE_SECONDS', 'MAKRAI_TEST_SEAMS']);
    expect(source).toMatch(/env:\s*NodeJS\.ProcessEnv\s*=\s*process\.env/);
  });

  it('UX-43 NFR-SEC-07: the session maxAge is the idle limit, not a second literal', () => {
    const source = readFileSync('lib/auth.ts', 'utf8');
    expect(source).toMatch(/maxAge:\s*idleLimitSeconds\(\)/);
    expect(source).not.toMatch(/maxAge:\s*12\s*\*\s*60\s*\*\s*60/);
  });
});

describe('idlePhase and stayOutcome', () => {
  it('UX-43: idlePhase warns 120 s before the idle deadline, ends at it, and never warns before the 7-day limit', () => {
    const ph = (secondsLeft: number, absoluteSecondsLeft: number, elapsedSeconds: number) =>
      idlePhase({ secondsLeft, absoluteSecondsLeft, elapsedSeconds });
    expect(ph(43200, 604800, 43079)).toBe('waiting');
    expect(ph(43200, 604800, 43080)).toBe('warning');
    expect(ph(43200, 604800, 43199)).toBe('warning');
    expect(ph(43200, 604800, 43200)).toBe('ended');
    expect(ph(43200, 604800, 50000)).toBe('ended');
    expect(ph(500, 400, 300)).toBe('waiting');
    expect(ph(500, 400, 380)).toBe('waiting');
    expect(ph(500, 400, 400)).toBe('ended'); // the 7-day limit first: no warning, not even in the last 120 s
    expect(ph(200, 200, 100)).toBe('waiting'); // equal deadlines: the 7-day limit cannot be extended, so no warning
  });

  it('UX-43: stayOutcome sorts the session read', () => {
    expect(stayOutcome(200, { user: { name: 'A' } }, 10)).toBe('extended');
    expect(stayOutcome(200, null, 10)).toBe('ended');
    expect(stayOutcome(200, {}, 10)).toBe('ended');
    expect(stayOutcome(200, { user: null }, 10)).toBe('ended');
    expect(stayOutcome(200, { user: {} }, 0)).toBe('ended'); // the 7-day counter has reached 0
    for (const s of [429, 500, 503, 401, 302]) expect(stayOutcome(s, { user: {} }, 10), String(s)).toBe('failed');
    expect(stayOutcome('network', null, 10)).toBe('failed');
    for (const b of [undefined, '<html>', 1, true, []]) expect(stayOutcome(200, b, 10), JSON.stringify(b)).toBe('failed'); // not what next-auth answers
  });

  it('UX-43: an extended read stays extended when it settles after the local deadline', () => {
    // The page counts the deadline 5 s early and the server accepts the token up to exp + 15 s
    // (node_modules/@auth/core/jwt.js:79), so a read that is answered with a session near the deadline
    // is a session that has just been re-signed. The server's answer decides, not the local clock.
    const late = idlePhase({ secondsLeft: 600, absoluteSecondsLeft: 100000, elapsedSeconds: 603 });
    expect(late).toBe('ended');
    expect(settleStay(stayOutcome(200, { user: { name: 'A' } }, 99397), late)).toBe('extended');
    // The same answer before the deadline is of course extended too.
    expect(settleStay('extended', 'warning')).toBe('extended');
  });

  it('UX-43: a failed read that settles after the local deadline is ended, and before it stays failed', () => {
    for (const s of [503, 429, 'network'] as const) {
      const outcome = stayOutcome(s, null, 99397);
      expect(outcome, String(s)).toBe('failed');
      expect(settleStay(outcome, 'ended'), String(s)).toBe('ended');
      expect(settleStay(outcome, 'warning'), String(s)).toBe('failed');
      expect(settleStay(outcome, 'waiting'), String(s)).toBe('failed');
    }
    // An answer of 'ended' is ended whenever it settles.
    for (const phase of ['waiting', 'warning', 'ended'] as const) expect(settleStay('ended', phase), phase).toBe('ended');
  });

  it('UX-43: msToNextPhase waits for the warning, then for the end, and stops once ended', () => {
    const at = (secondsLeft: number, absoluteSecondsLeft: number, elapsedSeconds: number) =>
      msToNextPhase({ secondsLeft, absoluteSecondsLeft, elapsedSeconds });
    // waiting, idle deadline first: the next boundary is the start of the warning
    expect(at(43200, 604800, 0)).toBeGreaterThanOrEqual((43200 - 120) * 1000);
    expect(at(43200, 604800, 0)).toBeLessThan((43200 - 120) * 1000 + 1000);
    expect(at(43200, 604800, 43000)).toBeLessThan(81 * 1000);
    // warning: the next boundary is the end
    expect(at(43200, 604800, 43100)).toBeGreaterThanOrEqual(100 * 1000);
    expect(at(43200, 604800, 43100)).toBeLessThan(101 * 1000);
    // the 7-day limit first: no warning boundary at all, the end is the boundary
    expect(at(500, 400, 300)).toBeGreaterThanOrEqual(100 * 1000);
    expect(at(500, 400, 300)).toBeLessThan(101 * 1000);
    // ended: nothing left to wait for
    expect(at(43200, 604800, 43200)).toBeNull();
    expect(at(500, 400, 401)).toBeNull();
    // never beyond what a browser timer can hold
    expect(at(2 ** 40, 2 ** 41, 0)).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('UX-43: withMargin takes 5 s off both deadlines, so their order does not change, and never goes below 0', () => {
    expect(IDLE_MARGIN_SECONDS).toBe(5);
    expect(withMargin({ secondsLeft: 43200, absoluteSecondsLeft: 604800 })).toEqual({ secondsLeft: 43195, absoluteSecondsLeft: 604795 });
    expect(withMargin({ secondsLeft: 3, absoluteSecondsLeft: 9 })).toEqual({ secondsLeft: 0, absoluteSecondsLeft: 4 });
    expect(withMargin({ secondsLeft: 3, absoluteSecondsLeft: 2 })).toEqual({ secondsLeft: 0, absoluteSecondsLeft: 0 });
  });

  it('UX-43 NFR-SEC-07 (U-S1): when the real idle deadline falls 1 to 5 s after the 7-day limit, the margin does not flip them and there is no warning', () => {
    for (const gap of [1, 3, 5]) {
      const margined = withMargin({ secondsLeft: 400 + gap, absoluteSecondsLeft: 400 });
      expect(idlePhase({ ...margined, elapsedSeconds: 300 }), `gap ${gap}`).toBe('waiting');
    }
  });
});

describe('the session read and the tab channel', () => {
  it('UX-43: readSessionResponse treats a non-JSON, redirected or unparsable answer as a network failure', async () => {
    const json = { 'content-type': 'application/json' };
    expect(await readSessionResponse(new Response('{"user":{}}', { status: 200, headers: json }))).toEqual({ status: 200, body: { user: {} } });
    expect(await readSessionResponse(new Response('null', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }))).toEqual({
      status: 200,
      body: null,
    });
    expect(await readSessionResponse(new Response('{"error":"x"}', { status: 503, headers: json }))).toEqual({ status: 503, body: { error: 'x' } });
    for (const bad of [
      new Response('<html>portal</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{bad', { status: 200, headers: json }),
      new Response('', { status: 200 }),
    ]) {
      expect(await readSessionResponse(bad)).toEqual({ status: 'network', body: null });
    }
    const redirected = new Response('null', { status: 200, headers: json });
    Object.defineProperty(redirected, 'redirected', { value: true });
    expect(await readSessionResponse(redirected)).toEqual({ status: 'network', body: null });
    const portal = await readSessionResponse(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(stayOutcome(portal.status, portal.body, 10)).toBe('failed'); // a captive-portal page is never 'ended'
  });

  it('UX-43: acceptIdleMessage accepts only two finite integers inside their limits', () => {
    const ok = { secondsLeft: 43200, absoluteSecondsLeft: 600000 };
    expect(acceptIdleMessage(ok, 43200)).toEqual(ok);
    expect(acceptIdleMessage({ secondsLeft: 0, absoluteSecondsLeft: 0 }, 43200)).toEqual({ secondsLeft: 0, absoluteSecondsLeft: 0 });
    for (const bad of [
      null,
      undefined,
      'x',
      5,
      [],
      {},
      { secondsLeft: 1 },
      { absoluteSecondsLeft: 1 },
      { secondsLeft: NaN, absoluteSecondsLeft: 1 },
      { secondsLeft: 1, absoluteSecondsLeft: Infinity },
      { secondsLeft: 1.5, absoluteSecondsLeft: 1 },
      { secondsLeft: '5', absoluteSecondsLeft: 1 },
      { secondsLeft: -1, absoluteSecondsLeft: 1 },
      { secondsLeft: 43201, absoluteSecondsLeft: 1 },
      { secondsLeft: 1, absoluteSecondsLeft: ABSOLUTE_SESSION_SECONDS + 1 },
    ]) {
      expect(acceptIdleMessage(bad, 43200), JSON.stringify(bad)).toBeNull();
    }
    expect(acceptIdleMessage({ secondsLeft: 181, absoluteSecondsLeft: 1 }, 180)).toBeNull(); // longer than this tab's own limit
  });

  it('UX-43: signInAgainHref sends the person back to the same path and query, and only as a relative address', () => {
    expect(signInAgainHref('/orgs/acme/dashboard', '')).toBe('/login?callbackUrl=%2Forgs%2Facme%2Fdashboard');
    expect(signInAgainHref('/orgs/acme/projects', '?shown=40')).toBe('/login?callbackUrl=%2Forgs%2Facme%2Fprojects%3Fshown%3D40');
    // The path is encoded as one value, so it cannot add a second parameter.
    expect(signInAgainHref('/a', '?x=1&callbackUrl=https://evil.example')).toBe(
      '/login?callbackUrl=%2Fa%3Fx%3D1%26callbackUrl%3Dhttps%3A%2F%2Fevil.example',
    );
  });
});

describe('ABSOLUTE_SESSION_SECONDS and staying signed in', () => {
  const user = { id: 'user-1', sessionEpoch: 3 } as User & { sessionEpoch: number };
  const nowS = () => Math.floor(Date.now() / 1000);

  it('UX-43 NFR-SEC-07: ABSOLUTE_SESSION_SECONDS is the limit resolveIdentity enforces', async () => {
    expect(ABSOLUTE_SESSION_SECONDS).toBe(604800);
    const stamped = (age: number) => ({ id: 'user-1', sessionEpoch: 3, sessionIssuedAt: nowS() - age });
    await expect(resolveIdentity(stamped(ABSOLUTE_SESSION_SECONDS + 1))).rejects.toThrow('absolute session lifetime exceeded');
    await expect(resolveIdentity(stamped(ABSOLUTE_SESSION_SECONDS - 60))).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('UX-43 NFR-SEC-07: staying signed in never moves sessionIssuedAt or the 7-day limit', async () => {
    const signedIn = await jwtCallback({ token: {} as JWT, user });
    const later = await jwtCallback({ token: signedIn }); // the session read that Stay signed in triggers
    expect(later.sessionIssuedAt).toBe(signedIn.sessionIssuedAt);

    // A token whose stamp is older than 7 days is refused before any database read.
    const tooOld = { ...later, sessionIssuedAt: nowS() - 7 * 24 * 3600 - 1 };
    await expect(resolveIdentity(tooOld)).rejects.toBeInstanceOf(SessionError);
  });

  it('UX-43 NFR-SEC-07: only the sign-in branch of the jwt callback writes sessionIssuedAt, and Stay signed in sends one plain GET', () => {
    // Another writer would be a second way past the 7-day limit; the test above cannot see one.
    // A reader that copies the claim into another object (identity.ts) is not a writer.
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          /\.sessionIssuedAt\s*=[^=]|sessionIssuedAt:(?!\s*[\w.]*sessionIssuedAt)(?!\s*(?:number|unknown))\s*\S/.test(stripComments(readFileSync(path, 'utf8')))
        ) {
          writers.push(path);
        }
      }
    };
    for (const root of ['app', 'lib', 'components']) walk(root);
    expect(writers).toEqual(['lib/auth/callbacks.ts']);
  });
});

describe('IdleWarning', () => {
  it('UX-43: lib/auth/idle.ts imports nothing, so a client component can import it', () => {
    expect(stripComments(readFileSync('lib/auth/idle.ts', 'utf8'))).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
  });

  it('UX-43: IdleWarning renders a native dialog that carries the session deadline in its markup', () => {
    const html = renderToStaticMarkup(createElement(IdleWarning, { idleSeconds: 43200, secondsLeft: 600, absoluteSecondsLeft: 100000 }));
    // The seconds are on the wrapper (one per page), and the warning is the kit's native dialog inside it.
    expect(html).toMatch(/^<div class="shell-idle" data-seconds-left="600"><dialog class="ui-dialog"/);
    expect([...html.matchAll(/<dialog\b/g)]).toHaveLength(1);
    expect(html).toContain(IDLE_TEXTS.warningTitle);
    expect(html).toContain(IDLE_TEXTS.stay);
    expect(html).not.toMatch(/\brole=|aria-modal|\bopen(=|>|\s)/); // the platform keeps those; the dialog is closed in the server markup
    expect(html).not.toContain(IDLE_TEXTS.endedKept); // the signed-out notice is a later state, not server markup
  });

  it('UX-43: the signed-out notice is a non-modal alert with the B35 text and a link back to the same address', () => {
    const html = renderToStaticMarkup(createElement(IdleEndedNotice, { signInHref: '/login?callbackUrl=%2Forgs%2Facme%2Fdashboard', reason: null }));
    expect(html).toMatch(/^<div[^>]*role="alert"/);
    expect(html).toContain(IDLE_TEXTS.endedElsewhere);
    expect(html).toContain(IDLE_TEXTS.endedKept);
    expect(html).toMatch(new RegExp(`<a [^>]*href="/login\\?callbackUrl=%2Forgs%2Facme%2Fdashboard"[^>]*>${IDLE_TEXTS.signInAgain}</a>`));
    // Nothing that would make the page behind it unreachable.
    expect(html).not.toMatch(/<dialog|aria-modal|\binert\b/);
  });

  it('UX-43 NFR-PERF-05: the warning starts no request until Stay signed in is pressed', () => {
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    expect([...src.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(src).toMatch(
      /fetch\('\/api\/auth\/session',\s*\{\s*credentials:\s*'same-origin',\s*cache:\s*'no-store',\s*signal:\s*AbortSignal\.timeout\(30_000\)\s*\}\)/,
    );
    expect(src).not.toMatch(/method:|sendBeacon|XMLHttpRequest|EventSource|WebSocket/); // BroadcastChannel is allowed: it is not a request
    const handler = /async function stay\b[\s\S]*?\n {2}}\n/.exec(src)?.[0] ?? '';
    expect(handler).toContain("fetch('/api/auth/session'");
    expect(src.replace(handler, '')).not.toContain('fetch('); // not in an effect, a timer, the tick or a listener
  });

  it('UX-43: the warning meets the dialog guide: a cancel listener that keeps the platform behaviour, no key handler', () => {
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    // The warning is the kit's Dialog, which listens for the native cancel (Esc, the back gesture) and reports it as onClose;
    // IdleWarning passes an onClose that counts it as Stay signed in. Neither file prevents the event or handles a key.
    expect(src).toMatch(/<Dialog\b[\s\S]*?\bonClose=\{onBrowserClose\}/);
    expect(src).toMatch(/function onBrowserClose\(\)\s*\{[\s\S]*?void stay\(\);/);
    expect(src).not.toMatch(/preventDefault|keydown|onKeyDown|role="dialog"|aria-modal|focus-trap/i);
    expect(src).not.toContain('<dialog');
    const dialog = stripComments(readFileSync('components/ui/Dialog.tsx', 'utf8'));
    expect(dialog).toMatch(/onCancel=/);
    expect(dialog).not.toMatch(/preventDefault|keydown|onKeyDown|role="dialog"|aria-modal|focus-trap/i);
  });

  it('UX-43: the warning re-checks on a 15 s tick and on visibilitychange, pageshow, focus and online (source level; the e2e clock-jump case proves it works)', () => {
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    expect(src).toMatch(/setInterval\([\s\S]*?15_?000/);
    for (const ev of ['visibilitychange', 'pageshow', 'focus', 'online']) expect(src).toContain(`'${ev}'`);
  });

  it('UX-43: a settled read goes through settleStay, so the server decides and only a failure after the deadline is ended', () => {
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    expect(src).toMatch(/settleStay\(\s*stayOutcome\(/);
  });

  it('UX-43: the component keeps no page state to purge: no draft is removed, nothing is navigated, and its one storage is the signed-out hint', () => {
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    // SignOutWithDraftsGuard stays the only purge path (R-53); the 'ended' state leaves the page as it is. Plan 1B Task 4 (C12)
    // adds one storage: the signed-out hint in this tab's sessionStorage, written and removed only through lib/auth/idle.ts.
    expect(src).not.toMatch(/localStorage|indexedDB|location\.(assign|replace|href\s*=)|router\.(push|replace|refresh)|useRouter|location\.reload|signOut\(/);
    expect(src).not.toMatch(/sessionStorage/);   // reached only through lib/auth/idle.ts's tabStorage (code review B-1)
    expect(src).not.toMatch(/\.(setItem|removeItem|getItem|clear)\(/);
    const idle = stripComments(readFileSync('lib/auth/idle.ts', 'utf8'));
    expect(idle.match(/\.(setItem|removeItem)\(SIGNED_OUT_HINT_KEY/g)).toHaveLength(2);
    expect(idle.match(/\.(setItem|removeItem|getItem)\(/g)).toHaveLength(2);
  });

  it('UX-43: no comment in the shell and session files cites a path under records/ or reviews/ (AGENTS.md section 1 C7)', () => {
    for (const f of ['lib/auth.ts', 'lib/auth/idle.ts', 'lib/auth/idleDeadline.ts', 'components/layout/IdleWarning.tsx', 'components/layout/OfflineBanner.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/records\/plans|reviews\/fix-/);
    }
  });

  it('UX-43: no comment says the cookie is re-signed on every request or on every auth() call', () => {
    // A comment wraps across lines, so the comment markers and line breaks are folded into single spaces before matching.
    const flat = (f: string) => readFileSync(f, 'utf8').replace(/\s*\n\s*(\/\/|\*)?\s*/g, ' ');
    for (const f of ['lib/auth.ts', 'lib/auth/idle.ts', 'lib/auth/callbacks.ts', 'components/layout/IdleWarning.tsx']) {
      expect(flat(f), f).not.toMatch(/on every `?auth\(\)`? call|re-signs the cookie on every request|refreshes on activity/i);
    }
    // the dated note exists; the older sentences of the ADR stay as the record they are
    expect(readFileSync('docs/adr/0002-identity-and-account-linking.md', 'utf8')).toMatch(/Correction, 2026-10-30/);
  });
});
