import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Releases are built in CI and deployed by digest (M0 "digest equals tagged
 * release", M0-01, INFRA-13, G2-15).
 *
 * Until this task the production host built its own image from a checkout
 * (`docker compose up -d --build`), so what ran was whatever the host's cache,
 * registry and network produced that minute, and no digest said which commit it
 * was. Now `release.yml` builds the `runner` and `migrator` targets on a tag,
 * pushes them to ghcr.io and writes both digests into the release body; the
 * compose file takes each image reference from the environment and has no
 * `build:`; `image-scan.yml` scans those digests, and the third-party ones,
 * every day.
 *
 * Five obligations ride on the workflows, and each has a test below:
 *   P1  only the release job can write packages and contents.
 *   P2  every action is pinned by commit SHA.
 *   P3  a release builds only when the tag equals package.json's version and the
 *       tagged commit is on main.
 *   P4  the server's pull credential (owner step, no code here).
 *   P5  Compose refuses to start without an image reference.
 *
 * The workflows are read with regular expressions, as `dependency-surveillance`
 * and `ci-env-completeness` read ci.yml and for the same reason: `js-yaml` is
 * only a transitive dependency, so importing it would make this guard fail for a
 * reason unrelated to what it guards. Every parse is asserted non-empty, and
 * comment lines are removed first, so a sentence in a comment cannot satisfy a
 * check meant for a line of YAML.
 *
 * Where a workflow step is plain shell with a decision in it (the tag check, the
 * main check, the image list), the step's own script is run here against a
 * scratch repository, so the test proves what the line does and not only that it
 * is there. What no test can prove is the registry round trip and Trivy's own
 * verdict; the first release run and the first scan run are that proof.
 */

const REPO_ROOT = join(__dirname, '../..');
const WORKFLOWS_DIR = '.github/workflows';
const RELEASE = `${WORKFLOWS_DIR}/release.yml`;
const IMAGE_SCAN = `${WORKFLOWS_DIR}/image-scan.yml`;
const COMPOSE = 'docker/docker-compose.prod.yml';
const DOCKERFILE = 'docker/Dockerfile';

function read(rel: string): string {
  expect(existsSync(join(REPO_ROOT, rel)), `${rel} should exist`).toBe(true);
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** The file's lines with comment-only lines removed. */
function withoutComments(src: string): string[] {
  return src.split('\n').filter((l) => !/^\s*#/.test(l));
}

/** The lines nested under `lines[at]`: blank, or indented deeper than it. */
function nestedUnder(lines: string[], at: number): string[] {
  const indent = lines[at].match(/^ */)![0].length;
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && lines[i].match(/^ */)![0].length <= indent) break;
    out.push(lines[i]);
  }
  return out;
}

/** The body of the top-level (column 0) key `key`, or undefined. */
function topLevel(lines: string[], key: string): string[] | undefined {
  const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  return at === -1 ? undefined : nestedUnder(lines, at);
}

/** `key: value` lines at exactly `indent` spaces, as a map. Quotes are removed. */
function mapAt(lines: string[], indent: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const m = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*(.*)$`).exec(l);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

type Perms = Record<string, string>;

interface Step {
  name: string;
  uses: string | undefined;
  cond: string | undefined;
  env: Record<string, string>;
  withs: Record<string, string>;
  /** The `run:` script, dedented. Empty for a `uses:` step. */
  run: string;
}

interface Job {
  id: string;
  needs: string[];
  /** The job's own `permissions:` block, or undefined when it has none. */
  permissions: Perms | undefined;
  steps: Step[];
}

interface Workflow {
  file: string;
  lines: string[];
  permissions: Perms | undefined;
  env: Record<string, string>;
  jobs: Job[];
}

function parseStep(chunk: string[]): Step {
  // `      - name: X` is a key at column 8 like the rest of the step.
  const lines = chunk.map((l, i) => (i === 0 ? l.replace(/^( {6})- /, '$1  ') : l));
  const keys = mapAt(lines, 8);
  const sub = (key: string): string[] => {
    const at = lines.findIndex((l) => new RegExp(`^ {8}${key}:\\s*$`).test(l));
    return at === -1 ? [] : nestedUnder(lines, at);
  };
  let run = '';
  const runAt = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (runAt > -1) {
    const inline = lines[runAt].replace(/^ {8}run:\s*/, '').trim();
    if (/^[|>][-+]?$/.test(inline)) {
      run = nestedUnder(lines, runAt)
        .map((l) => l.replace(/^ {10}/, ''))
        .join('\n')
        .trim();
    } else {
      run = inline;
    }
  }
  return { name: keys.name ?? '', uses: keys.uses, cond: keys.if, env: mapAt(sub('env'), 10), withs: mapAt(sub('with'), 10), run };
}

function parseJob(id: string, body: string[]): Job {
  const needsRaw = mapAt(body, 4).needs ?? '';
  const needs = needsRaw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const permAt = body.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  const permissions = permAt === -1 ? undefined : mapAt(nestedUnder(body, permAt), 6);
  const stepsAt = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  const chunks: string[][] = [];
  for (const l of stepsAt === -1 ? [] : nestedUnder(body, stepsAt)) {
    if (/^ {6}- /.test(l)) chunks.push([l]);
    else if (chunks.length > 0) chunks[chunks.length - 1].push(l);
  }
  return { id, needs, permissions, steps: chunks.map(parseStep) };
}

function parseWorkflow(file: string): Workflow {
  const lines = withoutComments(read(file));
  const jobsBody = topLevel(lines, 'jobs');
  expect(jobsBody, `${file} should have a jobs: block`).toBeDefined();
  const jobs: Job[] = [];
  let current: { id: string; body: string[] } | undefined;
  const raw: { id: string; body: string[] }[] = [];
  for (const l of jobsBody!) {
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l);
    if (header) {
      current = { id: header[1], body: [] };
      raw.push(current);
    } else if (current) {
      current.body.push(l);
    }
  }
  for (const r of raw) jobs.push(parseJob(r.id, r.body));
  expect(jobs.length, `parsed no jobs from ${file} -- the parser, not the workflow, is wrong`).toBeGreaterThan(0);
  const perm = topLevel(lines, 'permissions');
  return {
    file,
    lines,
    permissions: perm ? mapAt(perm, 2) : undefined,
    env: mapAt(topLevel(lines, 'env') ?? [], 2),
    jobs,
  };
}

function jobOf(w: Workflow, id: string): Job {
  const found = w.jobs.find((j) => j.id === id);
  expect(found, `${w.file} should have a \`${id}\` job`).toBeDefined();
  return found!;
}

