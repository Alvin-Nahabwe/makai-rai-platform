import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compare } from 'bcryptjs';
import { testDb, resetDb } from '../helpers/db';
import { identityDb } from '../../lib/data/identity';
import { EMAIL_SHAPE_SOURCE } from '../../lib/redact';
import { main as seedMain } from '../../prisma/seed';

/**
 * T7d (final Plan 1b whole-branch review, 2026-08-05): `prisma/seed.ts`
 * printed "Admin user already exists ✅" and returned as soon as
 * `ADMIN_EMAIL` matched an existing row — WITHOUT checking or setting
 * `role: 'admin'`. If that row got there by registering through the UI
 * first (its role defaults to `assessor`, schema.prisma), the operator
 * ends the run believing they have a platform admin when they do not, with
 * no recovery path: promoting a user to admin requires an existing admin
 * to click the button in `/admin/users`.
 *
 * Drives the REAL exported `main()` from `prisma/seed.ts` against the real
 * `identityDb` — not a re-implementation of its logic.
 */

const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ORIGINAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

describe('prisma/seed.ts main() — platform admin bootstrap', () => {
  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  it('promotes a pre-existing non-admin user with the target email to admin', async () => {
    const email = 'seed-test-promote@fixture.test';
    process.env.ADMIN_EMAIL = email;

    // Simulates "someone registered through the UI first" — a real row,
    // created the same way registration creates one (role defaults to
    // 'assessor'), NOT an admin.
    const preExisting = await testDb.user.create({
      data: { email, name: 'Pre-existing user', passwordHash: 'x', role: 'assessor' },
    });
    expect(preExisting.role).toBe('assessor');

    await seedMain();

    const afterSeed = await identityDb.user.findUniqueOrThrow({ where: { email } });
    expect(afterSeed.id).toBe(preExisting.id); // same row, not a duplicate
    expect(afterSeed.role).toBe('admin');
  });

  it('is a no-op (does not error, does not duplicate) when the user is already admin', async () => {
    const email = 'seed-test-already-admin@fixture.test';
    process.env.ADMIN_EMAIL = email;

    const preExisting = await testDb.user.create({
      data: { email, name: 'Already admin', passwordHash: 'x', role: 'admin' },
    });

    await expect(seedMain()).resolves.not.toThrow();

    const afterSeed = await identityDb.user.findUniqueOrThrow({ where: { email } });
    expect(afterSeed.id).toBe(preExisting.id);
    expect(afterSeed.role).toBe('admin');
    const count = await testDb.user.count({ where: { email } });
    expect(count).toBe(1);
  });
});

/**
 * Human-partner decision (2026-08-05): stop shipping a working default
 * admin credential. Drives the real `main()` (not a re-implementation of
 * `resolveAdminPassword`) so these tests exercise exactly what an operator
 * running `npx prisma db seed` would hit.
 */
