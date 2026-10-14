import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dependency surveillance, and a test secret that is not a literal (RL 7.10,
 * GAP1C-09).
 *
 * Three separate ways for a vulnerable dependency to go unnoticed, and one
 * secret that should never have been a constant:
 *
 *   1. Nothing watched the four places this repository takes third-party code
 *      from -- npm packages, the Dockerfile's base images, the compose files'
 *      images, and the actions the workflow runs. Dependabot watches all four.
 *   2. The `npm audit` gate ran only when somebody pushed. A critical advisory
 *      published on a quiet week was invisible until the next push. A daily
 *      schedule closes that.
 *   3. A scheduled job that stops running looks exactly like a scheduled job
 *      that passes: both are silent. A dead-man ping inverts that, so SILENCE
 *      is the alarm.
 *   4. The e2e job signed sessions with a constant committed to the file. It is
 *      now generated per run.
 *
 * Dependabot is also tuned so that what it finds can be reviewed. Its first
 * run opened eleven pull requests, one per dependency, three of them major
 * upgrades nobody had decided on. Minor and patch updates now arrive as one
 * pull request per ecosystem (npm, github-actions), and npm majors are held
 * for a deliberate change.
 *
 * The files are read with regular expressions, as `ci-env-completeness.test.ts`
 * does. When this was written `js-yaml` was only a transitive dependency, so
 * importing it could have made this guard fail for a reason unrelated to what it
 * guards; it is a direct devDependency since Task 18, but this reader still works. Every parse below is asserted non-empty, so a parser that stops
 * finding things fails loudly instead of making each assertion vacuous.
 *
 * COMMENTS ARE NOT CONFIGURATION. The workflow explains itself at length, and
 * those explanations mention `NEXTAUTH_SECRET`, `--audit-level` and the like.
 * Every structural assertion runs on the file with comment lines removed, so a
 * sentence in a comment cannot satisfy a check meant for a line of YAML.
 */

const REPO_ROOT = join(__dirname, '../..');
const CI_PATH = '.github/workflows/ci.yml';
const DEPENDABOT_PATH = '.github/dependabot.yml';

function read(rel: string): string {
  expect(existsSync(join(REPO_ROOT, rel)), `${rel} should exist`).toBe(true);
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** The file's lines with comment-only lines removed. */
function withoutComments(src: string): string[] {
  return src.split('\n').filter((l) => !/^\s*#/.test(l));
}

interface Step {
  name: string;
  /** The `if:` expression, if any. */
  cond: string | undefined;
  env: Record<string, string>;
  /** The `run:` script, one string. Empty for a `uses:` step. */
  run: string;
}

interface Job {
  id: string;
  /** The job's own lines, comments removed. */
  lines: string[];
  steps: Step[];
}

/** One step, from the lines between its `- ` item and the next. */
function parseStep(lines: string[]): Step {
  const name = lines[0].match(/^ {6}- name:\s*(.+)$/)?.[1].trim() ?? '';
  const cond = lines.find((l) => /^ {8}if:/.test(l))?.replace(/^ {8}if:\s*/, '').trim();

  const env: Record<string, string> = {};
  const envAt = lines.findIndex((l) => /^ {8}env:\s*$/.test(l));
  if (envAt > -1) {
    for (let i = envAt + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^ {10}([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) break;
      env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  let run = '';
  const runAt = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (runAt > -1) {
    const inline = lines[runAt].replace(/^ {8}run:\s*/, '').trim();
    if (/^[|>][-+]?$/.test(inline)) {
      const body: string[] = [];
      for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || /^ {10}/.test(lines[i])); i += 1) {
        body.push(lines[i].replace(/^ {10}/, ''));
      }
      run = body.join('\n').trim();
    } else {
      run = inline;
    }
  }
  return { name, cond, env, run };
}

/** Every job in ci.yml, with its steps in order. */
function jobs(): Job[] {
  const lines = withoutComments(read(CI_PATH));
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  expect(start, 'ci.yml should still have a `jobs:` block').toBeGreaterThan(-1);

  const out: Job[] = [];
  let current: { id: string; lines: string[] } | undefined;
  const raw: { id: string; lines: string[] }[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const header = lines[i].match(/^ {2}([a-z][a-z0-9_-]*):\s*$/);
    if (header) {
      current = { id: header[1], lines: [] };
      raw.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    }
  }

  for (const { id, lines: body } of raw) {
    const stepsAt = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
    if (stepsAt === -1) continue;
    const chunks: string[][] = [];
    for (let i = stepsAt + 1; i < body.length; i += 1) {
      if (/^ {6}- /.test(body[i])) chunks.push([body[i]]);
      else if (chunks.length > 0) chunks[chunks.length - 1].push(body[i]);
    }
    out.push({ id, lines: body, steps: chunks.map(parseStep) });
  }
  expect(out.length, 'parsed no jobs from ci.yml -- the parser, not the workflow, is wrong').toBeGreaterThan(0);
  return out;
}

function job(id: string): Job {
  const found = jobs().find((j) => j.id === id);
  expect(found, `ci.yml should still have a \`${id}\` job`).toBeDefined();
  return found!;
}

/** The workflow's `on:` block, comments removed. */
function triggers(): string {
  const lines = withoutComments(read(CI_PATH));
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  expect(start, 'ci.yml should still have an `on:` block').toBeGreaterThan(-1);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])); i += 1) {
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** The workflow's `concurrency:` block, comments removed. */
function concurrency(): { group: string | undefined; cancelInProgress: string | undefined } {
  const lines = withoutComments(read(CI_PATH));
  const start = lines.findIndex((l) => /^concurrency:\s*$/.test(l));
  expect(start, 'ci.yml should still have a `concurrency:` block').toBeGreaterThan(-1);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])); i += 1) {
    body.push(lines[i]);
  }
  const text = body.join('\n');
  return {
    group: text.match(/^ {2}group:\s*(.+)$/m)?.[1].trim(),
    cancelInProgress: text.match(/^ {2}cancel-in-progress:\s*(.+)$/m)?.[1].trim(),
  };
}

