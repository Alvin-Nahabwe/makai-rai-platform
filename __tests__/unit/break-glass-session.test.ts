import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The console break-glass hook (ADR-0010). `pam_exec` runs it as root when a console
 * login opens its session; it appends an integrity-log entry, mails a content-free
 * notice and writes one journald line. Access never waits on any of that (P3): the hook
 * always exits 0 and every external step runs under `timeout`.
 *
 * The run-time tests execute the real file with stand-ins first on PATH. `docker`,
 * `psql`, `curl` and `logger` record their arguments and their stdin, and do what their
 * STUB_<NAME> variable says:
 *   ok         print what a success prints
 *   fail       exit 1, no output
 *   partial    print, then exit 3, as psql does when a later statement fails
 *   slow       wait 1.5 s, then succeed
 *   printhang  print, then hang, as psql does when its client is cut off mid-session
 *   hang       sleep 30 s
 * curl answers with $CURL_BODY, then a newline and $CURL_CODE (default 200), as
 * `-w '\\n%{http_code}'` makes the real one do.
 * `stat` and `head` record their arguments and run the real command, unless told to hang.
 * The hook runs in a session of its own, with stdin from /dev/null: no controlling
 * terminal, as under pam_exec.
 */

const HOOK = 'ops/host/makrai-break-glass-session';
const NOTICE = 'ops/host/break-glass-notice.txt';
const PAM = 'ops/host/pam.d-login';
const PAM_LINE = 'session optional pam_exec.so quiet type=open_session /usr/local/sbin/makrai-break-glass-session';
/** sha256 of the live /etc/pam.d/login, tracked unchanged by the commit before the hook line. */
const LIVE_PAM_SHA256 = '089abccf4956b607e4b2d13f455a15eec5f6636ce0be287d54b08f8a429668a4';

const ENTRY_ID = '3f1c2a4e-9b7d-4c1e-8f2a-6d5b4c3a2e1f';
const ENTRY_HASH = 'ab'.repeat(32);
const ENTRY_LINE = `entry=${ENTRY_ID} seq=7 hash=${ENTRY_HASH}`;
const KEY = ['re', 'k'.repeat(24)].join('_'); // built, not a literal: keeps secret scanners quiet
const ALERT_TO = 'alert-sentinel@example.invalid';
const SENDER = 'sender-sentinel@example.invalid';
const FROM = `MAK-AI RAI <${SENDER}>`;
const OWNER = 'owner-sentinel@example.invalid';
const ADMIN = 'admin-sentinel@example.invalid';
/** Resend's answer when every email in the batch was accepted. */
const OK_BODY = '{"data":[{"id":"e-0"},{"id":"e-1"},{"id":"e-2"}]}';