function stepRunning(job: Job, pattern: RegExp, what: string): Step {
  const found = job.steps.find((s) => pattern.test(s.run));
  expect(found, `${job.id} should have a step that ${what}`).toBeDefined();
  return found!;
}

/** The permissions a job actually gets: its own block, else the workflow's. */
function effective(w: Workflow, j: Job): Perms {
  return j.permissions ?? w.permissions ?? {};
}

/** Every `uses:` value in `file`, comments after the value kept. */
function usesIn(file: string): string[] {
  return withoutComments(read(file)).flatMap((l) => {
    const m = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
}

/** Workflow files, so a workflow added later is checked the moment it exists. */
function workflowFiles(): string[] {
  return readdirSync(join(REPO_ROOT, WORKFLOWS_DIR))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `${WORKFLOWS_DIR}/${f}`);
}

// ---------------------------------------------------------------------------
// Running a step's own script

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `t18-${prefix}-`));
  scratch.push(dir);
  return dir;
}

/** What GitHub runs for `run:` with the default shell on Linux. */
function runScript(script: string, cwd: string, env: Record<string, string>, extraPath?: string) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: envOf({ PATH: `${extraPath ? `${extraPath}:` : ''}${process.env.PATH ?? ''}`, HOME: cwd, LC_ALL: 'C', ...env }),
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: envOf({
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    }),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** `spawnSync` wants a full `ProcessEnv`; a scratch environment is deliberately small. */
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

const SHA256 = (c: string) => `sha256:${c.repeat(64)}`;

// ---------------------------------------------------------------------------

