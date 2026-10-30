import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JWT } from 'next-auth/jwt';
import type { User } from 'next-auth';
import { IDLE_WARNING_SECONDS, idleLimitSeconds } from '@/lib/auth/idle';
import { warningDelayMs } from '@/components/layout/IdleWarning';
import { jwtCallback } from '@/lib/auth/callbacks';
import { resolveIdentity, SessionError } from '@/lib/auth/identity';

/**
 * UX-43 (SRS 7.6.1, line 2645; WCAG 2.2.1): two minutes before the 12-hour idle
 * sign-out the page warns and offers "Stay signed in". Preventive obligations
 * U-S1, U-S2 and U-S7 of the unit brief are proved here; the browser half is in
 * e2e/idle-warning.spec.ts and e2e/shell-checks.spec.ts.
 */

const TWELVE_HOURS = 43200;

/** NodeJS.ProcessEnv in this project requires NODE_ENV; a test env holds only the variables under test. */
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

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
    const source = readFileSync('lib/auth/idle.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
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

describe('IdleWarning timing', () => {
  it('UX-43: the warning opens two minutes before the limit, at the real limit and at the shortest test limit', () => {
    expect(warningDelayMs(TWELVE_HOURS)).toBe((TWELVE_HOURS - 120) * 1000);
    expect(warningDelayMs(180)).toBe(60 * 1000);
    // 43,080,000 ms is inside the 2^31 - 1 ms a browser timer can hold.
    expect(warningDelayMs(TWELVE_HOURS)).toBeLessThan(2 ** 31 - 1);
  });
});

describe('staying signed in', () => {
  const user = { id: 'user-1', sessionEpoch: 3 } as User & { sessionEpoch: number };
  const nowS = () => Math.floor(Date.now() / 1000);

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
        else if (/\.(ts|tsx)$/.test(name) && /\.sessionIssuedAt\s*=[^=]|sessionIssuedAt:(?!\s*[\w.]*sessionIssuedAt)(?!\s*(?:number|unknown))\s*\S/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, ''))) {
          writers.push(path);
        }
      }
    };
    for (const root of ['app', 'lib', 'components']) walk(root);
    expect(writers).toEqual(['lib/auth/callbacks.ts']);

    const warning = readFileSync('components/layout/IdleWarning.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    expect([...warning.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(warning).toMatch(/fetch\('\/api\/auth\/session',\s*\{\s*credentials:\s*'same-origin'\s*\}\)/);
    expect(warning).not.toMatch(/method:/);
    expect(warning).not.toMatch(/sendBeacon|XMLHttpRequest|EventSource|WebSocket/);
  });

  it('UX-43 NFR-PERF-05: the warning starts no request until Stay signed in is pressed', () => {
    const warning = readFileSync('components/layout/IdleWarning.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    // The one fetch sits inside the click handler, not in an effect or a timer callback.
    const handler = /async function stayHandler\b[\s\S]*?\n  }\n/.exec(warning)?.[0] ?? '';
    expect(handler).toContain("fetch('/api/auth/session'");
    expect(warning.replace(handler, '')).not.toContain('fetch(');
  });
});
