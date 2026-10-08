import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `scripts/provision-app-db-role.sh` is the only thing that sets a password on either
 * application role (ADR-0009). These tests run it for real, with psql replaced:
 *
 *   - `PSQL_CMD=cat` where the script must stop before psql is ever reached;
 *   - a stub that records its argv and echoes its stdin, where the test needs to read
 *     exactly what psql would have been sent.
 *
 * Every run starts from an EMPTY environment plus PATH, so a developer's own NODE_ENV,
 * APP_DB_PASSWORD or ALLOW_DEV_DB_PASSWORD cannot make a test pass or fail.
 */

const SCRIPT = 'scripts/provision-app-db-role.sh';
const ROLES = [
  { role: 'makrai_app', pwVar: 'APP_DB_PASSWORD', devPw: 'app_dev_password' },
  { role: 'makrai_identity', pwVar: 'IDENTITY_DB_PASSWORD', devPw: 'identity_dev_password' },
] as const;

/**
 * The refusal itself. Not just /ALLOW_DEV_DB_PASSWORD/: the script's notice when the flag
 * IS set also names the flag, so that pattern matched a run that went ahead — found by
 * disabling the guard and watching the PSQL_CMD=cat test stay green.
 */
const REFUSAL = /refusing to provision \S+ with the well-known dev password[^\n]*ALLOW_DEV_DB_PASSWORD=1/;

