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
const CI = `${WORKFLOWS_DIR}/ci.yml`;
const RELEASE = `${WORKFLOWS_DIR}/release.yml`;
const IMAGE_SCAN = `${WORKFLOWS_DIR}/image-scan.yml`;
const COMPOSE = 'docker/docker-compose.prod.yml';
const DOCKERFILE = 'docker/Dockerfile';
const DEPLOYMENT = 'docs/runbooks/deployment.md';
const BACKUP_RESTORE = 'docs/runbooks/backup-restore.md';
const TROUBLESHOOTING = 'docs/runbooks/troubleshooting.md';

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

/**
 * A job or service header at two spaces: any YAML-valid id (upper case, a leading
 * underscore) and a trailing comment. A header this misses would fold that job's
 * lines into the previous job, which is how a write grant could hide.
 */
const JOB_HEADER = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/;

/**
 * A `permissions:` declaration as written: a block this test can read key by
 * key, or an inline value (`write-all`, `{ contents: write }`) that it cannot.
 * An inline value is a problem in itself (see `permissionAudit`), so that a form
 * the parser cannot read is never mistaken for "no write permission".
 */
type PermDecl = { form: 'block'; perms: Perms } | { form: 'inline'; raw: string };

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
  /** The job's own `permissions:`, or undefined when it has none. */
  permissions: PermDecl | undefined;
  steps: Step[];
}

interface Workflow {
  file: string;
  lines: string[];
  /** The top-level `permissions:`, or undefined when the workflow has none. */
  permissions: PermDecl | undefined;
  env: Record<string, string>;
  jobs: Job[];
}

