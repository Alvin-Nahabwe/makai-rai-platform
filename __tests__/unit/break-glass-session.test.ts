import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The console break-glass hook (ADR-0010). `pam_exec` runs it as root when a console
 * login opens its session; it appends an integrity-log entry, mails a content-free
 * notice and writes one journald line. Access never waits on any of that (P3): the hook
 * always exits 0 and every external step runs under `timeout`.
 *
 * The run-time tests execute the real file with stand-ins for `docker`, `psql`, `curl`
 * and `logger` first on PATH. Each records its arguments and its stdin, and does what
 * its STUB_<NAME> variable says: `ok`, `fail` (exit 1, no output), `partial` (print,
 * then exit 3, as psql does when a later statement fails) or `hang` (sleep 30 s). The
 * hook runs under `setsid`, with stdin from /dev/null: no controlling terminal, as under
 * pam_exec.
 */

const HOOK = 'ops/host/makrai-break-glass-session';
const NOTICE = 'ops/host/break-glass-notice.txt';
const PAM = 'ops/host/pam.d-login';
const PAM_LINE = 'session optional pam_exec.so quiet type=open_session /usr/local/sbin/makrai-break-glass-session';
/** sha256 of the live /etc/pam.d/login, tracked unchanged by the commit before the hook line. */
const LIVE_PAM_SHA256 = '089abccf4956b607e4b2d13f455a15eec5f6636ce0be287d54b08f8a429668a4';

const ENTRY_ID = '3f1c2a4e-9b7d-4c1e-8f2a-6d5b4c3a2e1f';
const ENTRY_HASH = 'ab'.repeat(32);
const KEY = ['re', 'k'.repeat(24)].join('_'); // built, not a literal: keeps secret scanners quiet
const ALERT_TO = 'alert-sentinel@example.invalid';
const FROM = 'MAK-AI RAI <sender-sentinel@example.invalid>';
const OWNER = 'owner-sentinel@example.invalid';
const ADMIN = 'admin-sentinel@example.invalid';

const STUB = `#!/usr/bin/env bash
name=\${0##*/}
{ echo CALL; printf '%s\\n' "$@"; } >> "$RECORD/$name.argv"
mode_var="STUB_\${name^^}"
mode=\${!mode_var:-ok}
[ "$mode" = hang ] && exec sleep 30
cat >> "$RECORD/$name.stdin"
[ "$mode" = fail ] && exit 1
case $name in
  docker) printf '%s\\n' "$DOCKER_OUT" ;;
  curl) case "$*" in *'%{http_code}'*) printf '%s' "\${CURL_CODE:-200}" ;; esac ;;
esac
[ "$mode" = partial ] && exit 3
exit 0
`;

const ENV_FILE = [
  '# a comment',
  'POSTGRES_USER=makrai',
  'POSTGRES_DB="makrai"',
  `RESEND_API_KEY=${KEY}`,
  `EMAIL_FROM_ADDRESS="${FROM}"`,
  `ADMIN_EMAIL='${ALERT_TO}'`,
  // Must be read as text, never run: the hook runs as root.
  'NOT_READ=$(touch "$RECORD/env-was-executed")',
  'BG_TIMEOUT=999',
  '',
].join('\n');

type Run = {
  status: number | null;
  ms: number;
  calls: Record<string, string[][]>;
  stdin: Record<string, string>;
  executedEnv: boolean;
};

