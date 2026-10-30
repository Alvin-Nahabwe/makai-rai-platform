import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';

// Loaded with require so Vite does not try to read typescript's source map.
const ts = createRequire(__filename)('typescript') as typeof import('typescript');

/**
 * NFR-OBS-05: a page that fails because the database cannot be reached shows a support reference of its own
 * failure, not Next's hash of the message and stack, which is the same for every request that fails the same way.
 * The reference is put on the error where the client fails (`withUnavailableStamp`, lib/http/supportReference.ts),
 * so every client that reaches a database lane has to be made through it. There are four today (the app lane's,
 * the identity lane's base client, K0a's `identityLaneClient` and the pre-auth client); this file finds them in
 * the source, so a fifth cannot be added unwrapped, and runs a query through each of them against a port nothing
 * listens on.
 */

const REFERENCE = /^[0-9a-f]{8}$/;
const CLOSED = 'postgresql://u:p@127.0.0.1:1/x';
const ROOT = path.resolve(__dirname, '../..');

/** The files that build a Prisma client, and how many each builds. A new entry needs a probe below. */
const CLIENT_SITES: Record<string, number> = {
  'lib/data/identity.ts': 1,
  'lib/data/identityClient.ts': 1,
  'lib/data/preauth.ts': 1,
  'lib/data/tenant.ts': 1,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `new …PrismaClient(...)` in the file, with whether it is the first argument of `withUnavailableStamp(...)`. */
function prismaConstructions(file: string, text: string): Array<{ file: string; line: number; wrapped: boolean }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ file: string; line: number; wrapped: boolean }> = [];
  const visit = (node: import('typescript').Node) => {
    if (ts.isNewExpression(node) && /(^|\.)PrismaClient$/.test(node.expression.getText(sf))) {
      const parent = node.parent;
      const wrapped =
        ts.isCallExpression(parent) && parent.expression.getText(sf) === 'withUnavailableStamp' && parent.arguments[0] === node;
      found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, wrapped });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('every client that reaches a database lane is made through withUnavailableStamp', () => {
  const all = ['lib', 'app', 'components', 'scripts']
    .flatMap((d) => (statSync(path.join(ROOT, d), { throwIfNoEntry: false })?.isDirectory() ? sourceFiles(path.join(ROOT, d)) : []))
    .concat(readdirSync(ROOT).filter((n) => /\.(ts|mjs)$/.test(n)).map((n) => path.join(ROOT, n)))
    .map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }))
    .flatMap(({ file, text }) => prismaConstructions(file, text));

  it('NFR-OBS-05: none of them is built bare', () => {
    expect(all.filter((c) => !c.wrapped).map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });

  it('NFR-OBS-05: the files that build one are the files below, each with its probe, so a fifth client needs a probe before it passes', () => {
    const counts: Record<string, number> = {};
    for (const c of all) counts[c.file] = (counts[c.file] ?? 0) + 1;
    expect(counts).toEqual(CLIENT_SITES);
  });

  it('the finder sees a bare client, a wrapped one, and one that is only named in a comment or a string', () => {
    const bare = prismaConstructions('x.ts', 'const a = new PrismaClient({});');
    expect(bare).toEqual([{ file: 'x.ts', line: 1, wrapped: false }]);
    const generated = prismaConstructions('x.ts', 'const a = new generated.PrismaClient({});');
    expect(generated.map((c) => c.wrapped)).toEqual([false]);
    const wrapped = prismaConstructions('x.ts', 'const a = withUnavailableStamp(\n  new PrismaClient({}),\n);');
    expect(wrapped).toEqual([{ file: 'x.ts', line: 2, wrapped: true }]);
    // The stamp must be on the client itself, not on something else in the same call.
    expect(prismaConstructions('x.ts', 'const a = withUnavailableStamp(other, new PrismaClient({}));').map((c) => c.wrapped)).toEqual([false]);
    expect(prismaConstructions('x.ts', '// new PrismaClient({})\nconst s = "new PrismaClient()";')).toEqual([]);
  });
});

describe('a query through each lane client, against a port nothing listens on, fails with a reference of its own', () => {
  const clients: Array<() => Promise<unknown>> = [];

  beforeAll(() => {
    vi.stubEnv('APP_DATABASE_URL', CLOSED);
    vi.stubEnv('IDENTITY_DATABASE_URL', CLOSED);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(clients.map((close) => close().catch(() => undefined)));
  });

  async function failure(run: () => Promise<unknown>): Promise<string> {
    const e = await run().then(() => null, (err: unknown) => err);
    expect(e, 'the query reached a database').not.toBeNull();
    expect(isDatabaseUnavailable(e)).toBe(true);
    const digest = (e as { digest?: unknown }).digest;
    expect(digest, 'the error carries no support reference').toMatch(REFERENCE);
    return digest as string;
  }

  it('NFR-OBS-05: the app lane\'s client, withOrg and the reminder lane (one transaction body) stamp a failure to connect', async () => {
    const { appClient, withOrg, systemContext } = await import('@/lib/data/tenant');
    clients.push(() => appClient.$disconnect());
    const refs = [
      await failure(() => appClient.$queryRaw`SELECT 1`),
      await failure(() => appClient.$transaction(async (tx) => tx.$queryRaw`SELECT 1`)),
      await failure(() => withOrg({ orgId: 'org_1', role: 'owner' } as never, async (tx) => tx.$queryRaw`SELECT 1`)),
      await failure(() => systemContext('org_1', 'reminders', (lane) => lane.memberRoles(['u1']))),
    ];
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('NFR-OBS-05: K0a\'s identityLaneClient stamps a failure', async () => {
    const { identityLaneClient } = await import('@/lib/data/identityClient');
    clients.push(() => identityLaneClient.$disconnect());
    const a = await failure(() => identityLaneClient.$queryRaw`SELECT 1`);
    const b = await failure(() => identityLaneClient.$queryRaw`SELECT 1`);
    const c = await failure(() => identityLaneClient.$transaction(async (tx) => tx.$queryRaw`SELECT 1`));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('NFR-OBS-05: the identity lane\'s guarded surface (its base client) stamps a failure', async () => {
    const { identityDb } = await import('@/lib/data/identity');
    clients.push(() => identityDb.$disconnect());
    await failure(() => identityDb.user.findFirst());
  });

  it('NFR-OBS-05: the pre-auth client stamps a failure', async () => {
    const { orgBySlug } = await import('@/lib/data/preauth');
    await failure(() => orgBySlug('probe-org'));
  });
});