/** The `permissions:` declared at `indent` spaces in `lines`, or undefined. */
function permissionsDecl(lines: string[], indent: number): PermDecl | undefined {
  const key = new RegExp(`^ {${indent}}permissions:`);
  const at = lines.findIndex((l) => key.test(l));
  if (at === -1) return undefined;
  const raw = lines[at].replace(key, '').replace(/\s+#.*$/, '').trim();
  if (raw !== '') return { form: 'inline', raw };
  // The entries sit at whatever depth the author chose, not only at indent + 2.
  const body = nestedUnder(lines, at);
  const first = body.find((l) => l.trim() !== '');
  return { form: 'block', perms: mapAt(body, first ? first.match(/^ */)![0].length : indent + 2) };
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
  const permissions = permissionsDecl(body, 4);
  const stepsAt = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  const chunks: string[][] = [];
  for (const l of stepsAt === -1 ? [] : nestedUnder(body, stepsAt)) {
    if (/^ {6}- /.test(l)) chunks.push([l]);
    else if (chunks.length > 0) chunks[chunks.length - 1].push(l);
  }
  return { id, needs, permissions, steps: chunks.map(parseStep) };
}

function parseWorkflow(file: string): Workflow {
  return parseWorkflowText(file, read(file));
}

function parseWorkflowText(file: string, source: string): Workflow {
  const lines = withoutComments(source);
  const jobsBody = topLevel(lines, 'jobs');
  expect(jobsBody, `${file} should have a jobs: block`).toBeDefined();
  const jobs: Job[] = [];
  let current: { id: string; body: string[] } | undefined;
  const raw: { id: string; body: string[] }[] = [];
  for (const l of jobsBody!) {
    const header = JOB_HEADER.exec(l);
    if (header) {
      current = { id: header[1], body: [] };
      raw.push(current);
    } else if (current) {
      current.body.push(l);
    }
  }
  for (const r of raw) jobs.push(parseJob(r.id, r.body));
  expect(jobs.length, `parsed no jobs from ${file} -- the parser, not the workflow, is wrong`).toBeGreaterThan(0);
  return {
    file,
    lines,
    permissions: permissionsDecl(lines, 0),
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

/** The permissions of a declaration that must be a block; the test fails on anything else. */
function blockOf(decl: PermDecl | undefined): Perms | undefined {
  if (decl === undefined) return undefined;
  expect(decl.form, `permissions must be written as a block, not inline (${decl.form === 'inline' ? decl.raw : ''})`).toBe('block');
  return decl.form === 'block' ? decl.perms : undefined;
}

/**
 * What a workflow declares that P1 forbids. `writers` are the places that can write:
 * any block entry that starts with `write`, and any inline value that mentions it
 * (`write-all`, `{ contents: write }`). `problems` are the declarations this test
 * cannot read, and a workflow with no top-level `permissions:` at all: it would
 * inherit the repository's default, which may be read-write.
 */
function permissionAudit(w: Workflow): { writers: string[]; problems: string[] } {
  const writers: string[] = [];
  const problems: string[] = [];
  const check = (where: string, decl: PermDecl | undefined) => {
    if (decl === undefined) return;
    if (decl.form === 'inline') {
      problems.push(`${where}: permissions written inline (${decl.raw}); write them as a block`);
      if (/write/.test(decl.raw)) writers.push(where);
    } else if (Object.keys(decl.perms).length === 0) {
      problems.push(`${where}: a permissions: block with no entries`);
    } else if (Object.values(decl.perms).some((v) => v.startsWith('write'))) {
      writers.push(where);
    }
  };
  if (w.permissions === undefined) problems.push(`${w.file}: no top-level permissions: block`);
  check(`${w.file} (workflow level)`, w.permissions);
  for (const j of w.jobs) check(`${w.file}#${j.id}`, j.permissions);

  // Count, so that a declaration the parser attributed to no job (a header it could not read, a
  // second `permissions:` in one job, a key at an unexpected depth) is a failure and not a blind spot.
  const declared = w.lines.filter((l) => /^\s*permissions:/.test(l)).length;
  const parsed = (w.permissions === undefined ? 0 : 1) + w.jobs.filter((j) => j.permissions !== undefined).length;
  if (declared !== parsed) {
    problems.push(`${w.file}: ${declared} permissions: lines in the file, ${parsed} read; one belongs to no job this test can see`);
  }
  return { writers, problems };
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

    const patterns = [...push.join('\n').matchAll(/^ {6}- (.+?)\s*$/gm)].map((m) =>
      m[1].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'),
    );
    // Exactly this one pattern: a second one (`v*`, `**`) would start the workflow for tags it
    // was not meant to see, and the gate below would be the only thing refusing them.
    expect(patterns, 'the tag filter is exactly one plain-version pattern').toEqual(['v[0-9]+.[0-9]+.[0-9]+']);

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
    expect(blockOf(w.permissions), 'the workflow default is read-only').toEqual({ contents: 'read' });
    expect(blockOf(jobOf(w, 'gate').permissions), 'the gate states its own read-only permissions').toEqual({
      contents: 'read',
    });
    expect(blockOf(jobOf(w, 'release').permissions), 'the release job writes what it publishes, and nothing else').toEqual({
      contents: 'write',
      packages: 'write',
    });

    // And across every workflow in the repository, this is the one job that can write,
    // and every workflow says what it grants in a form this test can read.
    const writers: string[] = [];
    const problems: string[] = [];
    for (const file of workflowFiles()) {
      const audit = permissionAudit(parseWorkflow(file));
      writers.push(...audit.writers);
      problems.push(...audit.problems);
    }
    expect(problems).toEqual([]);
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
        'if [ "$1" = "api" ]; then printf \'%s\\n\' "$FAKE_TAG_SHA"; fi',
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
      GITHUB_SHA: 'f'.repeat(40),
      RUNNER_TEMP: temp,
      WEB_REF: web,
      MIGRATOR_REF: migrator,
      FAKE_LOG: log,
      FAKE_STORE: store,
      FAKE_TAG_SHA: 'f'.repeat(40),
    };
    const r = runScript(step.run, dir, env, bin);
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(store, 'utf8')).toBe(`web: ${web}\nmigrator: ${migrator}\n`);
    const create = readFileSync(log, 'utf8').split('\n').find((c) => c.startsWith('release create'))!;
    expect(create).toContain('release create v0.2.0');
    expect(create).toContain('--verify-tag');

    expect(readFileSync(log, 'utf8')).toContain('api repos/example-owner/example-repo/commits/v0.2.0 --jq .sha');

    const bad = runScript(step.run, dir, { ...env, MIGRATOR_REF: 'ghcr.io/example-owner/makrai-migrator:v0.2.0' }, bin);
    expect(bad.status, 'a body that does not carry two digests is not a release').not.toBe(0);
  });

  it('refuses to publish when the tag no longer points at the commit that was built', () => {
    const step = stepRunning(release(), /gh release create/, 'creates the release');
    const { dir, bin, log } = standIns();
    const temp = join(dir, 'runner-temp');
    mkdirSync(temp);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/bash',
        'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
        'if [ "$1" = "api" ]; then printf \'%s\\n\' "$FAKE_TAG_SHA"; fi',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const env = {
      GH_TOKEN: 'unused',
      GITHUB_REF_NAME: 'v0.2.0',
      GITHUB_REPOSITORY: 'example-owner/example-repo',
      GITHUB_SHA: 'f'.repeat(40),
      RUNNER_TEMP: temp,
      WEB_REF: web,
      MIGRATOR_REF: migrator,
      FAKE_LOG: log,
    };
    for (const moved of ['e'.repeat(40), '', 'f'.repeat(39)]) {
      const r = runScript(step.run, dir, { ...env, FAKE_TAG_SHA: moved }, bin);
      expect(r.status, `a tag at ${JSON.stringify(moved)} must stop the release: ${r.out}`).not.toBe(0);
    }
    expect(readFileSync(log, 'utf8'), 'nothing was published').not.toContain('release create');
    // The check sits before the publish in the script, not after it.
    expect(step.run.indexOf('commits/$GITHUB_REF_NAME')).toBeGreaterThan(-1);
    expect(step.run.indexOf('commits/$GITHUB_REF_NAME')).toBeLessThan(step.run.indexOf('gh release create'));
  });
});