const STUB = `#!/usr/bin/env bash
name=\${0##*/}
{ echo CALL; printf '%s\\n' "$@"; } >> "$RECORD/$name.argv"
mode_var="STUB_\${name^^}"
mode=\${!mode_var:-ok}
[ "$mode" = hang ] && exec sleep 30
case $name in stat | head) PATH=\${PATH#*:}; exec "$name" "$@" ;; esac
cat >> "$RECORD/$name.stdin"
[ "$mode" = fail ] && exit 1
[ "$mode" = slow ] && sleep 1.5
case $name in
  docker) printf '%s\\n' "$DOCKER_OUT" ;;
  curl) case "$*" in *'%{http_code}'*) printf '%s\\n%s' "$CURL_BODY" "\${CURL_CODE:-200}" ;; esac ;;
esac
[ "$mode" = printhang ] && exec sleep 30
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

type Options = {
  envFile?: string;
  /** Runs in the temp directory after setup; returns more environment for the hook. */
  prepare?: (dir: string) => Record<string, string>;
};

/** A temp directory with the stubs, the .env and the hook's environment. */
function setupHook(env: Record<string, string | undefined>, opts: Options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'break-glass-'));
  const bin = path.join(dir, 'bin');
  const record = path.join(dir, 'record');
  mkdirSync(bin);
  mkdirSync(record);
  for (const name of ['docker', 'psql', 'curl', 'logger', 'stat', 'head']) {
    writeFileSync(path.join(bin, name), STUB);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(dir, '.env'), opts.envFile ?? ENV_FILE);

  const full: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RECORD: record,
    // The temp directory stands in for the server checkout: its owner is "the operator".
    MAKRAI_APP_DIR: dir,
    MAKRAI_ENV_FILE: path.join(dir, '.env'),
    MAKRAI_NOTICE_FILE: path.resolve(NOTICE),
    PAM_TYPE: 'open_session',
    PAM_SERVICE: 'login',
    PAM_USER: 'root',
    PAM_TTY: 'tty1',
    DOCKER_OUT: `${ENTRY_ID}|7|${ENTRY_HASH}\n${OWNER}\n${ADMIN}`,
    CURL_BODY: OK_BODY,
    ...opts.prepare?.(dir),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }

  const collect = (status: number | null, ms: number): Run => {
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
    return { status, ms, calls, stdin, executedEnv: existsSync(path.join(record, 'env-was-executed')) };
  };
  return { dir, env: full, collect, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runHook(env: Record<string, string | undefined>, opts: Options = {}): Run {
  const h = setupHook(env, opts);
  try {
    const t0 = Date.now();
    // SIGKILL on overrun: the hook ignores TERM, so a regression that hangs it must
    // still end the run and fail the test rather than hang the suite.
    const r = spawnSync('setsid', ['-w', path.resolve(HOOK)], { env: h.env, stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
    return h.collect(r.status, Date.now() - t0);
  } finally {
    h.cleanup();
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

type Email = { from: string; to: string[]; subject: string; text: string };

/** The batch curl was given as `data = "<json>"` on stdin, unquoted as curl's config parser does. */
function batchSent(r: Run): Email[] {
  const line = (r.stdin.curl ?? '').split('\n').find((l) => l.startsWith('data = "'));
  expect(line, 'no data line reached curl on stdin').toBeDefined();
  const batch = JSON.parse((line as string).slice('data = "'.length, -1).replace(/\\(["\\])/g, '$1')) as Email[];
  expect(Array.isArray(batch), 'the body is not a JSON array').toBe(true);
  return batch;
}

function renderedNotice(time: string, entry: string): { subject: string; text: string } {
  const tpl = readFileSync(NOTICE, 'utf8').replace(/\n+$/, '');
  const [first, , ...body] = tpl.split('\n');
  const fill = (s: string) => s.replaceAll('{TIME_UTC}', time).replaceAll('{ENTRY_ID}', entry);
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
    for (const hung of ['docker', 'curl', 'logger', 'stat', 'head']) {
      const r = runHook({ BG_TIMEOUT: '1', [`STUB_${hung.toUpperCase()}`]: 'hang' });
      expect({ hung, status: r.status }).toEqual({ hung, status: 0 });
      expect(r.ms, `a hung ${hung} held the hook for ${r.ms} ms`).toBeLessThan(5000);
      expect(r.calls.logger, `${hung}: logger was never called`).toHaveLength(1);
    }
  }, 60_000);

  it('ignores INT, TERM, HUP and QUIT sent while the database step runs', async () => {
    const h = setupHook({ STUB_DOCKER: 'slow' });
    try {
      // detached: the hook leads a session and process group of its own, as a stand-in
      // for a console that sends a signal to its foreground group.
      const child = spawn(path.resolve(HOOK), [], { env: h.env, stdio: 'ignore', detached: true });
      const exited = new Promise<number | string | null>((resolve) =>
        child.on('exit', (code, signal) => resolve(signal ?? code)),
      );
      const overrun = setTimeout(() => process.kill(-(child.pid as number), 'SIGKILL'), 15_000);
      exited.finally(() => clearTimeout(overrun));
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) process.kill(-(child.pid as number), sig);
      const outcome = await exited;
      expect(outcome, 'the hook was ended by a signal or exited non-zero').toBe(0);
      expect(logLine(h.collect(0, 0))).toBe(`${ENTRY_LINE} notice=sent`);
    } finally {
      h.cleanup();
    }
  }, 20_000);

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
    expect(lines.slice(0, 2)).toEqual(["\\set user 'root'", "\\set tty 'tty1'"]);
    expect(lines[2]).toMatch(/^\\set deadline_ms '\d+'$/);
    expect(r.stdin.docker).toContain("integrity_append('break_glass.open', 'console:' || :'user'");
    expect(r.stdin.docker).toContain("'tty', :'tty'");
    expect(logLine(r)).toBe(`${ENTRY_LINE} notice=sent`);
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
    expect(meta[2]).toMatch(/^\\set deadline_ms '\d+'$/);
    expect(r.stdin.docker).not.toContain('DROP TABLE');
  });

  it("has the server stop each statement at the hook's own deadline", () => {
    // Killing `docker exec` leaves psql running in the container. The server is given
    // the wall-clock moment, half a second before `timeout` stops the client, after
    // which neither statement may still be running.
    for (const [bg, seconds] of [['1', 1], ['10', 10], ['0', 10], ['31', 10]] as const) {
      const before = Date.now();
      const sql = runHook({ BG_TIMEOUT: bg }).stdin.docker;
      const after = Date.now();
      const deadline = Number(/^\\set deadline_ms '(\d+)'$/m.exec(sql)?.[1]);
      expect(deadline, `BG_TIMEOUT=${bg}`).toBeGreaterThanOrEqual(before + seconds * 1000 - 500);
      expect(deadline, `BG_TIMEOUT=${bg}`).toBeLessThanOrEqual(after + seconds * 1000 - 500);

      const statements = sql.split('\n');
      const setAt = statements
        .map((l, i) => (l.includes("set_config('statement_timeout', greatest(1, :'deadline_ms'::bigint") ? i : -1))
        .filter((i) => i >= 0);
      const appendAt = statements.findIndex((l) => l.includes('integrity_append('));
      const recipientsAt = statements.findIndex((l) => l.includes('u.email'));
      expect(setAt, 'the deadline is not set before each statement').toHaveLength(2);
      expect(setAt[0]).toBeLessThan(appendAt);
      expect(setAt[1]).toBeGreaterThan(appendAt);
      expect(setAt[1]).toBeLessThan(recipientsAt);
    }
  });

  it('logs what landed: the entry, UNCERTAIN when the client was cut off, FAILED when psql refused', () => {
    // An entry line was read: it landed, whatever happened after it.
    expect(logLine(runHook({ BG_TIMEOUT: '1', STUB_DOCKER: 'printhang' }))).toBe(`${ENTRY_LINE} notice=failed:recipients`);
    // Cut off with no entry line: the append may or may not have committed.
    expect(logLine(runHook({ BG_TIMEOUT: '1', STUB_DOCKER: 'hang' }))).toBe('entry=UNCERTAIN notice=failed:recipients');
    // psql (or docker) ended on its own without an entry line: nothing landed.
    expect(logLine(runHook({ STUB_DOCKER: 'fail' }))).toBe('entry=FAILED notice=failed:recipients');
  });

  it('sends the notice with the key and every address on stdin, and none in argv', () => {
    const r = runHook({ PAM_USER: 'user-sentinel', PAM_TTY: 'tty-sentinel' });
    expect(r.calls.curl).toHaveLength(1);
    // -q first: no ~/.curlrc can add `trace` or `output` and capture the key.
    expect(r.calls.curl[0][0]).toBe('-q');
    const argv = r.calls.curl[0].join(' ');
    for (const secret of [KEY, ALERT_TO, OWNER, ADMIN, SENDER, 'emergency access']) {
      expect(argv, `${secret} reached curl as an argument`).not.toContain(secret);
    }
    expect(r.calls.curl[0]).toContain('--config');
    // One call to the batch endpoint, in permissive mode: one bad address cannot stop the rest.
    expect(r.calls.curl[0]).toContain('https://api.resend.com/emails/batch');
    expect(r.calls.curl[0]).toContain('x-batch-validation: permissive');
    expect(r.stdin.curl).toContain(`header = "Authorization: Bearer ${KEY}"`);

    const [first] = batchSent(r);
    const time = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\b/.exec(first.text)?.[0];
    expect(time, 'the notice carries no UTC time').toBeDefined();
    expect({ subject: first.subject, text: first.text }).toEqual(renderedNotice(time as string, ENTRY_ID));
    // Nothing from the login and no address: only the three filled tokens vary.
    expect(`${first.subject}\n${first.text}`).not.toMatch(/sentinel|@/);
  });

  it('sends one email per recipient, ALERT_TO first, so no one sees another recipient', () => {
    // The database returns an owner twice in other case, and ADMIN_EMAIL in other case.
    const r = runHook({
      DOCKER_OUT: `${ENTRY_ID}|7|${ENTRY_HASH}\n${OWNER}\n${ADMIN}\n${OWNER.toUpperCase()}\n${ALERT_TO.toUpperCase()}`,
    });
    const batch = batchSent(r);
    // One element per address, once each whatever its case, ADMIN_EMAIL first.
    expect(batch.map((e) => e.to)).toEqual([[ALERT_TO], [OWNER], [ADMIN]]);
    for (const email of batch) {
      // Each email names one recipient and nothing else: no bcc, cc or reply_to.
      expect(Object.keys(email).sort()).toEqual(['from', 'subject', 'text', 'to']);
      expect({ from: email.from, subject: email.subject, text: email.text })
        .toEqual({ from: FROM, subject: batch[0].subject, text: batch[0].text });
    }
    expect(logLine(r)).toBe(`${ENTRY_LINE} notice=sent`);
  });

  it("classifies Resend's answer, and never logs it", () => {
    const failing = (index: number) =>
      `{"data":[{"id":"e-x"}],"errors":[{"index":${index},"message":"body-sentinel refused"}]}`;
    for (const [what, env, notice] of [
      ['every email accepted', {}, 'sent'],
      ['an empty errors list', { CURL_BODY: '{"data":[{"id":"e-0"}],"errors":[]}' }, 'sent'],
      ["an owner's email refused", { CURL_BODY: failing(1) }, 'failed:recipients'],
      ["index 10 is not ALERT_TO's", { CURL_BODY: failing(10) }, 'failed:recipients'],
      ["ALERT_TO's email refused", { CURL_BODY: failing(0) }, 'failed:alert'],
      ['a 2xx with no data', { CURL_BODY: '{"message":"body-sentinel"}' }, 'failed:alert'],
      ['the request refused', { CURL_CODE: '422', CURL_BODY: '{"message":"body-sentinel"}' }, 'failed:422'],
      ['no response', { STUB_CURL: 'fail' }, 'failed:000'],
    ] as const) {
      const line = logLine(runHook(env));
      expect(line, what).toBe(`${ENTRY_LINE} notice=${notice}`);
      expect(line, `${what}: the response reached the log`).not.toContain('body-sentinel');
    }
  });

  it('sends ALERT_TO and the first 99 owners and admins, and says the rest were cut', () => {
    const owners = Array.from({ length: 120 }, (_, i) => `owner-${String(i).padStart(3, '0')}@example.invalid`);
    const r = runHook({ DOCKER_OUT: [`${ENTRY_ID}|7|${ENTRY_HASH}`, ...owners].join('\n') });
    const batch = batchSent(r);
    expect(batch).toHaveLength(100);
    expect(batch.map((e) => e.to[0])).toEqual([ALERT_TO, ...owners.slice(0, 99)]);
    expect(logLine(r)).toBe(`${ENTRY_LINE} notice=failed:recipients;truncated`);

    // Exactly 100 in all is not cut.
    const full = runHook({ DOCKER_OUT: [`${ENTRY_ID}|7|${ENTRY_HASH}`, ...owners.slice(0, 99)].join('\n') });
    expect(batchSent(full)).toHaveLength(100);
    expect(logLine(full)).toBe(`${ENTRY_LINE} notice=sent`);
  });

  it('sends valid JSON when the sender name holds a quote and a backslash', () => {
    const from = `Ops "Desk" \\ team <${SENDER}>`;
    const r = runHook({}, { envFile: ENV_FILE.replace(`EMAIL_FROM_ADDRESS="${FROM}"`, `EMAIL_FROM_ADDRESS='${from}'`) });
    expect(batchSent(r).map((e) => e.from)).toEqual([from, from, from]);
    expect(logLine(r)).toMatch(/ notice=sent$/);
  });

  it('sends nothing, and says why, when the mail settings or the notice text are missing', () => {
    const noKey = runHook({}, { envFile: ENV_FILE.replace(`RESEND_API_KEY=${KEY}\n`, '') });
    expect(noKey.calls.curl).toBeUndefined();
    expect(logLine(noKey)).toBe(`${ENTRY_LINE} notice=failed:config`);

    // A sender with no address in it cannot be the visible recipient.
    const noSender = runHook({}, { envFile: ENV_FILE.replace(`EMAIL_FROM_ADDRESS="${FROM}"`, 'EMAIL_FROM_ADDRESS="MAK-AI RAI"') });
    expect(noSender.calls.curl).toBeUndefined();
    expect(logLine(noSender)).toBe(`${ENTRY_LINE} notice=failed:config`);

    const noText = runHook({ MAKRAI_NOTICE_FILE: '/nonexistent/break-glass-notice.txt' });
    expect(noText.calls.curl).toBeUndefined();
    expect(logLine(noText)).toBe(`${ENTRY_LINE} notice=failed:template text=missing`);
  });

  it('reads .env and the notice text only from regular files that root or the operator owns', () => {
    const fifo = (p: string) => execFileSync('mkfifo', [p]);
    const cases: [string, Options, Record<string, string>, string][] = [
      ['.env is a FIFO', { prepare: (d) => (fifo(path.join(d, 'env.fifo')), { MAKRAI_ENV_FILE: path.join(d, 'env.fifo') }) }, {},
        'entry=FAILED notice=failed:config env=type'],
      ['.env is a symlink', {
        prepare: (d) => (symlinkSync(path.join(d, '.env'), path.join(d, 'env.link')), { MAKRAI_ENV_FILE: path.join(d, 'env.link') }),
      }, {}, 'entry=FAILED notice=failed:config env=symlink'],
      ['.env is missing', {}, { MAKRAI_ENV_FILE: '/nonexistent/.env' }, 'entry=FAILED notice=failed:config env=missing'],
      ['the notice text is a FIFO', {
        prepare: (d) => (fifo(path.join(d, 'notice.fifo')), { MAKRAI_NOTICE_FILE: path.join(d, 'notice.fifo') }),
      }, {}, `${ENTRY_LINE} notice=failed:template text=type`],
      ['the notice text is a symlink', {
        prepare: (d) => (symlinkSync(path.resolve(NOTICE), path.join(d, 'notice.link')), { MAKRAI_NOTICE_FILE: path.join(d, 'notice.link') }),
      }, {}, `${ENTRY_LINE} notice=failed:template text=symlink`],
    ];
    if (process.getuid?.() !== 0) {
      // "The operator" is now root, the owner of /: this user's files are no one's to trust.
      cases.push(['neither file is owned by root or the operator', {}, { MAKRAI_APP_DIR: '/' },
        'entry=FAILED notice=failed:template env=owner text=owner']);
    }
    for (const [what, opts, env, line] of cases) {
      const r = runHook(env, opts);
      expect({ what, status: r.status }).toEqual({ what, status: 0 });
      expect(r.ms, `${what}: held the hook for ${r.ms} ms`).toBeLessThan(5000);
      expect(logLine(r), what).toBe(line);
      if (line.includes('notice=failed:')) expect(r.calls.curl, `${what}: curl was called`).toBeUndefined();
    }
  });

  it('never logs an address', () => {
    for (const env of [{}, { STUB_CURL: 'fail' }, { STUB_DOCKER: 'fail' }]) {
      expect(logLine(runHook(env))).not.toContain('@');
    }
  });

  it('logs notice=failed with the HTTP status when Resend does not accept it', () => {
    expect(logLine(runHook({ CURL_CODE: '422', CURL_BODY: '{"message":"x"}' }))).toBe(`${ENTRY_LINE} notice=failed:422`);
    expect(logLine(runHook({ STUB_CURL: 'fail' }))).toMatch(/ notice=failed:000$/);
  });

  it('still tells ALERT_TO, and logs notice=failed:recipients, when the owner list cannot be read', () => {
    const partial = runHook({ STUB_DOCKER: 'partial', DOCKER_OUT: `${ENTRY_ID}|7|${ENTRY_HASH}` });
    expect(logLine(partial)).toBe(`${ENTRY_LINE} notice=failed:recipients`);
    expect(batchSent(partial).map((e) => e.to)).toEqual([[ALERT_TO]]);

    const down = runHook({ STUB_DOCKER: 'fail' });
    expect(logLine(down)).toBe('entry=FAILED notice=failed:recipients');
    expect(batchSent(down)[0].text).toContain('FAILED');
  });

  it('reads only its own keys from .env, as text, without running it', () => {
    // ENV_FILE also sets BG_TIMEOUT=999, so the timeout test above shows .env cannot
    // lengthen the wait; only the environment pam_exec passes can set it.
    const r = runHook({});
    expect(r.executedEnv, '.env was executed').toBe(false);
    // Unquoted, double-quoted and single-quoted values all read back bare.
    expect(r.calls.docker?.[0]).toEqual(expect.arrayContaining(['-U', 'makrai', '-d', 'makrai']));
    expect(batchSent(r)[0]).toMatchObject({ from: FROM, to: [ALERT_TO] });
    expect(r.stdin.curl).toContain(`Bearer ${KEY}"`);
  });
});