interface DependabotIgnore {
  name: string;
  /** `update-types:` -- `version-update:semver-major` and the like. */
  types: string[];
  /** `versions:` -- a range such as `>=23`. */
  versions: string[];
}

interface DependabotGroup {
  name: string;
  /** Every `key: value` under the group; a flow list is its items, a scalar is one item. */
  rules: Record<string, string[]>;
}

interface DependabotEntry {
  ecosystem: string;
  directory: string | undefined;
  interval: string | undefined;
  limit: number | undefined;
  /** `ignore:` rules, one per `dependency-name`. */
  ignores: DependabotIgnore[];
  /** `groups:` -- each one is a single pull request per run. */
  groups: DependabotGroup[];
}

/** A trailing ` # comment` on a value line. */
const TRAILING_COMMENT = /\s+#.*$/;

function unquote(v: string | undefined): string | undefined {
  return v?.replace(TRAILING_COMMENT, '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * A YAML flow list (`["minor", "patch"]`) or a scalar, as unquoted strings.
 * Only flow style is read. A block-style list (`- minor` on its own lines)
 * parses as empty, which every assertion below rejects, so a change of style
 * fails loudly instead of passing vacuously.
 */
function values(raw: string): string[] {
  const body = raw.replace(TRAILING_COMMENT, '').trim().replace(/^\[(.*)\]$/, '$1');
  return body.split(',').map((v) => unquote(v) ?? '').filter(Boolean);
}

/** The lines nested under one of an entry's own keys (4-space indent), e.g. `ignore:`. */
function nested(chunk: string[], key: string): string[] {
  const at = chunk.findIndex((l) => new RegExp(`^ {4}${key}:\\s*$`).test(l));
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < chunk.length && (chunk[i].trim() === '' || /^ {5,}/.test(chunk[i])); i += 1) {
    out.push(chunk[i]);
  }
  return out;
}

function ignoreRules(chunk: string[]): DependabotIgnore[] {
  const items: string[][] = [];
  for (const line of nested(chunk, 'ignore')) {
    if (/^ {6}- dependency-name:/.test(line)) items.push([line]);
    else if (items.length > 0) items[items.length - 1].push(line);
  }
  return items.map((item) => {
    const text = item.join('\n');
    return {
      name: unquote(text.match(/^ {6}- dependency-name:\s*(.+)$/m)?.[1]) ?? '',
      types: values(text.match(/^ {8}update-types:\s*(.+)$/m)?.[1] ?? ''),
      versions: values(text.match(/^ {8}versions:\s*(.+)$/m)?.[1] ?? ''),
    };
  });
}

function groupRules(chunk: string[]): DependabotGroup[] {
  const items: string[][] = [];
  for (const line of nested(chunk, 'groups')) {
    if (/^ {6}[A-Za-z][\w|-]*:\s*$/.test(line)) items.push([line]);
    else if (items.length > 0) items[items.length - 1].push(line);
  }
  return items.map((item) => ({
    name: item[0].trim().replace(/:$/, ''),
    rules: Object.fromEntries(
      item.slice(1).flatMap((l) => {
        const m = l.match(/^ {8}([a-z-]+):\s*(.*)$/);
        return m ? [[m[1], values(m[2])]] : [];
      }),
    ),
  }));
}

function dependabotEntries(): DependabotEntry[] {
  const lines = withoutComments(read(DEPENDABOT_PATH));
  const chunks: string[][] = [];
  for (const line of lines) {
    if (/^ {2}- package-ecosystem:/.test(line)) chunks.push([line]);
    else if (chunks.length > 0) chunks[chunks.length - 1].push(line);
  }
  return chunks.map((chunk) => {
    const text = chunk.join('\n');
    const limit = text.match(/^ {4}open-pull-requests-limit:\s*(\d+)\s*$/m)?.[1];
    return {
      ecosystem: unquote(text.match(/^ {2}- package-ecosystem:\s*(.+)$/m)?.[1]) ?? '',
      directory: unquote(text.match(/^ {4}directory:\s*(.+)$/m)?.[1]),
      interval: unquote(text.match(/^ {6}interval:\s*(.+)$/m)?.[1]),
      limit: limit === undefined ? undefined : Number(limit),
      ignores: ignoreRules(chunk),
      groups: groupRules(chunk),
    };
  });
}

function dependabotEntry(ecosystem: string): DependabotEntry {
  const found = dependabotEntries().find((e) => e.ecosystem === ecosystem);
  expect(found, `dependabot.yml should still have a \`${ecosystem}\` entry`).toBeDefined();
  return found!;
}

/**
 * npm's two ignore rules. Their NAMES are asserted first, as a whole list, so
 * that a duplicate `*` rule or any third rule fails here -- a `.find()` on the
 * name would take the first match and not see the rest. After this the two
 * lookups below are unique.
 */
function npmIgnores(): { blanket: DependabotIgnore; typesNode: DependabotIgnore } {
  const { ignores } = dependabotEntry('npm');
  expect(
    ignores.map((i) => i.name).sort(),
    'npm should ignore majors of everything and hold @types/node below the runtime, and ignore nothing else',
  ).toEqual(['*', '@types/node']);
  return {
    blanket: ignores.find((i) => i.name === '*')!,
    typesNode: ignores.find((i) => i.name === '@types/node')!,
  };
}

/**
 * The one group of an entry. Two groups would be two pull requests a week,
 * which is the opposite of what a group is for.
 */
function onlyGroup(entry: DependabotEntry): DependabotGroup {
  expect(
    entry.groups.map((g) => g.name),
    `${entry.ecosystem} should have exactly one group, so its minor and patch updates are one pull request`,
  ).toHaveLength(1);
  return entry.groups[0];
}

/**
 * A group that takes minor and patch VERSION updates of EVERYTHING, and nothing
 * else. A `patterns` list, `exclude-patterns` or `dependency-type` would leave
 * some dependencies out of it -- they would go back to a pull request each.
 * `applies-to` may say what is already the default, `version-updates`;
 * `security-updates` would move the group off the weekly run altogether.
 */
function expectMinorAndPatchOfEverything(group: DependabotGroup, where: string): void {
  expect([...(group.rules['update-types'] ?? [])].sort(), `${where}: the group takes minor and patch, not major`).toEqual([
    'minor',
    'patch',
  ]);
  expect(
    Object.keys(group.rules).filter((k) => !['update-types', 'patterns', 'applies-to'].includes(k)),
    `${where}: the group must not be narrowed by dependency-type, exclude-patterns or the like`,
  ).toEqual([]);
  expect(
    group.rules['applies-to'] ?? ['version-updates'],
    `${where}: the group applies to version updates, which is what the weekly run opens`,
  ).toEqual(['version-updates']);
  const patterns = group.rules.patterns;
  expect(
    patterns === undefined || (patterns.length === 1 && patterns[0] === '*'),
    `${where}: the group covers every dependency (no \`patterns\`, or only "*")`,
  ).toBe(true);
}

describe('dependency surveillance', () => {
  it('dependabot covers npm, docker, docker-compose and github-actions', () => {
    // If the repository's Insights > Dependency graph > Dependabot page shows
    // that Dependabot does not read the compose files, the `docker-compose` row
    // is removed HERE and in dependabot.yml together, and compose digests are
    // refreshed by another mechanism.
    const expected = [
      ['npm', '/'],
      ['docker', '/docker'],
      ['docker-compose', '/docker'],
      ['github-actions', '/'],
    ];
    const entries = dependabotEntries();

    expect(read(DEPENDABOT_PATH)).toMatch(/^version:\s*2\s*$/m);
    expect(entries.map((e) => [e.ecosystem, e.directory]).sort()).toEqual([...expected].sort());
    for (const e of entries) {
      expect(e.interval, `${e.ecosystem} should be checked weekly`).toBe('weekly');
      expect(e.limit, `${e.ecosystem} should cap open pull requests at 5`).toBe(5);
    }

    // Major versions of the two images that cannot be taken by a routine
    // bump. A new Postgres major cannot start on a data directory written by
    // the previous one (see compose-image-pins.test.ts), and a Node major
    // moves the runtime and must be a deliberate change alongside `.nvmrc`
    // (node-version-alignment.test.ts). Minor and patch updates still arrive,
    // each as its own pull request: the image ecosystems have no group.
    //
    // The two entries are held to exactly this -- the whole list, and no
    // group -- so that a group, a blanket `*` rule or a `versions` range
    // added to them fails here instead of passing beside the two rules.
    const major = ['version-update:semver-major'];
    for (const ecosystem of ['docker', 'docker-compose']) {
      const entry = dependabotEntry(ecosystem);
      expect(entry.groups, `${ecosystem} has no group`).toEqual([]);
      expect(
        [...entry.ignores].sort((a, b) => a.name.localeCompare(b.name)),
        `${ecosystem} should ignore major updates of node and postgres, and nothing else`,
      ).toEqual([
        { name: 'node', types: major, versions: [] },
        { name: 'postgres', types: major, versions: [] },
      ]);
    }
  });

  it('npm minor and patch updates arrive as one pull request a week', () => {
    // The first run opened eleven pull requests at once, one per dependency.
    // One group is one pull request, so the weekly review is a single diff and
    // a single CI run. `ci.yml` runs on that branch like any other.
    expectMinorAndPatchOfEverything(onlyGroup(dependabotEntry('npm')), 'npm');
  });

  it('npm holds every major upgrade for a deliberate change', () => {
    // The same first run proposed TypeScript 5.9 -> 7, vitest 4 -> 5 and
    // @types/node 20 -> 26. A major moves the toolchain or the runtime types,
    // and is made by hand with its own review, not by a weekly bump.
    // Minor and patch updates still arrive (the group above).
    const { blanket } = npmIgnores();
    expect(blanket.types, 'the blanket rule holds majors, and only those').toEqual(['version-update:semver-major']);
    expect(blanket.versions, 'the blanket rule is by update type, not by version').toEqual([]);
  });

  it('npm keeps @types/node on the line of the Node runtime', () => {
    // `.nvmrc` is what CI and the Dockerfile are held to by
    // node-version-alignment.test.ts. Types for a newer Node than the one that
    // runs describe APIs the runtime does not have, and compile against them.
    // The floor is derived from `.nvmrc`, not written here a second time, so
    // moving the runtime to a new major fails this test until the ignore
    // follows it.
    const major = Number(read('.nvmrc').trim().match(/\d+/)?.[0]);
    expect(Number.isInteger(major), '.nvmrc should name a Node major version').toBe(true);

    const { typesNode } = npmIgnores();
    // `>=23` and `>= 23` are the same npm range.
    expect(
      typesNode.versions.map((v) => v.replace(/\s+/g, '')),
      `@types/node should be held below the next Node major (${major + 1})`,
    ).toEqual([`>=${major + 1}`]);
    expect(typesNode.types, 'the @types/node rule is by version only: an update type would widen what it holds').toEqual([]);
  });

  it('github-actions minor and patch updates arrive as one pull request, and majors do not', () => {
    // Action majors are reviewed one at a time -- they change what runs with
    // the repository's token -- so they must keep arriving as their own pull
    // request, outside the group and not ignored.
    const entry = dependabotEntry('github-actions');
    expectMinorAndPatchOfEverything(onlyGroup(entry), 'github-actions');
    expect(
      entry.ignores,
      'github-actions should ignore nothing: a major action update is reviewed in its own pull request',
    ).toEqual([]);
  });

  it('CI runs daily and keeps the critical audit', () => {
    const on = triggers();
    expect(on, 'a daily schedule at 04:23 UTC').toMatch(/^ {2}schedule:\s*\n\s+- cron:\s*['"]23 4 \* \* \*['"]\s*$/m);
    expect(on, 'a manual trigger: `gh workflow run ci.yml`').toMatch(/^ {2}workflow_dispatch:/m);
    // Adding a trigger must not remove the ones the required status checks run on.
    expect(on).toMatch(/^ {2}push:/m);
    expect(on).toMatch(/^ {2}pull_request:/m);

    const audits = jobs().flatMap((j) => j.steps).filter((s) => s.run.includes('npm audit'));
    expect(audits.map((s) => s.run), 'exactly one audit step, at the critical threshold').toEqual([
      'npm audit --omit=dev --audit-level=critical',
    ]);
  });

  it('the scheduled run pings its dead-man check', () => {
    const parsed = jobs();
    const pings = parsed.flatMap((j) => j.steps).filter((s) => s.cond?.includes("github.event_name == 'schedule'"));
    expect(pings.length, 'exactly one step is scheduled-only').toBe(1);
    const ping = pings[0];

    // Runs whether or not the steps before it passed -- a failed audit must
    // send /fail, and a skipped ping would look the same as a dead schedule.
    expect(ping.cond).toBe("always() && github.event_name == 'schedule'");

    // The audit's own job, and last in it: `job.status` is then the audit's
    // verdict, and nothing after the ping can fail unreported.
    const auditJob = parsed.find((j) => j.steps.some((s) => s.run.includes('npm audit')))!;
    expect(auditJob.steps.at(-1), 'the ping is the last step of the job that runs the audit').toBe(ping);

    // `continue-on-error` on the audit step (or the job) would leave
    // `job.status` at `success` when the audit fails, so the ping would report
    // a green run and the `/fail` path below could never fire.
    expect(
      auditJob.lines.filter((l) => /^\s*continue-on-error:/.test(l)),
      `\`${auditJob.id}\` must not use continue-on-error: a failed audit would still ping success`,
    ).toEqual([]);

    // The secret reaches the script through `env:`, never by interpolation into
    // `run:` -- an interpolated value is pasted into the script text before the
    // shell parses it, and into any error that quotes the line.
    expect(ping.env.HC_URL).toBe('${{ secrets.HC_CI_AUDIT_PING_URL }}');
    expect(ping.env.JOB_STATUS).toBe('${{ job.status }}');
    expect(ping.run, 'the script must not interpolate any expression').not.toContain('${{');
    const ci = withoutComments(read(CI_PATH)).join('\n');
    expect(
      ci.match(/secrets\.HC_CI_AUDIT_PING_URL/g)?.length,
      'the secret is named in exactly one place',
    ).toBe(1);

    // A scheduled run must never be cancelled by a push to the same branch: a
    // cancelled run still reaches this `always()` step with `job.status` ==
    // `cancelled`, and would ping `/fail` for a run nothing was wrong with. The
    // event name in the group keeps scheduled, push and manual runs apart, and
    // the rest of the group still supersedes a stale run of the same kind.
    const { group, cancelInProgress } = concurrency();
    expect(group, 'the concurrency group names the event').toContain('${{ github.event_name }}');
    expect(group, 'the group still separates workflows').toContain('${{ github.workflow }}');
    expect(group, 'the group still separates branches and pull requests').toContain('${{ github.ref }}');
    expect(cancelInProgress, 'a superseded run of the same kind is still cancelled').toBe('true');

    // Every use of the URL is double-quoted; the failure form is `<url>/fail`.
    const uses = ping.run.match(/\$HC_URL/g)?.length ?? 0;
    const quoted = ping.run.match(/"\$HC_URL(\/fail)?"/g)?.length ?? 0;
    expect(uses, 'the script should use $HC_URL').toBeGreaterThan(0);
    expect(quoted, 'every $HC_URL is double-quoted').toBe(uses);
    expect(ping.run).toContain('"$HC_URL/fail"');
    expect(ping.run, 'the success URL is chosen when the job succeeded').toMatch(
      /if \[ "\$JOB_STATUS" = "success" \]; then\s+url="\$HC_URL"\s+else\s+url="\$HC_URL\/fail"\s+fi/,
    );

    // Same flags as the project's other ping scripts (docs/runbooks/backup-restore.md).
    expect(ping.run).toContain('curl -fsS -m 10 --retry 3 -o /dev/null "$url"');
  });

  it('CI generates NEXTAUTH_SECRET at run time', () => {
    // No literal anywhere in the file -- comments included, because a value
    // quoted in a comment is committed just the same. 32 random bytes in base64
    // are 43 characters and one `=`. A boolean, not `.not.toMatch`: a failing
    // `toMatch` prints the whole file it was matched against, which here would
    // print the very value this test exists to keep out.
    const raw = read(CI_PATH);
    expect(
      /[A-Za-z0-9+/]{43}=/.test(raw),
      'a base64 value of the shape `openssl rand -base64 32` prints is committed in ci.yml',
    ).toBe(false);

    // Nothing assigns it as a YAML key, in a job's env or a step's.
    const lines = withoutComments(raw);
    expect(lines.filter((l) => /^\s*NEXTAUTH_SECRET:/.test(l)), 'no `NEXTAUTH_SECRET:` key').toEqual([]);
    expect(
      lines.filter((l) => l.includes('NEXTAUTH_SECRET') && !/^\s*- name:/.test(l)).length,
      'outside a step name, the name appears on one line: the write to $GITHUB_ENV',
    ).toBe(1);

    const e2e = job('test-e2e');
    const gen = e2e.steps.find((s) => s.run.includes('NEXTAUTH_SECRET'));
    expect(gen, 'a test-e2e step writes NEXTAUTH_SECRET').toBeDefined();
    expect(gen!.run, 'no expression is interpolated into the script').not.toContain('${{');

    // generate -> mask -> write, in that order, all on the one variable.
    const v = gen!.run.match(/^(\w+)=\$\(openssl rand -base64 32\)$/m)?.[1];
    expect(v, 'the value is `openssl rand -base64 32`').toBeDefined();
    const at = (needle: string) => gen!.run.indexOf(needle);
    const generated = at(`${v}=$(openssl rand -base64 32)`);
    const masked = at(`echo "::add-mask::$${v}"`);
    const written = at(`echo "NEXTAUTH_SECRET=$${v}" >> "$GITHUB_ENV"`);
    expect(generated, 'generated').toBeGreaterThan(-1);
    expect(masked, 'masked, after it is generated').toBeGreaterThan(generated);
    expect(written, 'written to $GITHUB_ENV only after it is masked').toBeGreaterThan(masked);

    // Before the first step that boots the app: the server and `next build`
    // both read it, and the fixture step signs sessions with it.
    const first = e2e.steps.findIndex((s) => /npm run build|playwright test/.test(s.run));
    expect(first, 'the e2e job still builds and drives the app').toBeGreaterThan(-1);
    expect(e2e.steps.indexOf(gen!), 'generated before anything reads it').toBeLessThan(first);
  });
});