describe('every action is pinned by SHA (P2)', () => {
  // A full commit SHA, then the version it stands for, so a reader and Dependabot can see it.
  const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\S*$/;
  const unpinned = (file: string) => usesIn(file).filter((u) => !PINNED.test(u) && !/^\.\//.test(u));

  it('covers ci.yml, release.yml and image-scan.yml, and any workflow added later', () => {
    const files = workflowFiles();
    expect(files, 'discovery should reach all three workflows').toEqual(expect.arrayContaining([CI, RELEASE, IMAGE_SCAN]));
    for (const file of files) {
      expect(usesIn(file).length, `${file}: no uses: line found`).toBeGreaterThan(0);
      expect(unpinned(file), `${file}: actions not pinned by 40-hex SHA with a # vX.Y.Z comment`).toEqual([]);
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

describe('the permissions audit (P1) fails closed', () => {
  /** A one-job workflow with the given top-level and job-level `permissions:` lines. */
  const fixture = (top: string[], job: string[]) =>
    parseWorkflowText(
      'fixture.yml',
      ['name: x', 'on: push', ...top, 'jobs:', '  a:', '    runs-on: ubuntu-latest', ...job, '    steps:', '      - run: echo', ''].join('\n'),
    );
  const READ = ['permissions:', '  contents: read'];

  it('passes a workflow that only reads', () => {
    expect(permissionAudit(fixture(READ, []))).toEqual({ writers: [], problems: [] });
    expect(permissionAudit(fixture(READ, ['    permissions:', '      contents: read', '      packages: read']))).toEqual({
      writers: [],
      problems: [],
    });
  });

  it.each([
    ['write-all at workflow level', ['permissions: write-all'], [], 'fixture.yml (workflow level)'],
    ['a flow map with write at workflow level', ['permissions: { contents: write }'], [], 'fixture.yml (workflow level)'],
    ['write-all on a job', READ, ['    permissions: write-all'], 'fixture.yml#a'],
    ['a flow map with write on a job', READ, ['    permissions: { contents: write, packages: write }'], 'fixture.yml#a'],
    ['a block entry on a job', READ, ['    permissions:', '      contents: write'], 'fixture.yml#a'],
    ['a block entry at workflow level', ['permissions:', '  packages: write'], [], 'fixture.yml (workflow level)'],
  ])('flags %s as a writer', (_what, top, job, where) => {
    expect(permissionAudit(fixture(top, job)).writers).toEqual([where]);
  });

  /** A workflow from raw text, for shapes the one-job `fixture` cannot express. */
  const audit = (text: string) => permissionAudit(parseWorkflowText('fixture.yml', text));
  const jobs = (...jobLines: string[]) =>
    ['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo', ...jobLines, ''].join('\n');
  const second = (header: string, ...body: string[]) => [header, '    runs-on: ubuntu-latest', ...body, '    steps:', '      - run: echo'];

  it.each([
    ['an upper-case job id', second('  Publish:', '    permissions: write-all'), 'fixture.yml#Publish'],
    ['a job header with a trailing comment', second('  publish: # pushes things', '    permissions: write-all'), 'fixture.yml#publish'],
    ['a job id with a leading underscore', second('  _tidy:', '    permissions:', '      contents: write'), 'fixture.yml#_tidy'],
  ])('sees a second job with %s', (_what, job, where) => {
    expect(audit(jobs(...job)).writers).toEqual([where]);
  });

  it('reads a block written at another depth', () => {
    const top4 = ['name: x', 'on: push', 'permissions:', '    contents: write', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo', ''];
    expect(audit(top4.join('\n')).writers).toEqual(['fixture.yml (workflow level)']);
    const job8 = jobs().replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n        contents: read\n        packages: write\n');
    expect(audit(job8).writers).toEqual(['fixture.yml#a']);
  });

  it('fails on a block with no entries', () => {
    const empty = jobs().replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n');
    expect(audit(empty).problems.join('\n')).toMatch(/no entries/);
  });

  it('fails on a declaration it cannot attribute to a job, by counting', () => {
    // A quoted job id is a header JOB_HEADER does not read; its permissions: line is then counted but unattributed.
    const quoted = jobs(...second('  "x":', '    permissions: write-all')).replace(
      '    runs-on: ubuntu-latest\n    steps:',
      '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:',
    );
    expect(audit(quoted).problems.join('\n')).toMatch(/3 permissions: lines in the file, 2 read/);
    // Two permissions: keys in one job.
    const twice = jobs().replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    permissions: write-all\n');
    expect(audit(twice).problems.join('\n')).toMatch(/permissions: lines in the file/);
  });

  it('flags inline permissions as unreadable even when they grant no write', () => {
    expect(permissionAudit(fixture(['permissions: read-all'], [])).problems).toHaveLength(1);
    expect(permissionAudit(fixture(READ, ['    permissions: {}'])).problems).toHaveLength(1);
  });

  it('flags a workflow with no top-level permissions', () => {
    const { problems } = permissionAudit(fixture([], []));
    expect(problems).toEqual(['fixture.yml: no top-level permissions: block']);
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
    const header = JOB_HEADER.exec(l);
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
    // The whole schedule is one cron entry, in this form. A second entry, in any form (a flow map,
    // extra spaces), would run the scan and its ping at other times; a flow-sequence `schedule:` has no body here.
    const scheduleAt = on.findIndex((l) => /^ {2}schedule:\s*$/.test(l));
    expect(scheduleAt, 'schedule: is a block with a body').toBeGreaterThan(-1);
    expect(nestedUnder(on, scheduleAt).filter((l) => l.trim() !== '')).toEqual(["    - cron: '47 4 * * *'"]);
    const inputs = nestedUnder(on, on.findIndex((l) => /^ {4}inputs:/.test(l)));
    expect(Object.keys(mapAt(inputs, 6)), 'one input').toEqual(['scanners']);
    expect(mapAt(nestedUnder(inputs, inputs.findIndex((l) => /^ {6}scanners:/.test(l))), 8).default).toBe('vuln');
  });

  it('only reads: the scan job adds packages: read and nothing more (P1)', () => {
    const { w, scan } = load();
    expect(blockOf(w.permissions)).toEqual({ contents: 'read' });
    expect(blockOf(scan.permissions)).toEqual({ contents: 'read', packages: 'read' });
  });

  it('image scan fails on fixable criticals and pings its check', () => {
    const { scan, text } = load();
    const step = stepRunning(scan, /docker run/, 'runs Trivy');
    expect(step.run).toContain('"$TRIVY_IMAGE"');
    // The brief's flags, in its order and with nothing between them (`CRITICAL,HIGH` fails this).
    expect(step.run).toContain('--severity CRITICAL --ignore-unfixed --exit-code 1');
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

    // And the ping's own script, run with a stand-in curl that logs what it was asked to fetch.
    const dir = tempDir('ping');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$FAKE_LOG"\n');
    chmodSync(join(bin, 'curl'), 0o755);
    const pingFor = (jobStatus: string) => {
      const log = join(dir, `curl-${jobStatus || 'empty'}.log`);
      const r = runScript(ping.run, dir, { HC_URL: 'https://hc.example.invalid/check', JOB_STATUS: jobStatus, FAKE_LOG: log }, bin);
      return { status: r.status, calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
    };
    const flags = '-fsS -m 10 --retry 3 -o /dev/null';
    expect(pingFor('success')).toEqual({ status: 0, calls: [`${flags} https://hc.example.invalid/check`] });
    for (const bad of ['failure', 'cancelled', 'skipped', '']) {
      expect(pingFor(bad), `a ${JSON.stringify(bad)} run reports /fail, and only once`).toEqual({
        status: 0,
        calls: [`${flags} https://hc.example.invalid/check/fail`],
      });
    }
  });

  it('pins Trivy by digest, from a release, and uses neither of its actions', () => {
    const { w } = load();
    expect(w.env.TRIVY_IMAGE).toMatch(/^ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    // trivy-action and setup-trivy had every version tag rewritten on 2026-03-19
    // (GHSA-69fq-xp46-6x23); a digest is the one reference that cannot be moved.
    expect(usesIn(IMAGE_SCAN).filter((u) => /trivy/i.test(u))).toEqual([]);
  });

  it('reads the postgres and nginx digests from the compose file at run time (D-13)', () => {
    const { w, scan } = load();
    // Absence is checked on the raw file, comments included: a digest pasted into a comment is a
    // second copy that goes stale, which is the thing D-13 forbids. (Presence checks, elsewhere,
    // read the file without its comments.)
    const raw = read(IMAGE_SCAN);
    const digests = raw.match(/sha256:[0-9a-f]{64}/g) ?? [];
    expect(digests, 'Trivy is the only digest the workflow may carry').toEqual([w.env.TRIVY_IMAGE.split('@')[1]]);
    expect(raw.split('\n').filter((l) => /(postgres|nginx)/i.test(l) && /@sha256:/.test(l))).toEqual([]);

    const compose = read(COMPOSE);
    const pinned = [...compose.matchAll(/^\s*image:\s*(\S+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
    expect(pinned.length, 'the compose file should still pin postgres and nginx').toBeGreaterThanOrEqual(2);
    for (const ref of pinned) expect(raw).not.toContain(ref.split('@')[1]);

    const collect = stepRunning(scan, /docker-compose\.prod\.yml/, 'reads the compose file');
    expect(collect.run).toContain('docker/docker-compose.prod.yml');
  });

  it('offers the registry login to ghcr.io images only, as a Docker config file', () => {
    const { scan, text } = load();
    // Trivy's own credential settings reach every registry it contacts, the vulnerability
    // database's mirror (mirror.gcr.io) included. They are not used anywhere.
    expect(text).not.toMatch(/TRIVY_(USERNAME|PASSWORD|REGISTRY_TOKEN)/);

    const login = stepRunning(scan, /docker login ghcr\.io/, 'logs in to ghcr.io');
    expect(login.run).toContain('--password-stdin');
    expect(login.env.REGISTRY_TOKEN).toBe('${{ github.token }}');
    expect(login.run, 'the token never travels in argv').not.toMatch(/-p\b|--password(?!-stdin)/);
    const logout = stepRunning(scan, /docker logout ghcr\.io/, 'logs out of ghcr.io');
    expect(logout.cond).toBe('always()');

    const step = stepRunning(scan, /docker run/, 'runs Trivy');
    expect(step.env, 'the scan step holds no credential of its own').toEqual({});
    expect(step.run).not.toMatch(/--username|--password|(^|\s)(-e|--env)\s/m);
    // The only hand-over is the mounted config file, and only in the ghcr.io branch.
    expect(step.run.match(/config\.json/g)).toHaveLength(2);
    expect(step.run).toMatch(
      /case "\$ref" in\s+ghcr\.io\/\*\)[^;]*\$HOME\/\.docker\/config\.json:\/root\/\.docker\/config\.json:ro[^;]*;;/,
    );

    const order = scan.steps.map((s) => s.name);
    expect(order.indexOf(login.name), 'login before the scan').toBeLessThan(order.indexOf(step.name));
    expect(order.indexOf(step.name), 'logout after the scan').toBeLessThan(order.indexOf(logout.name));
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
    function scanWith(failing: string[]): { status: number | null; calls: string[]; home: string } {
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
          FAKE_DOCKER_LOG: log,
          FAKE_DOCKER_FAIL: failing.join(' '),
        },
        bin,
      );
      return {
        status: r.status,
        calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
        home: dir,
      };
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

    it('mounts the Docker config for the ghcr.io images and for no other', () => {
      const r = scanWith([]);
      const mount = `${r.home}/.docker/config.json:/root/.docker/config.json:ro`;
      for (const call of r.calls) {
        const ref = call.split(' ').pop()!;
        expect(call.includes(mount), ref).toBe(ref.startsWith('ghcr.io/'));
        expect(call, 'no credential flag or variable in any call').not.toMatch(/--username|--password|(^|\s)-e\s|TRIVY_/);
      }
      expect(r.calls.filter((c) => c.includes('config.json'))).toHaveLength(2);
      for (const call of r.calls) {
        expect(call, 'the exact flags, on every image').toContain('--severity CRITICAL --ignore-unfixed --exit-code 1 ');
      }
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

describe('the deployment runbook, sections 8 and 9', () => {
  const md = () => read(DEPLOYMENT);

  /** From the heading line that starts with `heading` to the next heading. */
  function section(heading: string): string {
    const lines = md().split('\n');
    const at = lines.findIndex((l) => l.startsWith(heading));
    expect(at, `${DEPLOYMENT} should have a heading starting ${JSON.stringify(heading)}`).toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => /^#{2,3} /.test(l));
    return [lines[at], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
  }

  it('moves the checkout to the release tag as <operator>, by fetch and detached checkout, never a pull (8.3, 9.2)', () => {
    const s83 = section('### 8.3');
    expect(s83).toContain('sudo -u <operator> git -C /srv/makrai/app fetch --tags origin');
    expect(s83).toContain('sudo -u <operator> git -C /srv/makrai/app checkout --detach vX.Y.Z');
    expect(section('### 9.2')).toContain('sudo -u <operator> git -C /srv/makrai/app checkout --detach vA.B.C');
    for (const heading of ['### 8.2', '### 8.3', '### 9.2']) {
      const gitLines = section(heading).split('\n').filter((l) => /\bgit -C\b/.test(l));
      expect(gitLines.length, heading).toBeGreaterThan(0);
      expect(gitLines.filter((l) => !l.includes('sudo -u <operator> git -C')), `${heading}: git runs as <operator>, from root's session`).toEqual([]);
      expect(gitLines.filter((l) => /\bpull\b/.test(l)), `${heading}: no pull`).toEqual([]);
    }
  });

  it('watches the run for this tag, and waits until it exists (8.1)', () => {
    const s81 = section('### 8.1');
    expect(s81).toContain('--workflow release.yml --branch vX.Y.Z --limit 1');
    expect(s81).toContain("--jq '.[0].databaseId // empty'");
    expect(s81).toContain('until [ -n "$ID" ]');
    expect(s81).toContain('gh run watch "$ID"');
    expect(s81, 'a bare --limit 1 would watch the previous release').not.toMatch(/--workflow release\.yml --limit 1/);
  });

  it('writes down the pre-migration backup (8.2), and 9.3 restores that one and says what is lost', () => {
    expect(section('### 8.2')).toContain('ls -t /srv/makrai/backups/makrai-*.sql.gz.gpg | head -n 1');
    expect(section('### 8.2')).toMatch(/Write it down as BACKUP/);
    const s93 = section('### 9.3');
    expect(s93).toMatch(/Restore \*\*BACKUP\*\*, the file 8\.2 wrote down/);
    expect(s93).toMatch(/Not simply the newest/);
    expect(s93).toMatch(/every write since that copy was\s+taken is lost for good/);
    expect(s93).toContain('/usr/local/bin/makrai-backup.sh');
    expect(s93, 'points to the restore procedure').toContain('backup-restore.md');
  });

  it('gives the migrator a rollback image, and sets it before the restore procedure runs it (8.3, 9.3)', () => {
    const s83 = section('### 8.3');
    expect(s83).toContain('docker image tag "$(docker inspect -f \'{{.Image}}\' docker-nextjs-1)" makrai-nextjs:rollback');
    expect(s83).toContain('docker image tag docker-migrator makrai-migrator:rollback');
    const s93 = section('### 9.3');
    expect(s93).toContain('makrai-migrator:rollback');
    expect(s93.indexOf('**Before** backup-restore.md section 4.4')).toBeGreaterThan(-1);
    expect(s93.indexOf('set_env MIGRATOR_IMAGE')).toBeGreaterThan(s93.indexOf('**Before** backup-restore.md section 4.4'));
    expect(s93.indexOf('Follow backup-restore.md section 4 in order')).toBeGreaterThan(s93.indexOf('set_env MIGRATOR_IMAGE'));
    // and the restore procedure runs the migrator from the right directory, without its dependencies
    expect(read(BACKUP_RESTORE)).toContain('--profile tools run --rm --no-deps migrator');
  });

  it('waits for the app to be healthy before it says the deploy or rollback worked (8.3 step 5, 9.2)', () => {
    for (const heading of ['### 8.3', '### 9.2']) {
      const s = section(heading);
      expect(s, heading).toContain('$C up -d --no-deps --wait --wait-timeout 120 nextjs');
      expect(s, `${heading}: no unconditional up of nextjs without --wait`).not.toMatch(/^\$C up -d --no-deps nextjs$/m);
    }
  });

  it('puts the other services back on a rollback, and says how to tell (9.2)', () => {
    const s92 = section('### 9.2');
    expect(s92).toContain('git -C /srv/makrai/app diff --stat vA.B.C vX.Y.Z -- docker/');
    // --stat names files; the compose diff shows which service block changed.
    expect(s92).toContain('git -C /srv/makrai/app diff vA.B.C vX.Y.Z -- docker/docker-compose.prod.yml');
    expect(s92).toContain('$C up -d --no-deps <service>');
    expect(s92.indexOf('diff --stat')).toBeLessThan(s92.indexOf('docker-compose.prod.yml\n'));
    expect(s92.indexOf('docker/docker-compose.prod.yml\n')).toBeLessThan(s92.indexOf('$C up -d --no-deps <service>'));
  });

  it('tells the first-release rollback to run the one nextjs line, because the checkout has not moved (9.2)', () => {
    const text = section('### 9.2').replace(/\s+/g, ' ');
    expect(text).toContain(
      'run only the `$C up -d --no-deps --wait --wait-timeout 120 nextjs` line; the rest of the block does not apply, because the checkout has not moved.',
    );
  });

  describe('nginx is tested before it is restarted (8.3 step 7, 9.2)', () => {
    // The mounts are read from the compose file, so the throwaway container cannot drift from the real one.
    const lines = withoutComments(read(COMPOSE));
    const servicesBody = topLevel(lines, 'services')!;
    const at = servicesBody.findIndex((l) => /^ {2}nginx:\s*$/.test(l));
    const nginxBody = nestedUnder(servicesBody, at);
    const volumes = nestedUnder(nginxBody, nginxBody.findIndex((l) => /^ {4}volumes:/.test(l)))
      .map((l) => /^\s*-\s*(\S+)\s*$/.exec(l)?.[1])
      .filter((v): v is string => v !== undefined);
    const project = dirnameOf(COMPOSE);

    function dirnameOf(path: string): string {
      return path.split('/').slice(-2, -1)[0];
    }

    it('reads the two bind mounts nginx has from the compose file', () => {
      expect(volumes).toEqual(['./nginx/default.conf:/etc/nginx/conf.d/default.conf', '/etc/ssl/makrai:/etc/ssl/makrai:ro']);
    });

    it.each(['### 8.3', '### 9.2'])('%s: nginx is recreated or restarted only after the new image and file pass nginx -t', (heading) => {
      const s = section(heading);
      const [conf, certs] = volumes;
      const [confSource, confTarget] = conf.split(':');
      const hostConf = `/srv/makrai/app/${project}/${confSource.replace(/^\.\//, '')}`;
      const test = [
        'docker run --rm --network ' + project + '_default \\',
        `  -v ${hostConf}:${confTarget}:ro \\`,
        `  -v ${certs} \\`,
        `  "$($C config --images | grep '^nginx:')" nginx -t \\`,
      ].join('\n');
      // Both ways of changing nginx are chained on the test: a new image is recreated (which picks up
      // the new file too), a changed file alone is restarted.
      expect(s).toContain(`${test}\n  && $C up -d --no-deps nginx`);
      expect(s).toContain(`${test}\n  && docker restart docker-nginx-1`);
      // And there is no other way: the recreate and the restart each appear once, and each follows a test.
      expect(s.match(/up -d --no-deps nginx/g), 'the only recreate of nginx is the chained one').toHaveLength(1);
      expect(s.match(/docker restart docker-nginx-1/g), 'the only restart is the chained one').toHaveLength(1);
      expect(s.match(/nginx -t \\/g)).toHaveLength(2);
      // The generic recreate line leaves nginx to those, so a new nginx never starts untested.
      expect(s).toMatch(/other than nginx/);
      expect(s, 'never a reload').not.toMatch(/nginx -s reload/);
    });

    const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    it.skipIf(compose.status !== 0)('the image lookup in that block names the pinned nginx image', () => {
      const r = spawnSync(
        'bash',
        ['-c', `C="docker compose -f docker-compose.prod.yml"; $C config --images | grep '^nginx:'`],
        {
          cwd: join(REPO_ROOT, 'docker'),
          encoding: 'utf8',
          env: envOf({
            PATH: process.env.PATH ?? '',
            HOME: tmpdir(),
            WEB_IMAGE: `ghcr.io/example-owner/makrai-web@${SHA256('a')}`,
            MIGRATOR_IMAGE: `ghcr.io/example-owner/makrai-migrator@${SHA256('b')}`,
          }),
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const pinned = [...read(COMPOSE).matchAll(/^\s*image:\s*(nginx:\S+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
      expect(r.stdout.trim().split('\n')).toEqual(pinned);
    });
  });

  it('compares the running image\'s version label with the checkout\'s tag (8.4), and release.yml sets that label', () => {
    const s84 = section('### 8.4');
    expect(s84).toContain('org.opencontainers.image.version');
    expect(s84).toContain("sudo -u <operator> git -C /srv/makrai/app describe --tags --exact-match | sed 's/^v//'");
    expect(s84).toContain('makrai-nextjs:rollback');
    expect(s84.match(/echo SAME \|\| echo DIFFERENT/g)).toHaveLength(2);
    const build = stepRunning(jobOf(parseWorkflow(RELEASE), 'release'), /docker build/, 'builds the images');
    expect(build.run).toContain('--label "org.opencontainers.image.version=${GITHUB_REF_NAME#v}"');
  });
});

describe('Compose is run the same way in every runbook that runs it (P5)', () => {
  // `docker compose` on the production file needs --env-file (the file requires WEB_IMAGE and
  // MIGRATOR_IMAGE) and must run from docker/, where the live stack's project name comes from.
  const FILES = [BACKUP_RESTORE, TROUBLESHOOTING];
  const FORM = '--env-file ../.env -f docker-compose.prod.yml';

  /** The fenced blocks of a document, with the line number of each block's first line. */
  function fences(file: string): { start: number; lines: string[] }[] {
    const out: { start: number; lines: string[] }[] = [];
    let open: { start: number; lines: string[] } | undefined;
    read(file).split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('```')) {
        if (open) {
          out.push(open);
          open = undefined;
        } else {
          open = { start: i + 2, lines: [] };
        }
      } else if (open) {
        open.lines.push(line);
      }
    });
    return out;
  }

  it.each(FILES)('%s: every Compose command uses the section 8 form', (file) => {
    const text = read(file).split('\n');
    const commands = text.filter((l) => /docker compose\b.*\s-f\s/.test(l));
    expect(commands.length, `${file}: found no Compose command, so the scan is wrong`).toBeGreaterThan(0);
    expect(commands.filter((l) => !l.includes(FORM))).toEqual([]);
    expect(text.filter((l) => /-f docker\/docker-compose\.prod\.yml|--env-file \.env\b/.test(l))).toEqual([]);
    expect(
      text.filter((l) => /docker compose\b.*\brun\b/.test(l) && !l.includes('--no-deps')),
      'a `run` without --no-deps can recreate the postgres it depends on',
    ).toEqual([]);
  });

  it.each(FILES)('%s: every block that runs Compose is in docker/ first', (file) => {
    const blocks = fences(file).filter((b) => b.lines.some((l) => /^\s*docker compose\b/.test(l)));
    expect(blocks.length, `${file}: no fenced Compose command found`).toBeGreaterThan(0);
    const bad = blocks.filter((b) => {
      const first = b.lines.findIndex((l) => /^\s*docker compose\b/.test(l));
      return !b.lines.slice(0, first).some((l) => l.trim() === 'cd /srv/makrai/app/docker');
    });
    expect(bad.map((b) => `${file}:${b.start}`)).toEqual([]);
    // and in a table row or sentence, the same line says where to run it
    const inline = read(file).split('\n').filter((l) => /`[^`]*docker compose\b[^`]*-f /.test(l));
    expect(inline.filter((l) => !l.includes('cd /srv/makrai/app/docker && docker compose'))).toEqual([]);
  });

  it('nothing in either runbook still builds on the host', () => {
    for (const file of FILES) {
      expect(
        read(file).split('\n').filter((l) => /up -d --build|docker compose[^`]* build\b|build --no-cache nextjs/.test(l)),
        file,
      ).toEqual([]);
    }
  });
});

describe('SECURITY.md describes the release process', () => {
  it('names releases, not "no released version"', () => {
    const md = read('SECURITY.md');
    const start = md.indexOf('## Supported versions');
    const section = md.slice(start, md.indexOf('\n## ', start + 1));
    expect(section).toContain('release.yml');
    expect(section).toContain('`vX.Y.Z`');
    expect(section).toContain('latest release');
    expect(section).not.toMatch(/no released version|no git tag exists/i);
  });
});

describe('deployment.md sections 6 and 11 run Compose as section 8 does', () => {
  const md = read(DEPLOYMENT);
  const between = (from: string, to: string) => md.slice(md.indexOf(from), md.indexOf(to));
  const FORM = 'C="docker compose --env-file ../.env -f docker-compose.prod.yml"';
  const six = between('## 6. First Deployment', '## 7. Monitoring Setup');
  const eleven = between('## 11. Quick Reference', '## 12. Operator access');

  it('finds both sections', () => {
    expect(six.length).toBeGreaterThan(500);
    expect(eleven.length).toBeGreaterThan(300);
  });

  it('section 6: every block that runs Compose sets $C from docker/ first, and nothing uses the old form', () => {
    expect(six).not.toMatch(/-f docker\/docker-compose\.prod\.yml|--env-file \.env\b|docker compose [^\n]*\bup\b[^\n]*--build/);
    const blocks = [...six.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /\$C\b/.test(b));
    expect(blocks.length, 'section 6 should have blocks that use $C').toBeGreaterThanOrEqual(6);
    for (const block of blocks) {
      const first = block.split('\n').findIndex((l) => /\$C\b/.test(l));
      const before = block.split('\n').slice(0, first);
      expect(before, block.slice(0, 80)).toContain('cd /srv/makrai/app/docker');
      expect(before, block.slice(0, 80)).toContain(FORM);
    }
  });

  it('every run, and every up that names a service, carries --no-deps; the all-services up does not', () => {
    const commands = [...six.split('\n'), ...eleven.split('\n')].filter((l) => /^(\$C |\| .*`\$C )/.test(l.trim()) || /^\$C /.test(l));
    expect(commands.length, 'the commands were not found').toBeGreaterThan(6);
    for (const l of commands) {
      if (/\brun\b/.test(l) || /\bup -d (--no-deps )?(nextjs|postgres|nginx)\b/.test(l)) {
        expect(l, 'names a service or runs one').toContain('--no-deps');
      }
    }
    expect(commands, 'starting everything has no --no-deps').toContain('$C up -d');
  });

  it('section 11 sets $C once, in the section 8 form, and its rows use it', () => {
    expect(eleven).toContain('`C="docker compose --env-file ../.env -f docker-compose.prod.yml"`');
    expect(eleven).toContain('Run from `/srv/makrai/app/docker`');
    expect(eleven).not.toMatch(/-f docker\/docker-compose\.prod\.yml|--env-file \.env\b/);
    for (const row of ['`$C up -d`', '`$C down`', '`$C logs -f`', '`$C ps`', '`$C --profile tools run --rm --no-deps migrator`']) {
      expect(eleven, row).toContain(row);
    }
  });
});

describe('the runbook notes and workflow comments say what is true', () => {
  it('the two Compose notes do not claim a second stack; they say the relative -f path finds no file', () => {
    for (const file of [BACKUP_RESTORE, TROUBLESHOOTING]) {
      const text = read(file).replace(/>\s*/g, ' ').replace(/\s+/g, ' ');
      expect(text, file).not.toMatch(/second, empty stack/);
      expect(text, file).toContain('the relative `-f` path finds no file');
    }
  });

  it('troubleshooting Fix 3 recreates the app and names the variables the app reads', () => {
    const md = read(TROUBLESHOOTING);
    const fix = md.slice(md.indexOf('**Fix 3: `APP_DATABASE_URL`'), md.indexOf('**Fix 4: Postgres volume corruption'));
    expect(fix.length).toBeGreaterThan(200);
    expect(fix).toContain('APP_DATABASE_URL');
    expect(fix).toContain('IDENTITY_DATABASE_URL');
    expect(fix).toContain('up -d --no-deps nextjs');
    expect(fix, 'a restart keeps the old environment').not.toMatch(/restart nextjs/);
    expect(fix.replace(/`DATABASE_URL`, the owner/g, ''), 'the app is not given DATABASE_URL').not.toMatch(/(^|[^_A-Z])DATABASE_URL=/m);
  });

  it('release.yml says the pushed images remain when a moved tag is refused', () => {
    const raw = read(RELEASE);
    expect(raw).toContain('refused here, before the release is created; the images');
    expect(raw).toContain('pushed above stay in ghcr.io under the tag, and no release names them.');
    expect(raw).not.toContain('before anything is published');
  });

  it('SECURITY.md says the host runs released images by digest', () => {
    expect(read('SECURITY.md')).toContain('the production host runs released images by digest');
  });
});