describe('the break-glass hook, its notice and the login stack, read as text', () => {
  const hook = readFileSync(HOOK, 'utf8');
  /** Executable lines: whole-line comments and blank lines dropped. */
  const code = hook.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

  it('notice carries only time and entry id, and no event', () => {
    const tpl = readFileSync(NOTICE, 'utf8');
    const placeholders = new Set([...tpl.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]));
    expect([...placeholders].sort()).toEqual(['ENTRY_ID', 'TIME_UTC']);
    expect(tpl).not.toContain('{EVENT}');
    expect(tpl).not.toContain('Event:');
    expect(Math.max(...tpl.split('\n').map((l) => l.length))).toBeLessThanOrEqual(80);
    // The hook fills {NAME} tokens only; a shell-style reference would be literal text
    // today and a leak the day someone renders it with envsubst.
    expect(tpl).not.toMatch(/[$`]/);
    expect(tpl.split('\n')[0]).toMatch(/^Subject: \S/);
    expect(tpl.split('\n')[1]).toBe('');
  });

  it('16d: the notice file is exactly the ruled text and has no other placeholder', () => {
    const tpl = readFileSync(NOTICE, 'utf8');
    expect(tpl).toBe(
      [
        'Subject: MAK-AI RAI Platform: emergency access to the server was used',
        '',
        'Someone signed in to the server that runs the MAK-AI RAI Platform. They used the',
        'emergency access, which is only for when the normal way in has failed.',
        '',
        'Time (UTC): {TIME_UTC}',
        'Reference: {ENTRY_ID}',
        '',
        'We send this email to the Owners and Admins of every organisation on the',
        'platform each time emergency access is used. You do not need to do anything.',
        '',
      ].join('\n'),
    );
    const r = renderedNotice('2026-11-02T08:00:00Z', 'ENTRY-1');
    expect(r.subject).toBe('MAK-AI RAI Platform: emergency access to the server was used');
    expect(r.text).toContain('Time (UTC): 2026-11-02T08:00:00Z\nReference: ENTRY-1');
    expect(`${r.subject}\n${r.text}`).not.toMatch(/[{}]/);
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
    for (const cmd of ['docker', 'curl', 'logger', 'stat', 'head']) {
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
