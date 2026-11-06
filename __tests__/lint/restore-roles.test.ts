import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The roles a restore onto a fresh cluster creates (docs/runbooks/backup-restore.md 4.2a), the
 * passwords it then sets (4.5a), and the nightly restore test's role step
 * (ops/host/makrai-restore-test.sh). A dump carries the GRANTs and not the CREATE ROLE, so each of
 * the three derives the roles from prisma/migrations. The derivation used to read
 * `CREATE ROLE [a-z_]+`, which also matched a comment in 20261008000100_identity_lane_role (a
 * stray `defaults` role), and 4.2a created every role LOGIN, including makrai_definer and
 * makrai_operator_fn, which 20261030000100_v060_01_roles_helpers makes NOLOGIN (SRS 9.5: those two
 * are reached only through the SECURITY DEFINER functions they own). `migrate deploy` cannot reset
 * them afterwards, because the dump records those migrations as applied.
 *
 * The runbook blocks are run here, as written, with a stand-in `docker` that records what psql
 * would have been sent; the restore test's own pipelines are run on the real migrations.
 */

const RUNBOOK = readFileSync('docs/runbooks/backup-restore.md', 'utf8');
const RESTORE = readFileSync('ops/host/makrai-restore-test.sh', 'utf8');

// The four roles the migrations create, with the LOGIN or NOLOGIN each migration gives its role.
const MIGRATION_ROLES: Record<string, 'LOGIN' | 'NOLOGIN'> = {
  makrai_app: 'LOGIN',
  makrai_identity: 'LOGIN',
  makrai_definer: 'NOLOGIN',
  makrai_operator_fn: 'NOLOGIN',
};
const FUNCTION_OWNERS = ['makrai_definer', 'makrai_operator_fn'];

/** The text of a `###` section, up to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}`);
  expect(start, `the runbook has no ${heading}`).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.slice(1).search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** The bash fences of a section, each as one string. */