function runHook(env: Record<string, string | undefined>, envFile = ENV_FILE): Run {
  const dir = mkdtempSync(path.join(tmpdir(), 'break-glass-'));
  try {
    const bin = path.join(dir, 'bin');
    const record = path.join(dir, 'record');
    mkdirSync(bin);
    mkdirSync(record);
    for (const name of ['docker', 'psql', 'curl', 'logger']) {
      writeFileSync(path.join(bin, name), STUB);
      chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(path.join(dir, '.env'), envFile);

    const full: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RECORD: record,
      MAKRAI_ENV_FILE: path.join(dir, '.env'),
      MAKRAI_NOTICE_FILE: path.resolve(NOTICE),
      PAM_TYPE: 'open_session',
      PAM_SERVICE: 'login',
      PAM_USER: 'root',
      PAM_TTY: 'tty1',
      DOCKER_OUT: `${ENTRY_ID}|7|${ENTRY_HASH}\n${OWNER}\n${ADMIN}\n${ALERT_TO}`,
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete full[k];
      else full[k] = v;
    }

    const t0 = Date.now();
    const r = spawnSync('setsid', ['-w', path.resolve(HOOK)], { env: full, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    const ms = Date.now() - t0;

    const calls: Record<string, string[][]> = {};
    const stdin: Record<string, string> = {};
    for (const f of readdirSync(record)) {
      const text = readFileSync(path.join(record, f), 'utf8');
      if (f.endsWith('.argv')) {
        calls[f.slice(0, -5)] = text.split('CALL\n').filter(Boolean).map((c) => c.replace(/\n$/, '').split('\n'));
      } else if (f.endsWith('.stdin')) {
        stdin[f.slice(0, -6)] = text;
      }
    }
    return { status: r.status, ms, calls, stdin, executedEnv: existsSync(path.join(record, 'env-was-executed')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The one message the hook gave logger, after `-t makrai-break-glass`. */
function logLine(r: Run): string {
  expect(r.calls.logger, 'logger was never called').toHaveLength(1);
  const [tagFlag, tag, ...rest] = r.calls.logger[0];
  expect([tagFlag, tag]).toEqual(['-t', 'makrai-break-glass']);
  expect(rest).toHaveLength(1);
  return rest[0];
}

type Notice = { from: string; to: string[]; bcc?: string[]; subject: string; text: string };

/** The body curl was given as `data = "<json>"` on stdin, unquoted as curl's config parser does. */
function noticeSent(r: Run): Notice {
  const line = (r.stdin.curl ?? '').split('\n').find((l) => l.startsWith('data = "'));
  expect(line, 'no data line reached curl on stdin').toBeDefined();
  return JSON.parse((line as string).slice('data = "'.length, -1).replace(/\\(["\\])/g, '$1')) as Notice;
}

function renderedNotice(time: string, entry: string): { subject: string; text: string } {
  const tpl = readFileSync(NOTICE, 'utf8').replace(/\n+$/, '');
  const [first, , ...body] = tpl.split('\n');
  const fill = (s: string) => s.replaceAll('{EVENT}', 'break_glass.open').replaceAll('{TIME_UTC}', time).replaceAll('{ENTRY_ID}', entry);
  return { subject: fill(first.replace(/^Subject: /, '')), text: fill(body.join('\n')) };
}

describe('the break-glass session hook at run time', () => {
  it('is an executable file', () => {
    expect(statSync(HOOK).mode & 0o111, `${HOOK} is not executable`).not.toBe(0);
  });

  it('opens the session when every logging step fails', () => {
    const r = runHook({ STUB_DOCKER: 'fail', STUB_PSQL: 'fail', STUB_CURL: 'fail', STUB_LOGGER: 'fail' });
    expect(r.status).toBe(0);
    expect(logLine(r)).toMatch(/^entry=FAILED notice=failed:\S+$/);
  });

  it('bounds each step with a timeout', () => {
    for (const hung of ['docker', 'curl', 'logger']) {
      const r = runHook({ BG_TIMEOUT: '1', [`STUB_${hung.toUpperCase()}`]: 'hang' });
      expect({ hung, status: r.status }).toEqual({ hung, status: 0 });
      expect(r.ms, `a hung ${hung} held the hook for ${r.ms} ms`).toBeLessThan(5000);
      expect(r.calls.logger, `${hung}: logger was never called`).toHaveLength(1);
    }
  });

  it('does nothing outside a console session open', () => {
    for (const env of [
      { PAM_TYPE: 'close_session' },
      { PAM_SERVICE: 'sshd' },
      { PAM_SERVICE: 'sudo' },
      { PAM_TYPE: undefined },
      { PAM_SERVICE: undefined },
    ]) {
      const r = runHook(env);
      expect({ env, status: r.status, calls: r.calls }).toEqual({ env, status: 0, calls: {} });
    }
  });

  it('writes the entry through docker exec psql, with user and tty as psql variables, and logs its hash', () => {
    const r = runHook({});
    expect(r.status).toBe(0);
    expect(r.calls.psql, 'psql runs inside the container, never on the host').toBeUndefined();
    expect(r.calls.docker).toEqual([
      ['exec', '-i', 'docker-postgres-1', 'psql', '-X', '-U', 'makrai', '-d', 'makrai', '-v', 'ON_ERROR_STOP=1', '-At'],
    ]);
    const lines = r.stdin.docker.split('\n');
    expect(lines.slice(0, 3)).toEqual(["\\set user 'root'", "\\set tty 'tty1'", "\\set timeout_ms '9500'"]);
    expect(r.stdin.docker).toContain("integrity_append('break_glass.open', 'console:' || :'user'");
    expect(r.stdin.docker).toContain("'tty', :'tty'");
    expect(logLine(r)).toBe(`entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH} notice=sent`);
  });

  it('a hostile PAM_USER or PAM_TTY can add no psql command and reach no SQL text', () => {
    const r = runHook({
      PAM_USER: "root'; DROP TABLE users; --\n\\! touch /tmp/break-glass-pwned",
      PAM_TTY: "tty1'\n\\set ON_ERROR_STOP 0",
    });
    expect(r.status).toBe(0);
    const meta = r.stdin.docker.split('\n').filter((l) => l.startsWith('\\'));
    expect(meta).toHaveLength(3);
    expect(meta[0]).toMatch(/^\\set user '[A-Za-z0-9._-]{1,32}'$/);
    expect(meta[1]).toMatch(/^\\set tty '[A-Za-z0-9._/-]{1,32}'$/);
    expect(meta[2]).toBe("\\set timeout_ms '9500'");
    expect(r.stdin.docker).not.toContain('DROP TABLE');
  });

  it('has the server stop the append before timeout stops the client', () => {
    // Killing `docker exec` leaves psql running in the container; a statement_timeout
    // under BG_TIMEOUT is what keeps a late append from landing after entry=FAILED.
    for (const [bg, ms] of [['1', '500'], ['10', '9500'], ['0', '9500'], ['31', '9500']]) {
      const sql = runHook({ BG_TIMEOUT: bg }).stdin.docker;
      expect(sql, `BG_TIMEOUT=${bg}`).toContain(`\\set timeout_ms '${ms}'\n`);
      const setAt = sql.indexOf("set_config('statement_timeout', :'timeout_ms', false)");
      expect(setAt, 'statement_timeout is never set').toBeGreaterThan(-1);
      expect(setAt).toBeLessThan(sql.indexOf('integrity_append('));
    }
  });

  it('sends the notice with the key and every address on stdin, none in argv, and owners only in bcc', () => {
    const r = runHook({ PAM_USER: 'user-sentinel', PAM_TTY: 'tty-sentinel' });
    expect(r.calls.curl).toHaveLength(1);
    const argv = r.calls.curl[0].join(' ');
    for (const secret of [KEY, ALERT_TO, OWNER, ADMIN, 'sender-sentinel', 'break-glass login']) {
      expect(argv, `${secret} reached curl as an argument`).not.toContain(secret);
    }
    expect(r.calls.curl[0]).toContain('--config');
    expect(r.calls.curl[0]).toContain('https://api.resend.com/emails');
    expect(r.stdin.curl).toContain(`header = "Authorization: Bearer ${KEY}"`);

    const sent = noticeSent(r);
    expect(sent.from).toBe(FROM);
    expect(sent.to).toEqual([ALERT_TO]);
    // Owners of different organisations must not see each other's addresses.
    expect(sent.bcc).toEqual([OWNER, ADMIN]);
    const time = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\b/.exec(sent.text)?.[0];
    expect(time, 'the notice carries no UTC time').toBeDefined();
    expect({ subject: sent.subject, text: sent.text }).toEqual(renderedNotice(time as string, ENTRY_ID));
    // Nothing from the login and no address: only the three filled tokens vary.
    expect(`${sent.subject}\n${sent.text}`).not.toMatch(/sentinel|@/);
  });

  it('sends valid JSON when the sender name holds a quote and a backslash', () => {
    const from = 'Ops "Desk" \\ team <sender-sentinel@example.invalid>';
    const r = runHook({}, ENV_FILE.replace(`EMAIL_FROM_ADDRESS="${FROM}"`, `EMAIL_FROM_ADDRESS='${from}'`));
    expect(noticeSent(r).from).toBe(from);
    expect(logLine(r)).toMatch(/ notice=sent$/);
  });

  it('sends nothing, and says why, when the mail settings or the notice text are missing', () => {
    const noKey = runHook({}, ENV_FILE.replace(`RESEND_API_KEY=${KEY}\n`, ''));
    expect(noKey.calls.curl).toBeUndefined();
    expect(logLine(noKey)).toBe(`entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH} notice=failed:config`);

    const noText = runHook({ MAKRAI_NOTICE_FILE: '/nonexistent/break-glass-notice.txt' });
    expect(noText.calls.curl).toBeUndefined();
    expect(logLine(noText)).toBe(`entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH} notice=failed:template`);
  });

  it('never logs an address', () => {
    for (const env of [{}, { STUB_CURL: 'fail' }, { STUB_DOCKER: 'fail' }]) {
      expect(logLine(runHook(env))).not.toContain('@');
    }
  });

  it('logs notice=failed with the HTTP status when Resend does not accept it', () => {
    expect(logLine(runHook({ CURL_CODE: '422' }))).toBe(`entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH} notice=failed:422`);
    expect(logLine(runHook({ STUB_CURL: 'fail' }))).toMatch(/ notice=failed:000$/);
  });

  it('still tells ALERT_TO, and logs notice=failed:recipients, when the owner list cannot be read', () => {
    const partial = runHook({ STUB_DOCKER: 'partial', DOCKER_OUT: `${ENTRY_ID}|7|${ENTRY_HASH}` });
    expect(logLine(partial)).toBe(`entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH} notice=failed:recipients`);
    expect(noticeSent(partial)).toMatchObject({ to: [ALERT_TO] });
    expect(noticeSent(partial).bcc).toBeUndefined();

    const down = runHook({ STUB_DOCKER: 'fail' });
    expect(logLine(down)).toBe('entry=FAILED notice=failed:recipients');
    expect(noticeSent(down).text).toContain('FAILED');
  });

  it('reads only its own keys from .env, as text, without running it', () => {
    // ENV_FILE also sets BG_TIMEOUT=999, so the timeout test above shows .env cannot
    // lengthen the wait; only the environment pam_exec passes can set it.
    const r = runHook({});
    expect(r.executedEnv, '.env was executed').toBe(false);
    // Unquoted, double-quoted and single-quoted values all read back bare.
    expect(r.calls.docker?.[0]).toEqual(expect.arrayContaining(['-U', 'makrai', '-d', 'makrai']));
    expect(noticeSent(r)).toMatchObject({ from: FROM, to: [ALERT_TO] });
    expect(r.stdin.curl).toContain(`Bearer ${KEY}"`);
  });
});

describe('the break-glass hook, its notice and the login stack, read as text', () => {
  const hook = readFileSync(HOOK, 'utf8');
  /** Executable lines: whole-line comments and blank lines dropped. */
  const code = hook.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

  it('notice carries only event, time and entry id', () => {
    const tpl = readFileSync(NOTICE, 'utf8');
    const placeholders = new Set([...tpl.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]));
    expect([...placeholders].sort()).toEqual(['ENTRY_ID', 'EVENT', 'TIME_UTC']);
    // The hook fills {NAME} tokens only; a shell-style reference would be literal text
    // today and a leak the day someone renders it with envsubst.
    expect(tpl).not.toMatch(/[$`]/);
    expect(tpl.split('\n')[0]).toMatch(/^Subject: \S/);
    expect(tpl.split('\n')[1]).toBe('');
  });

  it('user and tty reach psql only as variables', () => {
    // The SQL is a heredoc with a QUOTED delimiter, so the shell expands nothing in it.
    const bodies = [...hook.matchAll(/<<'SQL'\n([\s\S]*?)\nSQL\n/g)].map((m) => m[1]);
    expect(bodies, "expected exactly one <<'SQL' heredoc").toHaveLength(1);
    const sql = bodies[0];
    expect(sql).toContain(":'user'");
    expect(sql).toContain(":'tty'");
    expect(sql, 'the SQL text holds a shell expansion').not.toContain('$');
    expect(sql).not.toMatch(/PAM_/);

    // The values reach psql as two \set lines, built from the sanitised copies.
    expect(hook).toContain(`"\\\\set user '$user'"`);
    expect(hook).toContain(`"\\\\set tty '$tty'"`);
    // PAM_USER and PAM_TTY are read once each, into the sanitised copy, and nowhere else.
    for (const [pamVar, copy] of [['PAM_USER', 'user'], ['PAM_TTY', 'tty']]) {
      const uses = code.filter((l) => l.includes(pamVar));
      expect(uses.length, `${pamVar} is never read`).toBeGreaterThan(0);
      for (const l of uses) expect(l, `${pamVar} is used outside its sanitising assignment`).toMatch(new RegExp(`^${copy}=`));
    }
  });

  it('runs every external step under timeout', () => {
    for (const cmd of ['docker', 'curl', 'logger']) {
      const calls = code.filter((l) => new RegExp(`(^|[|;&(]\\s*|\\s)${cmd}\\s`).test(l));
      expect(calls.length, `no ${cmd} call found`).toBeGreaterThan(0);
      for (const l of calls) {
        expect(l, `${cmd} runs without a timeout`).toMatch(new RegExp(`\\btimeout -k 1 ("\\$BG_TIMEOUT"|[1-5]) ${cmd}\\s`));
      }
    }
  });

  it('the login stack runs the hook as optional, on session open only', () => {
    const lines = readFileSync(PAM, 'utf8').split('\n');
    const naming = lines.filter((l) => l.includes('makrai-break-glass-session'));
    expect(naming).toEqual([PAM_LINE]);
    expect(lines.filter((l) => /makrai-break-glass/.test(l) && /\b(required|requisite)\b|\[/.test(l))).toEqual([]);
    // Right after the session stack it extends, so it sees an opened session.
    expect(lines[lines.indexOf(PAM_LINE) - 1]).toBe('@include common-session');
    // And that line is the only change from the live file.
    const without = lines.filter((l) => l !== PAM_LINE).join('\n');
    expect(createHash('sha256').update(without).digest('hex')).toBe(LIVE_PAM_SHA256);
  });
});
