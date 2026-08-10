import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D-192 (opened 2026-08-08 while building CI for D-146; ruled on 2026-08-10).
 *
 * Three numbers described one application — `docker/Dockerfile`'s
 * `FROM node:20-alpine`, `.github/workflows/ci.yml`'s `node-version: '22'`,
 * and the v22.22.3 the project is actually developed against — with
 * NOTHING keeping them aligned: no `engines` field, no `.nvmrc`, and
 * `next`'s own `engines.node: '>=20.9.0'` floor satisfied by all of them,
 * so nothing broke and nothing complained. CI passing had stopped being
 * evidence that the Dockerfile's Node 20 build path was exercised at all.
 *
 * The failure mode is the one `effective-config.test.ts` already documents
 * for ESLint config: reading each declaration ON ITS OWN shows a correct
 * declaration every time. Divergence is a property of the SET, and only a
 * check that reads every site at once can see it.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION: `.nvmrc` is genuinely read by
 * CI (`actions/setup-node`'s `node-version-file`) and by `nvm`/`fnm`/`asdf`
 * locally, but Docker CANNOT read it — a `FROM` line takes no file input,
 * so `docker/Dockerfile` must restate the version as an `ARG` default.
 * That restatement is irreducible, so the copy has to be pinned by
 * something. This is that something.
 *
 * SITES ARE DISCOVERED, NOT LISTED (AGENTS.md §3, "where a list must be
 * complete, generate it rather than writing it"). The scan walks
 * `git ls-files`, so a second Dockerfile or a new workflow is in scope the
 * moment it is tracked — a hand-written list of two paths would have gone
 * stale at the first addition and passed while doing so.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (AGENTS.md §2, the D-191 check).
 * The PROPERTY is "the Node major version declared for this project cannot
 * silently diverge across the places that declare it". What these tests
 * CAUSE is: every tracked workflow and Dockerfile is parsed for a Node
 * version and compared against `.nvmrc`, and the discovery itself is
 * asserted non-empty so a broken glob fails loudly instead of passing
 * vacuously. That entails the property FOR DECLARED VERSIONS. It does not,
 * and cannot, establish that any given runtime OBEYS the declaration — a
 * developer running `node` v20 with no version manager is outside its
 * reach, and `engines` is advisory to npm unless `engine-strict` is set
 * (it is not; enabling it also applies to transitive dependencies'
 * engines fields, a known source of spurious install failures).
 *
 * Non-vacuity, proven by hand rather than asserted: written before the
 * fix, against the divergent tree, and watched to fail — `.nvmrc` absent,
 * Dockerfile major 20 vs CI major 22, `engines` undefined. See the commit
 * message for the recorded output.
 */

const REPO_ROOT = join(__dirname, '../..');

/** Tracked files only — generation from git, not a hand-maintained glob. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** First integer run in a version-ish string: `22`, `'22'`, `v22.22.3`, `>=22` -> 22. */
function majorOf(raw: string): number | null {
  const m = /(\d+)/.exec(raw);
  return m ? Number(m[1]) : null;
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** The single source of truth every other site is measured against. */
function canonicalMajor(): number {
  const major = majorOf(read('.nvmrc').trim());
  if (major === null) throw new Error('.nvmrc does not name a Node version');
  return major;
}

type Site = { file: string; line: number; raw: string; major: number };

/** Node versions declared by any tracked GitHub Actions workflow. */
function workflowSites(): Site[] {
  const sites: Site[] = [];
  for (const file of trackedFiles().filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f))) {
    read(file).split('\n').forEach((text, i) => {
      const literal = /^\s*node-version:\s*['"]?([^'"#\s]+)/.exec(text);
      if (literal) {
        const major = majorOf(literal[1]);
        if (major !== null) sites.push({ file, line: i + 1, raw: literal[1], major });
      }
      const fromFile = /^\s*node-version-file:\s*['"]?([^'"#\s]+)/.exec(text);
      if (fromFile) {
        const referenced = fromFile[1];
        if (!existsSync(join(REPO_ROOT, referenced))) {
          throw new Error(`${file}:${i + 1} reads node-version-file '${referenced}', which does not exist`);
        }
        const major = majorOf(read(referenced).trim());
        if (major !== null) sites.push({ file, line: i + 1, raw: `${referenced} -> ${major}`, major });
      }
    });
  }
  return sites;
}

/** Node versions declared by any tracked Dockerfile, resolving `ARG` indirection. */
function dockerfileSites(): Site[] {
  const sites: Site[] = [];
  for (const file of trackedFiles().filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f))) {
    const lines = read(file).split('\n');
    const args = new Map<string, string>();
    lines.forEach((text) => {
      const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)/.exec(text);
      if (arg) args.set(arg[1], arg[2]);
    });
    lines.forEach((text, i) => {
      const from = /^\s*FROM\s+node:(\S+)/i.exec(text);
      if (!from) return;
      // Resolve `${NODE_VERSION}` against the ARG defaults collected above.
      const resolved = from[1].replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
        args.get(name) ?? whole,
      );
      const major = majorOf(resolved);
      if (major !== null) sites.push({ file, line: i + 1, raw: resolved, major });
    });
  }
  return sites;
}

describe('D-192 — one Node major version, declared in one place', () => {
  it('.nvmrc exists and names a Node major version', () => {
    expect(existsSync(join(REPO_ROOT, '.nvmrc')), '.nvmrc is the single source of truth').toBe(true);
    expect(canonicalMajor()).toBeGreaterThanOrEqual(20);
  });

  it('discovery reaches the sites that exist today (guards against a vacuous pass)', () => {
    // A broken scan returning [] would satisfy every `every()` below. These
    // two files are known to declare a Node version right now, so if the
    // scan cannot see them the scan itself is broken, not the config.
    expect(workflowSites().map((s) => s.file)).toContain('.github/workflows/ci.yml');
    expect(dockerfileSites().map((s) => s.file)).toContain('docker/Dockerfile');
  });

  it('every workflow resolves to the canonical Node major', () => {
    const canonical = canonicalMajor();
    for (const site of workflowSites()) {
      expect(site.major, `${site.file}:${site.line} declares '${site.raw}'`).toBe(canonical);
    }
  });

  it('every Dockerfile resolves to the canonical Node major', () => {
    const canonical = canonicalMajor();
    for (const site of dockerfileSites()) {
      expect(site.major, `${site.file}:${site.line} builds on node:${site.raw}`).toBe(canonical);
    }
  });

  it("package.json's engines.node floor matches the canonical Node major", () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node, 'package.json declares no engines.node floor').toBeDefined();
    expect(majorOf(pkg.engines!.node!)).toBe(canonicalMajor());
  });
});
