import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMAIL_SHAPE_SOURCE,
  installConsoleRedaction,
  redactEmails,
  redactText,
} from '../../lib/redact';
import { logSecurityEvent } from '../../lib/security-logger';

/**
 * RL 2.3 / 7.12, P1: no email address in any server log line. Three layers hold it, and
 * each is tested on its own because each one fails differently:
 *
 *   1. `logSecurityEvent` redacts what it is handed (the audit trail).
 *   2. `installConsoleRedaction` redacts everything else that reaches `console.*`:
 *      provider error strings, Prisma's `Key (email)=(...)`, Next's own error printing.
 *   3. Postgres and nginx are outside the process and are covered elsewhere
 *      (the compose `command:`, and `makrai-email-scan.sh`).
 *
 * Every address below uses a reserved example domain.
 */

const OWNER = 'owner@example.org';
const NESTED = 'a.b+c@sub.example.co.ug';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
/** The part of a vitest spy this file uses. */
type Spy = { mock: { calls: unknown[][] }; mockRestore(): void };

/** A stand-in console that records what each method is finally called with. */
function fakeConsole(): { target: Pick<Console, ConsoleMethod>; seen: Record<ConsoleMethod, unknown[][]> } {
  const seen: Record<ConsoleMethod, unknown[][]> = { log: [], info: [], warn: [], error: [] };
  const target = {} as Pick<Console, ConsoleMethod>;
  for (const m of METHODS) target[m] = (...a: unknown[]) => void seen[m].push(a);
  return { target, seen };
}