function fences(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** The one fence of a runbook section that holds the role loop. */
function roleLoop(heading: string): string {
  const loops = fences(section(RUNBOOK, heading)).filter((f) => /^for \w+ in \$\(/m.test(f));
  expect(loops, `${heading} has exactly one role loop`).toHaveLength(1);
  return loops[0];
}

/**
 * Every role statement in the migrations, read as SQL (comments removed), with the LOGIN or NOLOGIN
 * written after its name. A second lens on the same files: it does not share the runbook's grep.
 */
function rolesFromSql(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const dir of readdirSync('prisma/migrations', { withFileTypes: true })) {
    const file = path.join('prisma/migrations', dir.name, 'migration.sql');
    if (!dir.isDirectory() || !existsSync(file)) continue;
    const sql = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/\bCREATE\s+ROLE\s+("?)([A-Za-z0-9_$]+)\1([^;]*);/gi)) {
      const attr = /\b(NO)?LOGIN\b/i.exec(m[3]);
      expect(attr, `${file}: CREATE ROLE ${m[2]} states neither LOGIN nor NOLOGIN`).not.toBeNull();
      const login = attr![0].toUpperCase();
      expect(found[m[2]] ?? login, `${m[2]} is created both LOGIN and NOLOGIN`).toBe(login);
      found[m[2]] = login;
    }
  }
  return found;
}

// One directory per call: argv NUL-separated (the SQL of 4.2a spans lines), and stdin.
const DOCKER_STUB = `#!/usr/bin/env bash
call="$REC/$(printf '%04d' "$(find "$REC" -mindepth 1 -maxdepth 1 | wc -l)")"
mkdir -p "$call"
printf '%s\\0' "$@" > "$call/argv"
if [ "$1 $2" = "exec -i" ]; then cat > "$call/stdin"; else : > "$call/stdin"; fi
exit 0
`;

type Run = { code: number | null; stdout: string; stderr: string; calls: { argv: string[]; stdin: string }[] };

/**
 * Runs a runbook role loop from the repository root with a stand-in docker. Its first two lines
 * (`cd /srv/makrai/app`, loading .env) are the server's; they are checked and left out, and the
 * environment they would load is passed in instead.
 */
function runLoop(heading: string, env: Record<string, string> = {}): Run {
  const loop = roleLoop(heading);
  const lines = loop.split('\n');
  expect(lines[0]).toBe('cd /srv/makrai/app');
  expect(lines[1]).toBe('set -a; . ./.env; set +a');
  const dir = mkdtempSync(path.join(tmpdir(), 'restore-roles-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), DOCKER_STUB);
    chmodSync(path.join(bin, 'docker'), 0o755);
    const rec = path.join(dir, 'rec');
    mkdirSync(rec);
    const script = path.join(dir, 'loop.sh');
    writeFileSync(script, `set -euo pipefail\n${lines.slice(2).join('\n')}`);
    const r = spawnSync('bash', [script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
      env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, REC: rec, POSTGRES_USER: 'owner_role', POSTGRES_DB: 'app_db', ...env },
    });
    const calls = readdirSync(rec)
      .sort()
      .map((c) => ({
        argv: readFileSync(path.join(rec, c, 'argv'), 'utf8').split('\0').slice(0, -1),
        stdin: readFileSync(path.join(rec, c, 'stdin'), 'utf8'),
      }));
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one of the restore test's own `$(grep ... /srv/makrai/app/prisma/migrations ...)` pipelines on this repository. */
function runRestorePipeline(variable: string): string[] {
  const m = new RegExp(`^${variable}=\\$\\((grep [^\\n]*)\\)$`, 'm').exec(RESTORE);
  expect(m, `makrai-restore-test.sh has no ${variable}=$(grep ...)`).not.toBeNull();
  const cmd = m![1];
  expect(cmd).toContain('/srv/makrai/app/prisma/migrations/*/migration.sql');
  const r = spawnSync('bash', ['-c', `set -o pipefail; ${cmd.replace('/srv/makrai/app/prisma', 'prisma')}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter(Boolean);
}

describe('restore roles (SEC-1, backup-restore.md 4.2a and 4.5a, makrai-restore-test.sh)', () => {
  it('NFR-SEC-04 FIX-1: the migrations create exactly four roles, two of them NOLOGIN', () => {
    // The second lens the runbook's grep is compared against. If a migration adds a role, this
    // list and the runbook's prose are reviewed with it.
    expect(rolesFromSql()).toEqual(MIGRATION_ROLES);
  });

  it("NFR-SEC-04 FIX-1: 4.2a creates exactly the migrations' roles, each with its migration's LOGIN or NOLOGIN", () => {
    const r = runLoop('### 4.2a');
    expect(r.code, r.stderr).toBe(0);
    const created: Record<string, string> = {};
    for (const call of r.calls) {
      const sql = call.argv[call.argv.indexOf('-c') + 1] ?? '';
      const m = /\bCREATE ROLE (\S+) (\S+)/.exec(sql);
      expect(m, `a psql call creates no role:\n${sql}`).not.toBeNull();
      created[m![1]] = m![2];
      // NOBYPASSRLS above all: a role that bypasses row-level security defeats every tenant boundary.
      expect(sql).toMatch(/\bNOSUPERUSER\b/);
      expect(sql).toMatch(/\bNOBYPASSRLS\b/);
    }
    expect(created, 'no stray role such as `defaults`, and NOLOGIN kept').toEqual(MIGRATION_ROLES);
  });

  it('NFR-SEC-04 FIX-1: 4.5a sets a password only for the LOGIN roles and skips the function owners', () => {
    // Values built from parts: they are stand-ins, and a secret scanner should not read them as a URL with a password.
    const url = (role: string): string => ['postgresql://', role, ':', `stand-in-${role}`, '@postgres:5432/app_db'].join('');
    const r = runLoop('### 4.5a', {
      APP_DATABASE_URL: url('makrai_app'),
      IDENTITY_DATABASE_URL: url('makrai_identity'),
    });
    expect(r.code, r.stderr).toBe(0);
    const altered = r.calls.map((c) => /^ALTER ROLE (\S+) WITH PASSWORD :'pw';$/m.exec(c.stdin)?.[1]);
    expect(altered.sort()).toEqual(['makrai_app', 'makrai_identity']);
    for (const owner of FUNCTION_OWNERS) {
      expect(r.stdout, `4.5a must not tell the operator to give ${owner} a password`).not.toContain(owner);
    }

    // With no connection URL at all, it names only the LOGIN roles as missing a password.
    const bare = runLoop('### 4.5a');
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.calls).toEqual([]);
    const named = [...bare.stdout.matchAll(/no connection URL for (\S+) in \.env/g)].map((m) => m[1]);
    expect(named.sort()).toEqual(['makrai_app', 'makrai_identity']);
  });

  it("NFR-SEC-04 FIX-1: the restore test derives the migrations' roles and its NOLOGIN set from the same grep", () => {
    expect(runRestorePipeline('ROLES')).toEqual(Object.keys(MIGRATION_ROLES).sort());
    expect(runRestorePipeline('NOLOGIN_ROLES')).toEqual(FUNCTION_OWNERS);
  });

  it('NFR-SEC-04 FIX-1: the restore test fails when a NOLOGIN role can log in on the live cluster', () => {
    // The count is read from the live database, where a restore by 4.2a would have left it, and any
    // count but 0 fails the run with field `logins`. The run itself is in ops-host-v060.test.ts.
    const lines = RESTORE.split('\n');
    const query = lines.findIndex((l) =>
      /^live_logins=\$\(docker exec docker-postgres-1 psql .* -Atc "SELECT count\(\*\) FROM pg_roles WHERE rolcanlogin AND rolname IN \(\$\{nologin_in\}\)" 2>>"\$LOG"\)$/.test(l),
    );
    expect(query, 'no rolcanlogin count on the live cluster').toBeGreaterThan(-1);
    expect(lines.slice(query + 1).join('\n')).toMatch(
      /^\[\[ \$live_logins =~ \^\[0-9\]\+\$ \]\] && \[ "\$live_logins" = 0 \] \|\| fail logins /m,
    );
  });
});
