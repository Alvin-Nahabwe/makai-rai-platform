import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'next-auth/jwt';
import { ABSOLUTE_SESSION_SECONDS } from '@/lib/auth/idle';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';
import { requireAuthSecret } from '@/lib/auth/secret';

/**
 * UX-43 (SRS line 2645): the idle warning follows the session cookie's own expiry, which only
 * sign-in and a read of GET /api/auth/session move (@auth/core 0.41.3 lib/actions/session.js:21-52).
 * `readSessionDeadlines` is the one server function that decrypts the cookie for that purpose, and it
 * hands back two numbers and nothing else (ADR-0002; NFR-SEC-07, SRS line 2937). The test file is
 * outside the scan of app/** and lib/** (__tests__/lint/no-raw-session-token.test.ts), so it can use `encode`
 * from next-auth/jwt to make cookies the app would write.
 */

const nowS = () => Math.floor(Date.now() / 1000);
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const cookieFor = async (claims: Record<string, unknown>, name = 'authjs.session-token', maxAge = 180) =>
  `${name}=${await encode({ token: claims, secret: requireAuthSecret(), salt: name, maxAge })}`;

// vitest.config.ts sets NEXTAUTH_URL to an https address, so the plain cookie name is read only when
// the cases below say http. Both variables are restored so no other file sees the change.
let originalNextAuthUrl: string | undefined;
let originalAuthUrl: string | undefined;

beforeEach(() => {
  originalNextAuthUrl = process.env.NEXTAUTH_URL;
  originalAuthUrl = process.env.AUTH_URL;
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  delete process.env.AUTH_URL;
});

afterEach(() => {
  if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
});

describe('readSessionDeadlines', () => {
  it('UX-43: readSessionDeadlines reads exp and sessionIssuedAt from the cookie the app writes', async () => {
    const r = await readSessionDeadlines(new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() - 100 }) }));
    expect(r!.secondsLeft).toBeGreaterThanOrEqual(179);
    expect(r!.secondsLeft).toBeLessThanOrEqual(180);
    // From sessionIssuedAt, not from the envelope's iat, which every re-encode resets.
    expect(Math.abs(r!.absoluteSecondsLeft - (ABSOLUTE_SESSION_SECONDS - 100))).toBeLessThanOrEqual(1);
    const later = await readSessionDeadlines(new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() }) }), nowS() + 100);
    expect(later!.secondsLeft).toBeGreaterThanOrEqual(79);
    expect(later!.secondsLeft).toBeLessThanOrEqual(80); // nowSeconds is the clock
  });

  it('UX-43: readSessionDeadlines reads the __Secure- cookie under https and not the plain one (DEP-04)', async () => {
    process.env.NEXTAUTH_URL = 'https://x.example';
    delete process.env.AUTH_URL;
    expect(
      await readSessionDeadlines(new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() }, '__Secure-authjs.session-token') })),
    ).not.toBeNull();
    // The wrong name reads as signed out, which is the silent failure the cookie-name case exists for.
    expect(await readSessionDeadlines(new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() }) }))).toBeNull();
  });

  it('UX-43: readSessionDeadlines returns null for a missing or malformed claim, an expired token and a stamp older than 7 days', async () => {
    for (const h of [
      new Headers(),
      new Headers({ cookie: 'authjs.session-token=garbage' }),
      new Headers({ cookie: await cookieFor({ id: 'u1' }) }), // no sessionIssuedAt
      new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: 'x' }) }),
      new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: 1.5 }) }),
      new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() }, 'authjs.session-token', -60) }), // expired beyond the 15 s tolerance
      new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() - ABSOLUTE_SESSION_SECONDS - 1 }) }), // absoluteSecondsLeft would be 0 or less
    ]) {
      expect(await readSessionDeadlines(h)).toBeNull();
    }
  });

  it('UX-43: readSessionDeadlines returns null inside the 15 s the server still tolerates, because no time is left', async () => {
    // exp is 10 s ago: the server would still accept the token, but there is no deadline left to count down to.
    const stale = new Headers({ cookie: await cookieFor({ id: 'u1', sessionIssuedAt: nowS() }, 'authjs.session-token', -10) });
    expect(await readSessionDeadlines(stale)).toBeNull();
  });

  it('UX-43 NFR-SEC-07: readSessionDeadlines returns the two deadlines and no identity', async () => {
    const r = await readSessionDeadlines(
      new Headers({ cookie: await cookieFor({ id: 'u1', email: 'a@x', sessionEpoch: 3, sessionIssuedAt: nowS() }) }),
    );
    expect(Object.keys(r!).sort()).toEqual(['absoluteSecondsLeft', 'secondsLeft']);
    expect(JSON.stringify(r)).not.toMatch(/u1|a@x/);
  });
});

describe('who imports the deadline reader', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  for (const root of ['app', 'lib', 'components']) walk(root);

  const importsDeadline = (source: string) => /from\s+['"](@\/lib\/auth\/idleDeadline|(\.{1,2}\/)+(lib\/)?(auth\/)?idleDeadline)['"]/.test(source);

  it('UX-43 NFR-SEC-07: only server pages import lib/auth/idleDeadline.ts, and no client component does', () => {
    // The file reads the session cookie, so it must stay out of the client bundle (it is "server only" in
    // the contract). The importers are the signed-in layout and the not-found page; S-07 (app/page.tsx)
    // renders the warning too once its owner merges, so it is allowed and not required.
    const importers = files.filter((f) => f !== 'lib/auth/idleDeadline.ts' && importsDeadline(readFileSync(f, 'utf8'))).sort();
    const allowed = ['app/(authenticated)/layout.tsx', 'app/not-found.tsx', 'app/page.tsx'];
    for (const f of importers) expect(allowed, f).toContain(f);
    expect(importers).toEqual(expect.arrayContaining(['app/(authenticated)/layout.tsx', 'app/not-found.tsx']));
    for (const f of importers) expect(readFileSync(f, 'utf8'), f).not.toMatch(/^['"]use client['"]/m);
  });

  it('UX-43 NFR-SEC-07: the client component imports neither the deadline reader nor next-auth/jwt', () => {
    expect(existsSync('components/layout/IdleWarning.tsx')).toBe(true);
    // Its comments explain the cookie, so only the code is read.
    const src = stripComments(readFileSync('components/layout/IdleWarning.tsx', 'utf8'));
    expect(src).not.toMatch(/idleDeadline|next-auth|@auth\/core/);
  });
});