describe('redactText', () => {
  it('replaces every address in a string and leaves the rest alone', () => {
    expect(redactText(`sent to ${OWNER} and ${NESTED}; ip 197.157.0.1`)).toBe(
      'sent to [email-redacted] and [email-redacted]; ip 197.157.0.1',
    );
  });

  it('does not touch things that only look a little like an address', () => {
    for (const s of ['pkg@1.2.3', 'user@localhost', 'a@b.c', '@example.org', 'no at sign.example.org']) {
      expect(redactText(s), s).toBe(s);
    }
  });

  it('is case-insensitive about the letters it accepts', () => {
    expect(redactText('Owner@Example.ORG')).toBe('[email-redacted]');
  });

  it('agrees with the plain expression on random text, so the speed guard changes nothing it should not', () => {
    // redactText splits on the characters an address is made of, so a long run cannot make
    // the expression quadratic. Inside the length cap that must be invisible: the same
    // result as running the expression over the whole string.
    const plain = (s: string): string => s.replace(new RegExp(EMAIL_SHAPE_SOURCE, 'g'), '[email-redacted]');
    const alphabet = ['a', 'Z', '0', '.', '-', '_', '%', '+', '@', '@', ' ', ',', '(', ')', 'co', 'org'];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2000; i += 1) {
      let s = '';
      const n = next() % 60;
      for (let j = 0; j < n; j += 1) s += alphabet[next() % alphabet.length];
      expect(redactText(s), JSON.stringify(s)).toBe(plain(s));
    }
  });

  it('stays linear on a long run of address characters', () => {
    // The expression alone is quadratic: 64k of "a" followed by "@" takes seconds in V8,
    // and a request header can be 16k. This runs on every log line, so an attacker who
    // controls a logged string must not control its cost.
    const hostile = ['a'.repeat(128_000) + '@', 'a'.repeat(128_000), 'a@' + 'b.'.repeat(64_000)];
    const started = Date.now();
    for (const s of hostile) redactText(s);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('redacts the whole of an address-shaped run too long to be an address', () => {
    // Not an address (RFC 5321 stops at 254 characters), but it carries an "@" and it
    // could hide one, so it goes rather than being scanned.
    const out = redactText(`x ${'a'.repeat(600)}@${'b'.repeat(600)}.com y`);
    expect(out).toBe('x [email-redacted] y');
  });
});

describe('redactEmails', () => {
  it('redacts an email anywhere in an entry', () => {
    const entry = {
      event: 'ORG_MEMBER_ACTION',
      details: {
        error: `You can only send testing emails to your own email address (${OWNER})`,
        nested: { to: [NESTED] },
      },
    };
    const out = JSON.stringify(redactEmails(entry));
    expect(out).not.toContain(OWNER);
    expect(out).not.toContain(NESTED);
    expect(out).toContain('[email-redacted]');
    // The sentence around the address survives, so the log still says what happened.
    expect(out).toContain('You can only send testing emails to your own email address (');
  });

  it('leaves ids and addresses intact', () => {
    const entry = { orgId: 'org_123', ip: '197.157.0.1' };
    expect(redactEmails(entry)).toEqual(entry);
  });

  it('returns a deep copy and never changes its argument', () => {
    const entry = { details: { to: [OWNER], n: 3, ok: true, none: null } };
    const out = redactEmails(entry) as typeof entry;
    expect(out).not.toBe(entry);
    expect(out.details).not.toBe(entry.details);
    expect(out.details.to).not.toBe(entry.details.to);
    expect(entry.details.to[0]).toBe(OWNER);
    expect(out.details).toMatchObject({ n: 3, ok: true, none: null });
  });

  it('redacts a key as well as a value', () => {
    const out = redactEmails({ [OWNER]: 1 }) as Record<string, number>;
    expect(Object.keys(out)).toEqual(['[email-redacted]']);
  });

  it('keeps whatever JSON.stringify would have written for a value with toJSON', () => {
    const when = new Date('2026-10-08T12:00:00.000Z');
    expect(JSON.stringify(redactEmails({ when }))).toBe(JSON.stringify({ when }));
    // And a toJSON that produces an address is redacted, not trusted.
    const sneaky = { toJSON: () => ({ who: OWNER }) };
    expect(JSON.stringify(redactEmails({ sneaky }))).not.toContain(OWNER);
  });

  it('survives a cycle and a very deep object instead of throwing from inside a logger', () => {
    const loop: Record<string, unknown> = { id: 'x' };
    loop.self = loop;
    expect(() => JSON.stringify(redactEmails(loop))).not.toThrow();

    let deep: Record<string, unknown> = { leaf: OWNER };
    for (let i = 0; i < 5000; i += 1) deep = { next: deep };
    const out = JSON.stringify(redactEmails(deep));
    expect(out).not.toContain(OWNER);
  });
});

describe('redactText and ops/host/email-shape.regex hold the same expression', () => {
  const file = readFileSync('ops/host/email-shape.regex', 'utf8');

  it('redactText and ops/host/email-shape.regex hold the same expression', () => {
    // D-09. makrai-email-scan.sh (and Task 22's export) read this file with grep -E, and
    // redactText runs the same text through JavaScript. If the two ever differ, an
    // address one of them misses reaches the log or the export through the other.
    expect(file.replace(/\n$/, '')).toBe(EMAIL_SHAPE_SOURCE);
    expect(new RegExp(EMAIL_SHAPE_SOURCE).source).toBe(EMAIL_SHAPE_SOURCE);
  });

  it('the file is one line with no blank line, which grep -f would read as a pattern that matches everything', () => {
    expect(file.endsWith('\n')).toBe(true);
    expect(file.slice(0, -1)).not.toContain('\n');
    expect(file.trim()).not.toBe('');
  });
});

describe('logSecurityEvent', () => {
  const spies = {} as Record<ConsoleMethod, Spy>;

  beforeEach(() => {
    for (const m of METHODS) spies[m] = vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const m of METHODS) spies[m].mockRestore();
  });

  const written = (): string[] => METHODS.flatMap((m) => spies[m].mock.calls.map((c) => String(c[0])));

  it('redacts an email anywhere in an entry', () => {
    logSecurityEvent('ORG_MEMBER_ACTION', 'error', {
      userId: 'user_1',
      details: {
        error: `You can only send testing emails to your own email address (${OWNER})`,
        nested: { to: [NESTED] },
      },
    });
    const [line] = written();
    expect(line).not.toContain(OWNER);
    expect(line).not.toContain(NESTED);
    expect(line).toContain('[email-redacted]');
    expect(JSON.parse(line)).toMatchObject({ event: 'ORG_MEMBER_ACTION', level: 'error', userId: 'user_1' });
  });

  it('redacts the user agent and the ip field too, not only details', () => {
    logSecurityEvent('RATE_LIMIT_EXCEEDED', 'warn', { userAgent: `crawler (+mailto:${OWNER})`, ip: '197.157.0.1' });
    const [line] = written();
    expect(line).not.toContain(OWNER);
    expect(JSON.parse(line)).toMatchObject({ ip: '197.157.0.1' });
  });

  it('writes the same JSON as before for an entry with no address (P3)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', {
      userId: 'user_1',
      ip: '197.157.0.1',
      details: { attempts: 2, reason: 'wrong_password' },
    });
    expect(written()).toEqual([
      '{"timestamp":"2026-10-08T12:00:00.000Z","level":"warn","event":"AUTH_LOGIN_FAILURE","userId":"user_1","ip":"197.157.0.1","details":{"attempts":2,"reason":"wrong_password"}}',
    ]);
  });

  it('keeps userId and attempts, which are how a brute force is traced (P2)', () => {
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: 'user_1', details: { attempts: 4 } });
    expect(JSON.parse(written()[0])).toMatchObject({ userId: 'user_1', details: { attempts: 4 } });
  });
});

