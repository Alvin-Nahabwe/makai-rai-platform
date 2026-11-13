import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Identity } from '@/lib/auth/identity';

/**
 * Plan 1A Task 11 (ruling L2-50; security obligations T1, T2, T3): what the signed-in layout reads for the shell. One read of
 * the person's own memberships, one role label per organisation and one for the platform, and only the slug and name of each
 * organisation reach the client. The account's platform role field never does (D-10).
 */

const membershipsMock = vi.hoisted(() => vi.fn());
const orgRoleLabelMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: membershipsMock }));
vi.mock('@/lib/authz/roleLabel', () => ({ orgRoleLabel: orgRoleLabelMock }));

import { loadShellData, roleWord } from '@/lib/shell/data';

const identity: Identity = { userId: 'user-1', email: 'a@example.test', name: 'Ssekandi Nnaŋŋa', platformRole: 'assessor', mustChangePassword: false };

/** A membership row as membershipsForUser returns it: the whole organisation row comes with it. */
const row = (slug: string, name: string) => ({
  id: `m-${slug}`, orgId: `org-id-${slug}`, userId: 'user-1', role: 'viewer', status: 'active',
  org: { id: `org-id-${slug}`, slug, name, legalName: `Legal name of ${slug}`, deletedAt: null, createdAt: new Date('2026-01-01') },
});