describe('prisma/seed.ts main() — admin password resolution', () => {
  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  it.each(['change-me-on-first-login', 'changeme123'])(
    'refuses to run when ADMIN_PASSWORD is the known-bad literal %j, and creates no user',
    async (badPassword) => {
      const email = `seed-test-refuse-${badPassword}@fixture.test`;
      process.env.ADMIN_EMAIL = email;
      process.env.ADMIN_PASSWORD = badPassword;

      await expect(seedMain()).rejects.toThrow(/known-bad/);

      const afterAttempt = await identityDb.user.findUnique({ where: { email } });
      expect(afterAttempt).toBeNull();
    },
  );

  it('refuses to run when ADMIN_PASSWORD is unset, names the variable, and creates no user', async () => {
    // RL 2.3 / 7.12: the seed used to generate a password and print it, and the migrator's
    // output goes to the host journal. A generated secret in a log is a secret in a log.
    const email = 'seed-test-unset@fixture.test';
    process.env.ADMIN_EMAIL = email;
    delete process.env.ADMIN_PASSWORD;

    await expect(seedMain()).rejects.toThrow(/ADMIN_PASSWORD/);
    await expect(identityDb.user.findUnique({ where: { email } })).resolves.toBeNull();
  });

  it('refuses an empty ADMIN_PASSWORD the same way', async () => {
    // `.env.example` used to say "leave it empty"; compose passes an unset variable as "".
    process.env.ADMIN_EMAIL = 'seed-test-empty@fixture.test';
    process.env.ADMIN_PASSWORD = '';
    await expect(seedMain()).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it('never puts the rejected password in the refusal', async () => {
    // The known-bad literals are public, but the rule is "no password value in any output".
    process.env.ADMIN_EMAIL = 'seed-test-literal@fixture.test';
    process.env.ADMIN_PASSWORD = 'change-me-on-first-login';
    await expect(seedMain()).rejects.toSatisfy((e: Error) => !e.message.includes('change-me-on-first-login'));
  });
});

/**
 * RL 2.3 / 7.12 (P1): the migrator container logs to the host journal, and `prisma/seed.ts`
 * printed `ADMIN_EMAIL` on every run (created, promoted and no-op alike) and, when
 * `ADMIN_PASSWORD` was unset, a generated password. The seed's output now has neither.
 */
describe('prisma/seed.ts prints no address and no password', () => {
  const EMAIL = 'seed-out-admin@example.test';
  // Generated per run: nothing in this file is a password literal.
  const PASSWORD = randomBytes(18).toString('base64url');
  const SHAPE = new RegExp(EMAIL_SHAPE_SOURCE);

  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  /** Everything `main()` writes to the console, in all four methods. */
  async function seedOutput(): Promise<string> {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await seedMain();
      return spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  }

  function expectClean(out: string): void {
    expect(out.length, 'the seed printed nothing at all, so this would pass vacuously').toBeGreaterThan(0);
    expect(SHAPE.test(out), `an email-shaped string in the output: ${out}`).toBe(false);
    expect(out.toLowerCase()).not.toContain(EMAIL);
    expect(out).not.toContain(PASSWORD);
  }

  it('on the create path', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
    const out = await seedOutput();
    expectClean(out);
    expect(out).toContain('Admin user created');
    // And the account really was created with that password.
    const row = await identityDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await expect(compare(PASSWORD, row.passwordHash)).resolves.toBe(true);
  });

  it('on the promote path', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
    await testDb.user.create({ data: { email: EMAIL, name: 'Pre-existing', passwordHash: 'x', role: 'assessor' } });
    const out = await seedOutput();
    expectClean(out);
    expect(out).toContain('promoted');
  });

  it('on the no-op path', async () => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
    await testDb.user.create({ data: { email: EMAIL, name: 'Already admin', passwordHash: 'x', role: 'admin' } });
    const out = await seedOutput();
    expectClean(out);
    expect(out).toContain('no-op');
  });

  describe('run as a script, the way the migrator runs it', () => {
    /** `npx tsx prisma/seed.ts`, against the test database, with its own environment. */
    function runSeed(env: Record<string, string | undefined>): { status: number | null; out: string } {
      const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
      const r = spawnSync('node_modules/.bin/tsx', ['prisma/seed.ts'], { env: merged, encoding: 'utf8', timeout: 90_000 });
      return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
    }

    it('creates the admin and prints neither the address nor the password', async () => {
      const r = runSeed({ ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD });
      expect(r.status, r.out).toBe(0);
      expectClean(r.out);
      expect(r.out).toContain('Database seeded successfully');
      await expect(identityDb.user.findUnique({ where: { email: EMAIL } })).resolves.not.toBeNull();
    });

    it('exits non-zero when ADMIN_PASSWORD is unset, says which variable, and creates nothing', async () => {
      const r = runSeed({ ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: undefined });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('ADMIN_PASSWORD');
      expectClean(r.out);
      expect(r.out).not.toMatch(/generated/i);
      await expect(identityDb.user.findUnique({ where: { email: EMAIL } })).resolves.toBeNull();
    });
  });

  it('installs the console redaction when run as a script, so an error from the database is redacted too', () => {
    // The migrator is not the Next server, so nothing else wraps its console. The script
    // path (the `import.meta.url` guard) is the one place that can.
    const source = readFileSync('prisma/seed.ts', 'utf8');
    const guard = source.slice(source.indexOf('if (import.meta.url'));
    expect(guard).toContain('installConsoleRedaction()');
    expect(guard.indexOf('installConsoleRedaction()')).toBeLessThan(guard.indexOf('main()'));
  });
});