describe('installConsoleRedaction', () => {
  it('console redaction covers error objects', () => {
    const { target, seen } = fakeConsole();
    installConsoleRedaction(target);
    // The shape Prisma gives a duplicate key, which the registration route prints.
    target.error('Registration error:', new Error('Key (email)=(a@b.co) already exists'));
    const text = seen.error.map((a) => a.join(' ')).join('\n');
    expect(text).not.toContain('a@b.co');
    expect(text).toContain('[email-redacted]');
    expect(text).toContain('Registration error:');
  });

  it('covers log, info, warn and error, and objects and format strings, not only strings', () => {
    const { target, seen } = fakeConsole();
    installConsoleRedaction(target);
    for (const m of METHODS) {
      target[m]({ to: OWNER }, 'and %s', NESTED);
      expect(seen[m]).toHaveLength(1);
      // One finished string, so nothing downstream can format an address back in.
      expect(seen[m][0]).toHaveLength(1);
      const out = String(seen[m][0][0]);
      expect(out, m).not.toContain(OWNER);
      expect(out, m).not.toContain(NESTED);
      expect(out, m).toContain('[email-redacted]');
    }
  });

  it('prints what the original printed when there is nothing to redact', () => {
    const { target, seen } = fakeConsole();
    installConsoleRedaction(target);
    target.log('health: database check failed (timeout)', 42);
    expect(seen.log).toEqual([['health: database check failed (timeout) 42']]);
  });

  it('is safe to call twice: a second call does not wrap the wrapper', () => {
    const { target, seen } = fakeConsole();
    installConsoleRedaction(target);
    const first = target.error;
    installConsoleRedaction(target);
    expect(target.error).toBe(first);
    target.error(OWNER);
    expect(seen.error).toEqual([['[email-redacted]']]);
  });
});

describe('instrumentation', () => {
  // register() replaces the global console methods. Put them back, whatever happens.
  const saved = {} as Record<ConsoleMethod, Console[ConsoleMethod]>;
  beforeEach(() => {
    for (const m of METHODS) saved[m] = console[m];
    vi.resetModules();
  });
  afterEach(() => {
    for (const m of METHODS) console[m] = saved[m];
    vi.doUnmock('../../lib/data/connection');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Replaces console.error with a recorder BEFORE register() wraps it, so what it records is what would be printed. */
  function recordError(): unknown[][] {
    const printed: unknown[][] = [];
    console.error = (...a: unknown[]) => void printed.push(a);
    return printed;
  }

  it('instrumentation installs console redaction in the node runtime', async () => {
    vi.doMock('../../lib/data/connection', () => ({ verifyDatabaseRoles: async () => {} }));
    const printed = recordError();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await register();
    console.error(`provider said: ${OWNER}`);
    expect(printed).toEqual([['provider said: [email-redacted]']]);
  });

  it('installs it before the role check runs, so the check\'s own output is redacted', async () => {
    vi.doMock('../../lib/data/connection', () => ({
      verifyDatabaseRoles: async () => {
        console.error(`role check connected as ${OWNER}`);
      },
    }));
    const printed = recordError();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await register();
    expect(printed).toEqual([['role check connected as [email-redacted]']]);
  });

  it('redacts the refusal it prints when the role check fails, and still exits 1', async () => {
    vi.doMock('../../lib/data/connection', () => ({
      verifyDatabaseRoles: async () => {
        throw new Error(`password authentication failed for user "${OWNER}"`);
      },
    }));
    const printed = recordError();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await expect(register()).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    const text = printed.map((a) => a.join(' ')).join('\n');
    expect(text).toContain('Refusing to start: the database role check failed.');
    expect(text).not.toContain(OWNER);
    expect(text).toContain('[email-redacted]');
  });

  it('leaves the console alone in the edge runtime, which has no node:util', async () => {
    vi.doMock('../../lib/data/connection', () => ({ verifyDatabaseRoles: async () => {} }));
    const printed = recordError();
    const before = console.error;
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('../../instrumentation');
    await register();
    expect(console.error).toBe(before);
    console.error(OWNER);
    expect(printed).toEqual([[OWNER]]);
  });
});