describe('release.yml', () => {
  const load = () => parseWorkflow(RELEASE);

  it('release builds on version tags only', () => {
    const w = load();
    const on = topLevel(w.lines, 'on');
    expect(on, 'release.yml should have an on: block').toBeDefined();
    expect(Object.keys(mapAt(on!, 2)), 'the only trigger is a push').toEqual(['push']);
    const push = nestedUnder(on!, on!.findIndex((l) => /^ {2}push:/.test(l)));
    expect(Object.keys(mapAt(push, 4)), 'a push of a tag, not of a branch').toEqual(['tags']);

    const patterns = [...push.join('\n').matchAll(/^ {6}- ['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
    expect(patterns.length, 'no tag pattern found').toBeGreaterThan(0);

    // GitHub's filter syntax, for the subset used here: `.` is a literal dot,
    // `+` repeats the character or class before it, `[0-9]` is a class.
    const matches = (name: string) =>
      patterns.some((p) => new RegExp(`^${p.replace(/[.\\^$|(){}*]/g, '\\$&')}$`).test(name));
    for (const ok of ['v0.2.0', 'v1.20.300']) expect(matches(ok), `${ok} should start a release`).toBe(true);
    for (const bad of ['v0.2', 'v0.2.0.1', 'v0.2.0-rc1', 'v0.2.x', '0.2.0', 'vv0.2.0', 'release-v0.2.0', 'v0.2.0/x']) {
      expect(matches(bad), `${bad} should not start a release`).toBe(false);
    }
  });

  it('release refuses a tag that differs from package.json', () => {
    const w = load();
    const gate = jobOf(w, 'gate');
    const step = stepRunning(gate, /GITHUB_REF_NAME#v/, 'compares the tag with package.json');
    expect(step.run).toContain(
      'test "${GITHUB_REF_NAME#v}" = "$(node -p "require(\'./package.json\').version")"',
    );

    const dir = tempDir('version');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0' }));
    const at = (tag: string) => runScript(step.run, dir, { GITHUB_REF_NAME: tag });
    expect(at('v0.2.0').status, 'the matching tag passes').toBe(0);
    for (const tag of ['v0.2.1', 'v0.3.0', 'v0.1.0', 'v0.2.0-rc1', '0.2.0x']) {
      const r = at(tag);
      expect(r.status, `${tag} must not pass: ${r.out}`).not.toBe(0);
    }
  });

  it('release accepts only a plain vX.Y.Z tag, whatever the trigger lets through', () => {
    const w = load();
    const step = stepRunning(jobOf(w, 'gate'), /\^v\[0-9\]/, 'checks the shape of the tag');
    const dir = tempDir('shape');
    expect(runScript(step.run, dir, { GITHUB_REF_NAME: 'v10.20.30' }).status).toBe(0);
    for (const tag of ['v1.2', 'v1.2.3-rc1', 'v1.2.3;id', 'v1.2.3$(id)', 'v1.2.3 ', 'x1.2.3', 'v1.2.3\nv1.2.3']) {
      expect(runScript(step.run, dir, { GITHUB_REF_NAME: tag }).status, JSON.stringify(tag)).not.toBe(0);
    }
  });

  it('release refuses a commit not on main', () => {
    const w = load();
    const gate = jobOf(w, 'gate');
    const step = stepRunning(gate, /merge-base --is-ancestor/, 'checks the commit is on main');
    expect(step.run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');

    // The check reads origin/main, so the checkout must have fetched it: a
    // shallow clone has no history to walk and the check cannot pass honestly.
    const checkout = gate.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.withs['fetch-depth'], 'the gate must fetch full history').toBe('0');

    const dir = tempDir('main');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
    const first = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'two');
    const tip = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', tip);
    git(dir, 'checkout', '-q', '-b', 'side', first);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'side');
    const side = git(dir, 'rev-parse', 'HEAD');

    const at = (sha: string) => runScript(step.run, dir, { GITHUB_SHA: sha });
    expect(at(tip).status, 'main\'s tip passes').toBe(0);
    expect(at(first).status, 'an earlier commit of main passes').toBe(0);
    const refused = at(side);
    expect(refused.status, `a commit only on a branch must not pass: ${refused.out}`).not.toBe(0);

    // Fail closed when there is no origin/main to compare with.
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(at(tip).status, 'no origin/main means no release').not.toBe(0);
  });

  it('release does not rebuild a tag that already has a release', () => {
    const w = load();
    const step = stepRunning(jobOf(w, 'gate'), /gh release view/, 'looks for an existing release');
    const dir = tempDir('exists');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ -f "$FAKE_RELEASE_BODY" ] && exit 0\necho "release not found" >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const body = join(dir, 'body.md');
    writeFileSync(body, 'web: x\n');
    const env = { GITHUB_REF_NAME: 'v0.2.0', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'unused', FAKE_RELEASE_BODY: body };
    expect(runScript(step.run, dir, env, bin).status, 'a tag with a release is refused').not.toBe(0);
    expect(runScript(step.run, dir, { ...env, FAKE_RELEASE_BODY: join(dir, 'absent') }, bin).status).toBe(0);
  });

  it('release checks everything before it builds or pushes anything', () => {
    const w = load();
    const gate = jobOf(w, 'gate');
    const release = jobOf(w, 'release');
    expect(release.needs, 'the release job must wait for the gate').toContain('gate');
    expect(
      gate.steps.filter((s) => /\bdocker\b/.test(s.run) || s.uses?.startsWith('docker/')),
      'the gate builds and pushes nothing',
    ).toEqual([]);
    expect(w.jobs.map((j) => j.id).sort(), 'two jobs: the gate and the release').toEqual(['gate', 'release']);
  });

  it('only the release job can write packages and contents (P1)', () => {
    const w = load();
    expect(w.permissions, 'the workflow default is read-only').toEqual({ contents: 'read' });
    expect(effective(w, jobOf(w, 'gate')), 'the gate only reads').toEqual({ contents: 'read' });
    expect(jobOf(w, 'release').permissions, 'the release job writes what it publishes, and nothing else').toEqual({
      contents: 'write',
      packages: 'write',
    });

    // And across every workflow in the repository, this is the one job that can write.
    const writers: string[] = [];
    for (const file of workflowFiles()) {
      const wf = parseWorkflow(file);
      const top = Object.values(wf.permissions ?? {});
      if (top.includes('write') || top.includes('write-all')) writers.push(`${file} (workflow level)`);
      for (const j of wf.jobs) {
        if (Object.values(j.permissions ?? {}).some((v) => v.startsWith('write'))) writers.push(`${file}#${j.id}`);
      }
    }
    expect(writers).toEqual([`${RELEASE}#release`]);
  });

  it('builds the runner and migrator targets and publishes both digests', () => {
    const w = load();
    const release = jobOf(w, 'release');
    const build = stepRunning(release, /docker build/, 'builds the images');
    const dockerfile = read(DOCKERFILE);
    for (const target of ['runner', 'migrator']) {
      expect(build.run, `release.yml should build the ${target} target`).toMatch(new RegExp(`\\b${target}\\b`));
      expect(dockerfile, `${DOCKERFILE} should have a ${target} stage`).toMatch(
        new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${target}\\s*$`, 'mi'),
      );
    }
    expect(build.run).toContain('--target "$target"');

    // Image names: ghcr.io/<owner, lowercased>/makrai-web and makrai-migrator.
    const names = stepRunning(release, /OWNER,,/, 'lowercases the repository owner');
    expect(names.env.OWNER).toBe('${{ github.repository_owner }}');
    expect(names.run).toContain('ghcr.io/${owner_lc}/makrai-web');
    expect(names.run).toContain('ghcr.io/${owner_lc}/makrai-migrator');

    // The digest is read back from the registry and shape-checked before use.
    expect(build.run).toMatch(/imagetools inspect/);
    expect(build.run).toMatch(/\^sha256:\[0-9a-f\]\{64\}\$/);

    const create = stepRunning(release, /gh release create/, 'creates the release');
    expect(create.run).toContain('--verify-tag');
    expect(create.run).toMatch(/web: %s/);
    expect(create.run).toMatch(/migrator: %s/);
    expect(create.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(
      release.steps.findIndex((s) => s === create),
      'the release is created after the images are pushed',
    ).toBeGreaterThan(release.steps.findIndex((s) => s === build));
  });

  it('logs in to ghcr.io with the job token, on stdin, and logs out again', () => {
    const w = load();
    const release = jobOf(w, 'release');
    const login = stepRunning(release, /docker login ghcr\.io/, 'logs in to ghcr.io');
    expect(login.run).toContain('--password-stdin');
    expect(login.env.REGISTRY_TOKEN).toBe('${{ github.token }}');
    expect(login.run, 'the token never travels in argv').not.toMatch(/-p\b|--password(?!-stdin)/);
    const logout = stepRunning(release, /docker logout ghcr\.io/, 'logs out of ghcr.io');
    expect(logout.cond, 'it runs even when an earlier step failed').toBe('always()');
  });

  it('package.json holds a plain X.Y.Z that package-lock.json agrees with', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(pkg.version, 'a release tag is vX.Y.Z, so the version must be X.Y.Z').toMatch(/^\d+\.\d+\.\d+$/);
    // 0.2.0 is the first release; every later deploy bumps from there (runbook section 8).
    const [major, minor] = pkg.version.split('.').map(Number);
    expect(major > 0 || minor >= 2, 'the first release is 0.2.0, so the version is not below it').toBe(true);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});

describe('the release job\'s steps, run against stand-ins for docker and gh', () => {
  const web = `ghcr.io/example-owner/makrai-web@${SHA256('a')}`;
  const migrator = `ghcr.io/example-owner/makrai-migrator@${SHA256('b')}`;
  const release = () => jobOf(parseWorkflow(RELEASE), 'release');

  function standIns(): { dir: string; bin: string; log: string; outputs: string } {
    const dir = tempDir('release-job');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    return { dir, bin, log: join(dir, 'calls.log'), outputs: join(dir, 'github-output') };
  }

  it('names the images with the owner lowercased, and refuses an odd owner', () => {
    const step = stepRunning(release(), /OWNER,,/, 'names the images');
    const { dir, outputs } = standIns();
    const r = runScript(step.run, dir, { OWNER: 'Example-Owner', GITHUB_OUTPUT: outputs });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(outputs, 'utf8').trim().split('\n')).toEqual([
      'web=ghcr.io/example-owner/makrai-web',
      'migrator=ghcr.io/example-owner/makrai-migrator',
    ]);
    for (const odd of ['', '-x', 'x-', 'a b', 'a/b', 'a;id']) {
      expect(runScript(step.run, dir, { OWNER: odd, GITHUB_OUTPUT: join(dir, 'o2') }).status, JSON.stringify(odd)).not.toBe(0);
    }
  });

  function buildWith(digestOf: (image: 'web' | 'migrator') => string) {
    const step = stepRunning(release(), /docker build/, 'builds the images');
    const { dir, bin, log, outputs } = standIns();
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/bash',
        'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
        'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then printf \'"%s"\' "$(printf \'%s\' "$4" | sed -e "s/^.*makrai-web:.*$/$FAKE_WEB_DIGEST/" -e "s/^.*makrai-migrator:.*$/$FAKE_MIGRATOR_DIGEST/")"; fi',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const r = runScript(
      step.run,
      dir,
      {
        WEB_REPO: 'ghcr.io/example-owner/makrai-web',
        MIGRATOR_REPO: 'ghcr.io/example-owner/makrai-migrator',
        SOURCE: 'https://example.invalid/example-owner/example-repo',
        GITHUB_REF_NAME: 'v0.2.0',
        GITHUB_SHA: 'f'.repeat(40),
        GITHUB_OUTPUT: outputs,
        FAKE_LOG: log,
        FAKE_WEB_DIGEST: digestOf('web'),
        FAKE_MIGRATOR_DIGEST: digestOf('migrator'),
      },
      bin,
    );
    return {
      status: r.status,
      out: r.out,
      calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
      outputs: existsSync(outputs) ? readFileSync(outputs, 'utf8').split('\n').filter(Boolean) : [],
    };
  }

  it('builds migrator then runner, pushes each, and records name@digest from the registry', () => {
    const r = buildWith((image) => (image === 'web' ? SHA256('a') : SHA256('b')));
    expect(r.status, r.out).toBe(0);
    expect(r.outputs).toEqual([`migrator=${migrator}`, `web=${web}`]);
    const builds = r.calls.filter((c) => c.startsWith('build '));
    expect(builds).toHaveLength(2);
    expect(builds[0]).toContain('--target migrator');
    expect(builds[0]).toContain('--tag ghcr.io/example-owner/makrai-migrator:v0.2.0');
    expect(builds[1]).toContain('--target runner');
    expect(builds[1]).toContain('--tag ghcr.io/example-owner/makrai-web:v0.2.0');
    for (const b of builds) {
      expect(b).toContain('--file docker/Dockerfile');
      expect(b).toContain(`org.opencontainers.image.revision=${'f'.repeat(40)}`);
      expect(b).toContain('org.opencontainers.image.version=0.2.0');
      expect(b.endsWith(' .'), 'the context is the repository root').toBe(true);
    }
    expect(r.calls.filter((c) => c.startsWith('push '))).toEqual([
      'push ghcr.io/example-owner/makrai-migrator:v0.2.0',
      'push ghcr.io/example-owner/makrai-web:v0.2.0',
    ]);
  });

  it('writes no reference for an image whose digest cannot be read', () => {
    for (const bad of ['', 'latest', 'sha256:abc', `sha256:${'g'.repeat(64)}`, `${SHA256('a')}0`]) {
      const r = buildWith((image) => (image === 'web' ? bad : SHA256('b')));
      expect(r.status, `web digest ${JSON.stringify(bad)}`).not.toBe(0);
      expect(r.outputs.some((o) => o.startsWith('web=')), 'no web reference after a bad digest').toBe(false);
    }
  });

  it('creates the release with exactly the web and migrator lines, and reads them back', () => {
    const step = stepRunning(release(), /gh release create/, 'creates the release');
    const { dir, bin, log } = standIns();
    const temp = join(dir, 'runner-temp');
    mkdirSync(temp);
    // Stands in for GitHub: `create` stores the notes file, `view` hands them back.
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/bash',
        'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
        'if [ "$1 $2" = "release create" ]; then while [ $# -gt 0 ]; do [ "$1" = "--notes-file" ] && cp "$2" "$FAKE_STORE"; shift; done; fi',
        'if [ "$1 $2" = "release view" ]; then cat "$FAKE_STORE"; fi',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const store = join(dir, 'stored-notes');
    const env = {
      GH_TOKEN: 'unused',
      GITHUB_REF_NAME: 'v0.2.0',
      GITHUB_REPOSITORY: 'example-owner/example-repo',
      RUNNER_TEMP: temp,
      WEB_REF: web,
      MIGRATOR_REF: migrator,
      FAKE_LOG: log,
      FAKE_STORE: store,
    };
    const r = runScript(step.run, dir, env, bin);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(store, 'utf8')).toBe(`web: ${web}\nmigrator: ${migrator}\n`);
    const create = readFileSync(log, 'utf8').split('\n').find((c) => c.startsWith('release create'))!;
    expect(create).toContain('release create v0.2.0');
    expect(create).toContain('--verify-tag');

    const bad = runScript(step.run, dir, { ...env, MIGRATOR_REF: 'ghcr.io/example-owner/makrai-migrator:v0.2.0' }, bin);
    expect(bad.status, 'a body that does not carry two digests is not a release').not.toBe(0);
  });
});

describe('every action is pinned by SHA (P2)', () => {
  /** Workflows that predate P2 and still pin by tag, each with the reason it is allowed. */
  const PINNED_BY_TAG: Record<string, string> = {
    'ci.yml': 'checkout, setup-node and upload-artifact are still pinned by major tag; moving them is a change to the required CI workflow, outside the release task',
  };

  // A full commit SHA, then the version it stands for, so a reader and Dependabot can see it.
  const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\S*$/;
  const unpinned = (file: string) => usesIn(file).filter((u) => !PINNED.test(u) && !/^\.\//.test(u));

  it('covers release.yml and image-scan.yml', () => {
    for (const file of [RELEASE, IMAGE_SCAN]) {
      expect(usesIn(file).length, `${file}: no uses: line found`).toBeGreaterThan(0);
      expect(unpinned(file), `${file}: actions not pinned by 40-hex SHA with a # vX.Y.Z comment`).toEqual([]);
    }
  });

  it('covers any workflow added later, apart from the ones that say why not', () => {
    const files = workflowFiles();
    expect(files, 'discovery should reach the two new workflows').toEqual(expect.arrayContaining([RELEASE, IMAGE_SCAN]));
    const bad = files
      .filter((f) => !(f.slice(WORKFLOWS_DIR.length + 1) in PINNED_BY_TAG))
      .flatMap((f) => unpinned(f).map((u) => `${f}: ${u}`));
    expect(bad).toEqual([]);
  });

  it('lists an exemption only while it is still needed', () => {
    for (const [name, reason] of Object.entries(PINNED_BY_TAG)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
      expect(unpinned(`${WORKFLOWS_DIR}/${name}`).length, `${name} is fully pinned now: remove the exemption`).toBeGreaterThan(0);
    }
  });

  it('accepts a SHA with a version comment and nothing looser', () => {
    const sha = 'a'.repeat(40);
    expect(PINNED.test(`actions/checkout@${sha} # v7.0.1`)).toBe(true);
    for (const loose of [
      'actions/checkout@v7',
      `actions/checkout@${sha}`,
      `actions/checkout@${'a'.repeat(39)} # v7.0.1`,
      `actions/checkout@${sha.toUpperCase()} # v7.0.1`,
      `actions/checkout@${sha} # latest`,
      `docker://alpine@${SHA256('a')}`,
    ]) {
      expect(PINNED.test(loose), loose).toBe(false);
    }
  });
});

describe('no workflow script interpolates an expression', () => {
  // `${{ ... }}` inside a `run:` is pasted into the shell text before it runs, so
  // a tag name, a branch name or an input containing `$(...)` runs as code. A tag
  // name may hold `$`, `;`, backticks and parentheses. Values reach the shell
  // through `env:` and are read as variables.
  it.each([RELEASE, IMAGE_SCAN])('%s keeps expressions out of run: scripts', (file) => {
    const w = parseWorkflow(file);
    const steps = w.jobs.flatMap((j) => j.steps.filter((s) => s.run !== ''));
    expect(steps.length, `${file}: no run: step parsed`).toBeGreaterThan(2);
    expect(steps.filter((s) => s.run.includes('${{')).map((s) => s.name)).toEqual([]);
  });
});

describe('production compose runs images by reference only (P5)', () => {
  const lines = withoutComments(read(COMPOSE));
  const servicesBody = topLevel(lines, 'services')!;

  /** Each service's lines, by name. */
  const services: Record<string, string[]> = {};
  let current: string | undefined;
  for (const l of servicesBody) {
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l);
    if (header) {
      current = header[1];
      services[current] = [];
    } else if (current) {
      services[current].push(l);
    }
  }
  const imageOf = (name: string) => /^ {4}image:\s*(.+?)\s*$/m.exec(services[name].join('\n'))?.[1];

  it('names the web and migrator images by required variable, with no build:', () => {
    expect(Object.keys(services).sort()).toEqual(['migrator', 'nextjs', 'nginx', 'postgres']);
    expect(imageOf('nextjs')).toMatch(/^\$\{WEB_IMAGE:\?set WEB_IMAGE to ghcr\.io\/<owner>\/makrai-web@sha256:[^}]*\}$/);
    expect(imageOf('migrator')).toMatch(
      /^\$\{MIGRATOR_IMAGE:\?set MIGRATOR_IMAGE to ghcr\.io\/<owner>\/makrai-migrator@sha256:[^}]*\}$/,
    );
    for (const [name, body] of Object.entries(services)) {
      expect(body.some((l) => /^ {4}build:/.test(l)), `${name} must not build on the host`).toBe(false);
      expect(imageOf(name), `${name} needs an image:`).toBeDefined();
    }
    expect(lines.some((l) => /^\s*build:/.test(l)), 'no build: anywhere in the production compose file').toBe(false);
  });

  it('keeps the two third-party images pinned by digest', () => {
    for (const name of ['postgres', 'nginx']) {
      expect(imageOf(name), `${name} stays pinned`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: envOf({ PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env }),
    });

  // `config` only reads the file: no daemon, no pull, no build.
  it.skipIf(compose.status !== 0)('Compose stops without WEB_IMAGE or MIGRATOR_IMAGE, and runs the references it is given', () => {
    const web = `ghcr.io/example-owner/makrai-web@${SHA256('a')}`;
    const migrator = `ghcr.io/example-owner/makrai-migrator@${SHA256('b')}`;

    const none = run({}, 'config', '-q');
    expect(none.status, 'no image reference, no start').not.toBe(0);
    // Compose names whichever of the two variables it meets first, and the order is not fixed.
    expect(none.stderr).toMatch(/required variable (WEB|MIGRATOR)_IMAGE is missing a value: set (WEB|MIGRATOR)_IMAGE to ghcr\.io/);

    const onlyMigrator = run({ MIGRATOR_IMAGE: migrator }, 'config', '-q');
    expect(onlyMigrator.status, 'the web image needs its own reference').not.toBe(0);
    expect(onlyMigrator.stderr).toMatch(/WEB_IMAGE/);

    const onlyWeb = run({ WEB_IMAGE: web }, 'config', '-q');
    expect(onlyWeb.status, 'the migrator needs its own reference').not.toBe(0);
    expect(onlyWeb.stderr).toMatch(/MIGRATOR_IMAGE/);

    const empty = run({ WEB_IMAGE: '', MIGRATOR_IMAGE: migrator }, 'config', '-q');
    expect(empty.status, 'an empty value is no reference').not.toBe(0);

    const both = run({ WEB_IMAGE: web, MIGRATOR_IMAGE: migrator }, '--profile', 'tools', 'config', '--images');
    expect(both.status, both.stderr).toBe(0);
    const images = both.stdout.trim().split('\n');
    expect(images).toContain(web);
    expect(images).toContain(migrator);
  });
});

describe('image-scan.yml', () => {
  const load = () => {
    const w = parseWorkflow(IMAGE_SCAN);
    return { w, scan: jobOf(w, 'scan'), text: w.lines.join('\n') };
  };

  it('runs daily and on demand, and on nothing else', () => {
    const { w } = load();
    const on = topLevel(w.lines, 'on')!;
    expect(Object.keys(mapAt(on, 2)).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(on.join('\n')).toMatch(/^ {4}- cron: '47 4 \* \* \*'\s*$/m);
    const inputs = nestedUnder(on, on.findIndex((l) => /^ {4}inputs:/.test(l)));
    expect(Object.keys(mapAt(inputs, 6)), 'one input').toEqual(['scanners']);
    expect(mapAt(nestedUnder(inputs, inputs.findIndex((l) => /^ {6}scanners:/.test(l))), 8).default).toBe('vuln');
  });

  it('only reads: the scan job adds packages: read and nothing more (P1)', () => {
    const { w, scan } = load();
    expect(w.permissions).toEqual({ contents: 'read' });
    expect(scan.permissions).toEqual({ contents: 'read', packages: 'read' });
  });

  it('image scan fails on fixable criticals and pings its check', () => {
    const { scan, text } = load();
    const step = stepRunning(scan, /docker run/, 'runs Trivy');
    expect(step.run).toContain('"$TRIVY_IMAGE"');
    expect(step.run).toContain('--severity CRITICAL');
    expect(step.run).toContain('--ignore-unfixed');
    expect(step.run).toContain('--exit-code 1');
    expect(step.run).toContain('--scanners "$SCANNERS"');
    expect(step.run, 'the scan must not be turned into a pass').not.toMatch(/\|\|\s*true|--exit-code\s+0/);
    expect(text, 'no step may continue on error').not.toMatch(/continue-on-error/);
    // Every image is scanned and a failure is remembered, then the step exits non-zero.
    expect(step.run).toMatch(/exit "\$rc"/);

    const ping = scan.steps[scan.steps.length - 1];
    expect(ping.name, 'the ping is the last step').toMatch(/dead-man/i);
    expect(ping.cond, 'it reports a failed run too, and only a scheduled one').toBe("always() && github.event_name == 'schedule'");
    expect(ping.env.HC_URL).toBe('${{ secrets.HC_IMAGESCAN_PING_URL }}');
    expect(ping.env.JOB_STATUS).toBe('${{ job.status }}');
    expect(ping.run).toContain('"$HC_URL/fail"');
    expect(ping.run).toMatch(/curl -fsS -m 10 --retry 3 -o \/dev\/null "\$url"/);
  });

  it('pins Trivy by digest, from a release, and uses neither of its actions', () => {
    const { w } = load();
    expect(w.env.TRIVY_IMAGE).toMatch(/^ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    // trivy-action and setup-trivy had every version tag rewritten on 2026-03-19
    // (GHSA-69fq-xp46-6x23); a digest is the one reference that cannot be moved.
    expect(usesIn(IMAGE_SCAN).filter((u) => /trivy/i.test(u))).toEqual([]);
  });

  it('reads the postgres and nginx digests from the compose file at run time (D-13)', () => {
    const { w, scan, text } = load();
    const digests = text.match(/sha256:[0-9a-f]{64}/g) ?? [];
    expect(digests, 'Trivy is the only digest the workflow may carry').toEqual([w.env.TRIVY_IMAGE.split('@')[1]]);
    expect(text.split('\n').filter((l) => /(postgres|nginx)/i.test(l) && /@sha256:/.test(l))).toEqual([]);

    const compose = read(COMPOSE);
    const pinned = [...compose.matchAll(/^\s*image:\s*(\S+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
    expect(pinned.length, 'the compose file should still pin postgres and nginx').toBeGreaterThanOrEqual(2);
    for (const ref of pinned) expect(text).not.toContain(ref.split('@')[1]);

    const collect = stepRunning(scan, /docker-compose\.prod\.yml/, 'reads the compose file');
    expect(collect.run).toContain('docker/docker-compose.prod.yml');
  });

  it('keeps the registry token out of every image but the ghcr.io ones', () => {
    const { w, scan } = load();
    expect(Object.keys(w.env).filter((k) => /^TRIVY_(USERNAME|PASSWORD)$/.test(k))).toEqual([]);
    const step = stepRunning(scan, /docker run/, 'runs Trivy');
    expect(step.env.TRIVY_PASSWORD).toBe('${{ github.token }}');
    expect(step.run.match(/-e TRIVY_PASSWORD/g)).toHaveLength(1);
    expect(step.run).toMatch(/case "\$ref" in\s+ghcr\.io\/\*\)[^;]*-e TRIVY_PASSWORD[^;]*;;/);
  });

  it('checks out without keeping the token, and validates the scanners input', () => {
    const { w, scan } = load();
    const checkout = scan.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.withs['persist-credentials']).toBe('false');

    const check = stepRunning(scan, /Trivy scanners|SCANNERS/, 'checks the scanners input');
    const dir = tempDir('scanners');
    const with_ = (v: string) => runScript(check.run, dir, { SCANNERS: v });
    for (const ok of ['vuln', 'vuln,secret', 'vuln,secret,misconfig,license']) expect(with_(ok).status, ok).toBe(0);
    for (const bad of ['', 'vuln;id', '$(id)', 'vuln,', 'all', 'vuln secret', '--exit-code=0', 'vuln\nsecret']) {
      expect(with_(bad).status, JSON.stringify(bad)).not.toBe(0);
    }
    expect(w.env.SCANNERS).toBe("${{ inputs.scanners || 'vuln' }}");
  });

  describe('the scan loop', () => {
    const web = `ghcr.io/example-owner/makrai-web@${SHA256('a')}`;
    const migrator = `ghcr.io/example-owner/makrai-migrator@${SHA256('b')}`;
    const postgres = `postgres:16-alpine@${SHA256('c')}`;
    const nginx = `nginx:1.31-alpine@${SHA256('d')}`;

    /** Runs the scan step with a stand-in `docker` that records each call and fails for `failing`. */
    function scanWith(failing: string[]): { status: number | null; calls: string[] } {
      const { scan } = load();
      const step = stepRunning(scan, /docker run/, 'runs Trivy');
      const dir = tempDir('loop');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'docker'),
        '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\nfor f in $FAKE_DOCKER_FAIL; do [[ "$*" == *"$f" ]] && exit 1; done\nexit 0\n',
      );
      chmodSync(join(bin, 'docker'), 0o755);
      const temp = join(dir, 'runner-temp');
      mkdirSync(temp);
      writeFileSync(join(temp, 'images.txt'), [web, migrator, postgres, nginx].join('\n') + '\n');
      const log = join(dir, 'docker.log');
      const r = runScript(
        step.run,
        dir,
        {
          RUNNER_TEMP: temp,
          TRIVY_IMAGE: load().w.env.TRIVY_IMAGE,
          SCANNERS: 'vuln',
          TRIVY_USERNAME: 'someone',
          TRIVY_PASSWORD: 'unused',
          FAKE_DOCKER_LOG: log,
          FAKE_DOCKER_FAIL: failing.join(' '),
        },
        bin,
      );
      return { status: r.status, calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
    }

    it('passes when every image is clean, and scans all four', () => {
      const r = scanWith([]);
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.split(' ').pop())).toEqual([web, migrator, postgres, nginx]);
    });

    it('fails the run if any one image fails, whichever it is, after scanning the rest', () => {
      for (const bad of [web, migrator, postgres, nginx]) {
        const r = scanWith([bad]);
        expect(r.status, `${bad} failing must fail the step`).not.toBe(0);
        expect(r.calls, 'the other images are still scanned').toHaveLength(4);
      }
    });

    it('hands the registry token to the ghcr.io images and to no other', () => {
      const r = scanWith([]);
      for (const call of r.calls) {
        const ref = call.split(' ').pop()!;
        expect(call.includes('-e TRIVY_PASSWORD'), ref).toBe(ref.startsWith('ghcr.io/'));
      }
      expect(r.calls.every((c) => /--exit-code 1\b/.test(c) && c.includes('--ignore-unfixed'))).toBe(true);
    });
  });

  describe('the list of images to scan', () => {
    const collectStep = () => stepRunning(load().scan, /docker-compose\.prod\.yml/, 'collects the images');
    const web = `ghcr.io/example-owner/makrai-web@${SHA256('a')}`;
    const migrator = `ghcr.io/example-owner/makrai-migrator@${SHA256('b')}`;
    const good = `web: ${web}\nmigrator: ${migrator}\n`;

    /** Runs the step in a scratch checkout holding the real compose file, with a stand-in `gh`. */
    function collectWith(body: string | undefined): { status: number | null; out: string; images: string[] } {
      const dir = tempDir('collect');
      mkdirSync(join(dir, 'docker'));
      writeFileSync(join(dir, COMPOSE), read(COMPOSE));
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\n[ -f "$FAKE_RELEASE_BODY" ] || { echo "release not found" >&2; exit 1; }\ncat "$FAKE_RELEASE_BODY"\n',
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const bodyFile = join(dir, 'body.md');
      if (body !== undefined) writeFileSync(bodyFile, body);
      const temp = join(dir, 'runner-temp');
      mkdirSync(temp);
      const r = runScript(
        collectStep().run,
        dir,
        {
          GH_TOKEN: 'unused',
          GITHUB_REPOSITORY: 'Example-Owner/example-repo',
          OWNER: 'Example-Owner',
          RUNNER_TEMP: temp,
          FAKE_RELEASE_BODY: bodyFile,
        },
        bin,
      );
      const list = join(temp, 'images.txt');
      return { ...r, images: existsSync(list) ? readFileSync(list, 'utf8').split('\n').filter(Boolean) : [] };
    }

    it('is the latest release\'s two digests plus every digest the compose file pins', () => {
      const r = collectWith(good);
      expect(r.status, r.out).toBe(0);
      const pinned = [...read(COMPOSE).matchAll(/^\s*image:\s*(\S+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
      expect(r.images).toEqual([web, migrator, ...pinned]);
      expect(r.images.some((i) => i.startsWith('postgres:'))).toBe(true);
      expect(r.images.some((i) => i.startsWith('nginx:'))).toBe(true);
    });

    it('stops when there is no release, or the body is not what release.yml writes', () => {
      const cases: Record<string, string | undefined> = {
        'no release': undefined,
        'empty body': '',
        'no migrator line': `web: ${web}\n`,
        'no web line': `migrator: ${migrator}\n`,
        'two web lines': `${good}web: ${web}\n`,
        'another owner': good.replace('example-owner', 'someone-else'),
        'another registry': good.replace('ghcr.io/', 'registry.example.invalid/'),
        'a tag, not a digest': `web: ghcr.io/example-owner/makrai-web:v0.2.0\nmigrator: ${migrator}\n`,
        'a short digest': good.replace(SHA256('a'), `sha256:${'a'.repeat(63)}`),
        'a long digest': good.replace(SHA256('a'), `sha256:${'a'.repeat(65)}`),
        'text after the digest': good.replace(`${SHA256('a')}\n`, `${SHA256('a')} (old)\n`),
        'a name that is not ours': good.replace('makrai-web', 'other-web'),
      };
      for (const [what, body] of Object.entries(cases)) {
        const r = collectWith(body);
        expect(r.status, `${what} must stop the scan: ${r.out}`).not.toBe(0);
      }
    });

    it('reads a release body with Windows line endings', () => {
      const r = collectWith(good.replace(/\n/g, '\r\n'));
      expect(r.status, r.out).toBe(0);
      expect(r.images.slice(0, 2)).toEqual([web, migrator]);
    });
  });
});
