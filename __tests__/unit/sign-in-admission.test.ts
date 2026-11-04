import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, scanLines } from '../helpers/logCapture';
import {
  admitSignIn,
  COMPARISON_SLOTS,
  RESERVED_FOR_KNOWN,
  resetSignInAdmission,
  SIGN_IN_CEILING_PER_MINUTE,
  SLOT_WAIT_MS,
} from '../../lib/auth/signInAdmission';
import { KNOWN_DEVICE_COOKIE, signKnownDevice } from '../../lib/auth/knownDevice';

/**
 * The comparison budget and the process-wide ceiling of the sign-in route (FR-ACC-05, calls R-2 and R-49; obligation B5).
 * `run` stands for the work behind the admission: `hold` keeps its slot until `release()`, `instant` answers at once.
 */
const URL_ = 'http://localhost/api/auth/callback/credentials';
const plain = () => new Request(URL_, { method: 'POST' });
const withKnownDevice = () => {
  const { value } = signKnownDevice({ deviceId: 'd1', userId: 'u1' }, new Date());
  return new Request(URL_, { method: 'POST', headers: { cookie: `${KNOWN_DEVICE_COOKIE}=${value}` } });
};
const ok = () => new Response('{}', { status: 200 });
const instant = async () => ok();
let gate: { promise: Promise<void>; open: () => void };
const newGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};
const hold = async () => { await gate.promise; return ok(); };
const release = () => gate.open();

beforeEach(() => {
  resetSignInAdmission();
  gate = newGate();
});
afterEach(() => {
  release();
  resetSignInAdmission();
});

describe('sign-in admission (FR-ACC-05)', () => {
  it('FR-ACC-05: the budget is 4 comparisons, one reserved for known devices, a 2 s wait and 300 a minute', () => {
    expect([COMPARISON_SLOTS, RESERVED_FOR_KNOWN, SLOT_WAIT_MS, SIGN_IN_CEILING_PER_MINUTE]).toEqual([4, 1, 2000, 300]);
  });

  it('FR-ACC-05: a fifth concurrent comparison waits and answers 503 sign_in_busy after 2 s', async () => {
    const held = Array.from({ length: 3 }, () => admitSignIn(plain(), hold)); // 3 general slots
    const known = admitSignIn(withKnownDevice(), hold); // the reserved slot
    const t0 = Date.now();
    const r = await admitSignIn(plain(), instant);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'Sign-in is busy. Try again in a minute.', code: 'sign_in_busy', url: expect.stringMatching(/^https?:\/\/.+\/login\?error=sign_in_busy$/) });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    release();
    expect((await Promise.all([...held, known])).map((x) => x.status)).toEqual([200, 200, 200, 200]);
  });

  it('FR-ACC-05: a waiting request takes a slot as soon as one is released', async () => {
    const held = Array.from({ length: 3 }, () => admitSignIn(plain(), hold));
    const waiting = admitSignIn(plain(), instant);
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect((await waiting).status).toBe(200);
    await Promise.all(held);
  });

  it('FR-ACC-05: the slot is released when the work throws', async () => {
    for (let i = 0; i < COMPARISON_SLOTS + 2; i++) {
      await expect(admitSignIn(plain(), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    expect((await admitSignIn(plain(), instant)).status).toBe(200);
  });

  it('FR-ACC-05: a known device signs in while unauthenticated clients use the whole ceiling', async () => {
    for (let i = 0; i < 300; i++) expect((await admitSignIn(plain(), instant)).status).toBe(200);
    const refused = await admitSignIn(plain(), instant);
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body).toMatchObject({ code: 'rate_limited', url: expect.stringMatching(/^https?:\/\/.+\/login\?error=rate_limited$/) });
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(refused.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
    expect((await admitSignIn(withKnownDevice(), instant)).status).toBe(200);
  });

  it('FR-ACC-05: the ceiling is per fixed minute', async () => {
    let t = Date.parse('2026-11-02T08:00:00Z');
    const now = () => t;
    for (let i = 0; i < 300; i++) await admitSignIn(plain(), instant, { now });
    expect((await admitSignIn(plain(), instant, { now })).status).toBe(429);
    t += 60_000;
    expect((await admitSignIn(plain(), instant, { now })).status).toBe(200);
  });

  it('FR-ACC-05: general requests never take the reserved slot', async () => {
    const held = Array.from({ length: 3 }, () => admitSignIn(plain(), hold));
    let generalDone = false;
    const general = admitSignIn(plain(), instant).then((r) => { generalDone = true; return r; });
    const t0 = Date.now();
    const known = await admitSignIn(withKnownDevice(), instant);
    expect(known.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(generalDone).toBe(false);
    release();
    expect((await general).status).toBe(200);
    await Promise.all(held);
  });

  it('NFR-OBS-01: the ceiling logs RATE_LIMIT_EXCEEDED once per window with no email', async () => {
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 305; i++) await admitSignIn(plain(), instant);
    });
    const events = lines.filter((l) => l.includes('RATE_LIMIT_EXCEEDED'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0])).toMatchObject({ event: 'RATE_LIMIT_EXCEEDED', level: 'warn', details: { limit: 300 } });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });
});

describe('the slot can be given back before the work ends (B5 with the refusal floor)', () => {
  it('FR-ACC-05: releaseComparisonSlot inside the work frees its slot at once, and only once', async () => {
    const { releaseComparisonSlot } = await import('../../lib/auth/signInAdmission');
    // Three general requests that give their slot back, then keep waiting (as a refusal waits out its floor).
    const held = Array.from({ length: 3 }, () => admitSignIn(plain(), async () => {
      releaseComparisonSlot();
      releaseComparisonSlot(); // idempotent: a second call frees nothing more
      await gate.promise;
      return ok();
    }));
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const more = await Promise.all(Array.from({ length: 3 }, () => admitSignIn(plain(), instant)));
    expect(more.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(Date.now() - t0).toBeLessThan(500);
    release();
    await Promise.all(held);
    // Every slot is free again: four held requests fit, a fifth general one would not.
    gate = newGate();
    const four = [...Array.from({ length: 3 }, () => admitSignIn(plain(), hold)), admitSignIn(withKnownDevice(), hold)];
    release();
    expect((await Promise.all(four)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });

  it('FR-ACC-05: outside an admitted request releaseComparisonSlot does nothing', async () => {
    const { releaseComparisonSlot } = await import('../../lib/auth/signInAdmission');
    expect(() => releaseComparisonSlot()).not.toThrow();
  });
});
