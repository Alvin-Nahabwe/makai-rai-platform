import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boot check of instrumentation.ts (FR-ACC-02, SRS 6.7): a server whose legal texts cannot be
 * loaded refuses to start, by exiting, as the role check does (instrumentation.ts: a rejected
 * register() leaves Next 16 answering 500 forever). It reads no words of any text.
 */

const KINDS = ['terms', 'privacy', 'cross-border-consent', 'organisation-agreement'] as const;

/** process.exit throws so the test process survives; console.error is recorded (identity-lane.test.ts). */
function stubExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, logged };
}

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const;
const saved = {} as Record<(typeof CONSOLE)[number], Console[(typeof CONSOLE)[number]]>;

beforeEach(() => {
  // register() installs the console redaction; put the console back after each case.
  for (const m of CONSOLE) saved[m] = console[m];
  vi.resetModules();
  vi.doMock('@/lib/data/connection', () => ({ verifyDatabaseRoles: async () => {} }));
});
afterEach(() => {
  vi.doUnmock('@/lib/data/connection');
  vi.doUnmock('@/lib/legal/registry');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const m of CONSOLE) console[m] = saved[m];
});

describe('register() refuses to start without the legal texts (FR-ACC-02)', () => {
  it('FR-ACC-02: register() exits 1 and names the legal texts when the registry cannot load', async () => {
    vi.doMock('@/lib/legal/registry', () => { throw new Error('simulated: legal text terms/1.md is malformed'); });
    const { exit, logged } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await expect(register()).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('Refusing to start: the legal texts could not be loaded.');
  });

  it('FR-ACC-02: register() asks for the current text of every kind in order, then resolves', async () => {
    const asked: string[] = [];
    vi.doMock('@/lib/legal/registry', () => ({ LEGAL_KINDS: KINDS, currentLegalText: (k: string) => { asked.push(k); return {}; } }));
    const { exit } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await expect(register()).resolves.toBeUndefined();
    expect(asked).toEqual(['terms', 'privacy', 'cross-border-consent', 'organisation-agreement']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('FR-ACC-02: register() exits 1 when one kind has no current text', async () => {
    vi.doMock('@/lib/legal/registry', () => ({ LEGAL_KINDS: KINDS, currentLegalText: (k: string) => {
      if (k === 'organisation-agreement') throw new Error(`no legal text of kind ${k}`);
      return {};
    } }));
    const { exit, logged } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('../../instrumentation');
    await expect(register()).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/^Refusing to start: the legal texts could not be loaded\. \S*Error: no legal text of kind organisation-agreement/);
  });
});