function run(args: string[], env: Record<string, string | undefined>) {
  const clean: Record<string, string | undefined> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  // Cast: Next's types make NODE_ENV a required key of ProcessEnv, and leaving it out
  // is the point of several tests below.
  return spawnSync('bash', [SCRIPT, ...args], { env: clean as NodeJS.ProcessEnv, encoding: 'utf8' });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A psql stand-in: writes its arguments to a file, copies stdin to stdout. */
function stubPsql() {
  const dir = mkdtempSync(join(tmpdir(), 'psql-stub-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const argvFile = join(dir, 'argv');
  const cmd = join(dir, 'psql');
  writeFileSync(cmd, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncat\n`);
  chmodSync(cmd, 0o755);
  return {
    cmd,
    argv: (): string[] | null =>
      existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) : null,
  };
}

describe('provision-app-db-role.sh refuses the well-known dev passwords', () => {
  it('refuses the dev default without ALLOW_DEV_DB_PASSWORD', () => {
    const r = run(['makrai_test'], { PSQL_CMD: 'cat' });
    expect(r.status).toBe(1);
    // The message is asserted, not only the exit code: with PSQL_CMD=cat a script that
    // DID proceed would also exit 1, when cat chokes on psql's arguments (observed
    // against the unfixed script: "cat: invalid option -- 'd'", exit 1).
    expect(r.stderr).toMatch(REFUSAL);
    expect(r.stdout).not.toMatch(/ALTER ROLE/);
  });

  it.each(ROLES.flatMap((r) => [undefined, 'development', 'test', 'production'].map((nodeEnv) => ({ ...r, nodeEnv }))))(
    'refuses $role with no password and no flag, whatever NODE_ENV says (NODE_ENV=$nodeEnv)',
    ({ role, nodeEnv }) => {
      const psql = stubPsql();
      const r = run(['makrai_test', role], { PSQL_CMD: psql.cmd, NODE_ENV: nodeEnv });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(REFUSAL);
      expect(psql.argv(), 'psql must never have been invoked').toBeNull();
    },
  );

  it.each(ROLES)('refuses the dev password for $role even when it is passed explicitly', ({ role, pwVar, devPw }) => {
    // The production failure this closes: deriving the password from a URL copied
    // out of .env.example provisions the published default.
    const psql = stubPsql();
    const r = run(['makrai_test', role], { PSQL_CMD: psql.cmd, [pwVar]: devPw });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(REFUSAL);
    expect(psql.argv()).toBeNull();
  });

  it.each(ROLES)('uses the dev default for $role only with ALLOW_DEV_DB_PASSWORD=1', ({ role, devPw }) => {
    const psql = stubPsql();
    const r = run(['makrai_test', role], { PSQL_CMD: psql.cmd, ALLOW_DEV_DB_PASSWORD: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`\\set pw '${devPw}'`);
    expect(r.stdout).toContain(`ALTER ROLE ${role} WITH PASSWORD :'pw';`);
  });

  it('reads only its own role’s variable', () => {
    // IDENTITY_DB_PASSWORD must not satisfy a makrai_app run, or one role's secret
    // would silently become the other's.
    const psql = stubPsql();
    const r = run(['makrai_test', 'makrai_app'], { PSQL_CMD: psql.cmd, IDENTITY_DB_PASSWORD: 'x'.repeat(64) });
    expect(r.status).toBe(1);
    expect(psql.argv()).toBeNull();
  });

  it('refuses a role it does not provision', () => {
    const r = run(['makrai_test', 'makrai'], { PSQL_CMD: 'cat', ALLOW_DEV_DB_PASSWORD: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/makrai_app or makrai_identity/);
  });
});

describe('provision-app-db-role.sh keeps the password out of argv and out of the server log', () => {
  const secret = 'c0ffee'.repeat(10) + "q'uote\\slash";

  function provision() {
    const psql = stubPsql();
    const r = run(['makrai_test', 'makrai_identity'], { PSQL_CMD: psql.cmd, IDENTITY_DB_PASSWORD: secret });
    expect(r.status, r.stderr).toBe(0);
    return { lines: r.stdout.split('\n'), argv: psql.argv(), stderr: r.stderr };
  }

  it('silences statement logging before ALTER ROLE', () => {
    const { lines } = provision();
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const alter = at(/^ALTER ROLE makrai_identity WITH PASSWORD :'pw';$/);
    expect(alter).toBeGreaterThan(-1);
    expect(lines.filter((l) => /ALTER ROLE/.test(l))).toHaveLength(1);

    // The brief's line, and the other settings that print a statement's text.
    for (const re of [
      /^SET log_min_error_statement = panic;$/,
      /^SET log_statement = 'none';$/,
      /^SET log_min_duration_statement = -1;$/,
      /^SET log_min_duration_sample = -1;$/,
      /^SET log_transaction_sample_rate = 0;$/,
      /^SET debug_print_parse = off;$/,
      /^SET debug_print_rewritten = off;$/,
      /^SET debug_print_plan = off;$/,
    ]) {
      const i = at(re);
      expect(i, String(re)).toBeGreaterThan(-1);
      expect(i, `${re} must precede ALTER ROLE`).toBeLessThan(alter);
    }
  });

  it('checks that the role exists before sending ALTER ROLE', () => {
    const { lines } = provision();
    const check = lines.findIndex((l) => /pg_roles WHERE rolname = 'makrai_identity'/.test(l) && /RAISE EXCEPTION/.test(l));
    const alter = lines.findIndex((l) => /^ALTER ROLE/.test(l));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(alter);
  });

  it('passes the password on stdin only, never in argv or on stderr', () => {
    const { lines, argv, stderr } = provision();
    expect(argv).toEqual(['-v', 'ON_ERROR_STOP=1', '-d', 'makrai_test']);
    expect(stderr).not.toContain(secret);
    // Exactly one stdin line carries it, escaped for psql's \set; the SQL itself only
    // names the psql variable, which psql quotes.
    const carrying = lines.filter((l) => l.includes('c0ffee'));
    expect(carrying).toEqual([`\\set pw '${'c0ffee'.repeat(10)}q\\'uote\\\\slash'`]);
  });
});

describe('passwords are set only by the provisioning script', () => {
  it('no migration sets a role password', () => {
    const dir = 'prisma/migrations';
    const offenders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => {
        const sql = readFileSync(join(dir, d.name, 'migration.sql'), 'utf8').replace(/--.*$/gm, '');
        return /\bPASSWORD\b/i.test(sql);
      })
      .map((d) => d.name);
    expect(offenders).toEqual([]);
  });

  it('db:provision provisions both roles on both databases, with the dev flag set explicitly', () => {
    const script: string = JSON.parse(readFileSync('package.json', 'utf8')).scripts['db:provision'];
    expect(script).toMatch(/ALLOW_DEV_DB_PASSWORD=1/);
    for (const db of ['makrai', 'makrai_test']) {
      for (const role of ['makrai_app', 'makrai_identity']) {
        expect(script).toContain(`scripts/provision-app-db-role.sh ${db} ${role}`);
      }
    }
  });
});