describe('loadShellData', () => {
  beforeEach(() => {
    membershipsMock.mockReset();
    orgRoleLabelMock.mockReset();
    orgRoleLabelMock.mockResolvedValue(null);
  });

  it('1A Task 11 L2-50 T1: one read of the memberships, one label per organisation and one for the platform', async () => {
    membershipsMock.mockResolvedValue([row('a', 'Alpha'), row('b', 'Beta')]);
    await loadShellData(identity);
    expect(membershipsMock).toHaveBeenCalledTimes(1);
    expect(membershipsMock).toHaveBeenCalledWith('user-1');
    expect(orgRoleLabelMock.mock.calls.map((c) => c[1]).sort()).toEqual(['a', 'b', undefined]);
    for (const call of orgRoleLabelMock.mock.calls) expect(call[0]).toBe(identity);
  });

  it('1A Task 11 L2-50: the shape, with the role words capitalised and the organisations sorted by name then slug', async () => {
    membershipsMock.mockResolvedValue([row('c', 'Zeta'), row('b', 'Alpha'), row('a', 'Alpha')]);
    orgRoleLabelMock.mockImplementation(async (_i: unknown, slug: string | undefined) => ({ a: 'viewer', b: 'owner', c: 'assessor' })[slug ?? ''] ?? null);
    const shell = await loadShellData(identity);
    expect(shell).toEqual({
      userId: 'user-1', userName: 'Ssekandi Nnaŋŋa', platformLabel: null,
      roleLabels: { a: 'Viewer', b: 'Owner', c: 'Assessor' },
      orgs: [{ slug: 'a', name: 'Alpha' }, { slug: 'b', name: 'Alpha' }, { slug: 'c', name: 'Zeta' }],
    });
  });

  it('1A Task 11 L2-50 T2: only the slug and the name of each organisation are kept, nothing else of its row', async () => {
    membershipsMock.mockResolvedValue([row('a', 'Alpha')]);
    const shell = await loadShellData(identity);
    expect(Object.keys(shell.orgs[0]).sort()).toEqual(['name', 'slug']);
    const serialised = JSON.stringify(shell);
    for (const value of ['org-id-a', 'm-a', 'Legal name of a', '2026-01-01', 'deletedAt']) expect(serialised).not.toContain(value);
  });

  it('1A Task 11 L2-50 T2 (D-10): the account\'s platform role field appears nowhere in the result', async () => {
    membershipsMock.mockResolvedValue([row('a', 'Alpha')]);
    orgRoleLabelMock.mockImplementation(async (_i: unknown, slug: string | undefined) => (slug === 'a' ? 'viewer' : null));
    const shell = await loadShellData(identity);
    expect(JSON.stringify(shell)).not.toContain('assessor');
    expect(JSON.stringify(shell)).not.toContain('platformRole');
  });

  it('1A Task 11 L2-50: a null label gives no key, and a name of null gives an empty name', async () => {
    membershipsMock.mockResolvedValue([row('a', 'Alpha'), row('b', 'Beta')]);
    orgRoleLabelMock.mockImplementation(async (_i: unknown, slug: string | undefined) => (slug === 'a' ? 'viewer' : null));
    const shell = await loadShellData({ ...identity, name: null });
    expect(Object.keys(shell.roleLabels)).toEqual(['a']);
    expect(shell.userName).toBe('');
  });

  it('1A Task 11 L2-50 T3 NFR-SEC-07: an organisation whose slug is __proto__ or constructor cannot put a key on the prototype', async () => {
    membershipsMock.mockResolvedValue([row('__proto__', 'P'), row('constructor', 'C')]);
    orgRoleLabelMock.mockResolvedValue('viewer');
    const shell = await loadShellData(identity);
    expect(Object.hasOwn(shell.roleLabels, '__proto__')).toBe(true);
    expect(Object.hasOwn(shell.roleLabels, 'constructor')).toBe(true);
    expect(shell.roleLabels.__proto__).toBe('Viewer');
    expect(shell.roleLabels.constructor).toBe('Viewer');
    // An address that names an organisation the person is not in finds nothing inherited.
    expect(Object.hasOwn(shell.roleLabels, 'toString')).toBe(false);
    // A plain object: React refuses a null-prototype object as a prop of a client component ("null prototypes are not supported").
    expect(Object.getPrototypeOf(shell.roleLabels)).toBe(Object.prototype);
  });

  it('1A Task 11 L2-50: the MAK-AI administrator gets the platform label and no organisations', async () => {
    membershipsMock.mockResolvedValue([]);
    orgRoleLabelMock.mockImplementation(async (_i: unknown, slug: string | undefined) => (slug === undefined ? 'MAK-AI administrator' : null));
    const shell = await loadShellData({ ...identity, platformRole: 'admin' });
    expect(shell.platformLabel).toBe('MAK-AI administrator');
    expect(shell.orgs).toEqual([]);
    expect(Object.keys(shell.roleLabels)).toEqual([]);
  });

  it('1A Task 11 T1: the shell data module and the signed-in layout read only through membershipsForUser and orgRoleLabel', () => {
    const expected: Record<string, string[]> = {
      'lib/shell/data.ts': ['@/lib/auth/identity', '@/lib/authz/roleLabel', '@/lib/data/preauth', '@/lib/shell/types', '@/lib/vocabulary/terms'],
      'app/(authenticated)/layout.tsx': [
        '@/components/layout/AppShell', '@/components/layout/IdleWarning', '@/components/legal/NewerLegalTextNotice', '@/lib/auth/identity',
        '@/lib/auth/idle', '@/lib/auth/idleDeadline', '@/lib/shell/data', 'next/headers',
      ],
    };
    for (const [file, modules] of Object.entries(expected)) {
      expect(moduleSpecifiers(file), file).toEqual(modules);
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      // The layout reads the cookie's deadlines (headers()) and leaves the memberships to loadShellData.
      const forbidden = file === 'lib/shell/data.ts'
        ? /idleDeadline|next-auth\/jwt|identityClient|identityLaneClient|systemContext|prisma|headers\(|cookies\(/
        : /next-auth\/jwt|identityClient|identityLaneClient|systemContext|prisma|cookies\(|membershipsForUser|orgRoleLabel/;
      expect(source, file).not.toMatch(forbidden);
    }
  });
});

/** Every module a file names: import declarations (side-effect ones included), export-from, dynamic import() and require(), sorted. */
function moduleSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      out.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '(not a literal)');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(out)].sort();
}

describe('roleWord', () => {
  it('1A Task 11 L2-50 (CONSOLIDATED section 2): the five organisation roles are shown capitalised, from the vocabulary', () => {
    expect(['owner', 'admin', 'assessor', 'reviewer', 'viewer'].map(roleWord)).toEqual(['Owner', 'Admin', 'Assessor', 'Reviewer', 'Viewer']);
  });

  it('1A Task 11 L2-50: any other label is shown as it is, never hidden, and a prototype name is not looked up', () => {
    expect(roleWord('MAK-AI administrator')).toBe('MAK-AI administrator');
    expect(roleWord('Viewer')).toBe('Viewer');
    expect(roleWord('toString')).toBe('toString');
    expect(roleWord('__proto__')).toBe('__proto__');
  });
});
