import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PENDING_ROUTES, RETRY_KEYED_WRITES, ROUTE_ACTIONS, UNKEYED_WRITES } from '@/lib/authz/routeActions';

/**
 * Review Focus RF-1 (00-master.md): every write route and method that takes a request id has a replay case file, so
 * DEC-a's generated replay test (__tests__/helpers/replayCases.ts) runs it. What this proves: that a case file names
 * the route on its first line and the method in its `method:` field, for each keyed method of the route (one case file
 * per route and method, replayCases.ts). What it does not prove: that the case is right; the replay test runs it, and
 * each owner unit's reviewer checks it. __tests__/integration/retry-keyed-writes.test.ts checks the same pairs by
 * importing the cases; this lint reads the files' text, so it needs no database.
 */
const SEVEN_KIND_ACTIONS = ['decision:write', 'decision:withdraw', 'evidence:create', 'finding:raise', 'finding:reopen',
  'finding:withdraw', 'mitigation:write', 'risk:accept', 'review:open', 'review:seal', 'document:generate',
  'document:withdraw'] as const;   // FR-DEC-07's seven kinds, SRS line 773, as the contract's actions write them
const CASE_LINE = '// FR-DEC-07 NFR-INT-02 replay case for ';
const MEM_PRJ_REASON = 'keyed by MEM or PRJ (owner answer A1)';   // the reason K0b gives rows 21 to 29 in UNKEYED_WRITES (contract Routes; round 9)

/** A case file's header: its first line and the method its `method:` field names (null when it names none). */
export type CaseHeader = { firstLine: string; method: string | null };

/** "<METHOD> <route key>" for each keyed method of a non-pending route with no case file for that route and method. */
export function uncovered(keyed: Readonly<Record<string, readonly string[]>>, pending: readonly string[],
  cases: ReadonlyMap<string, CaseHeader>): string[] {
  const named = new Set([...cases.values()].filter((c) => c.firstLine.startsWith(CASE_LINE) && c.method !== null)
    .map((c) => `${c.firstLine.slice(CASE_LINE.length)}::${c.method}`));
  const out: string[] = [];
  for (const [route, methods] of Object.entries(keyed)) {
    if (pending.includes(route)) continue;
    for (const m of methods) if (!named.has(`${route}::${m}`)) out.push(`${m} ${route}`);
  }
  return out;
}

/** The method a case file's `method:` field names: `method: 'POST'` on a line of its own. */
const METHOD_FIELD = /^\s*method:\s*'(GET|POST|PATCH|DELETE)',?\s*$/m;

/** git ls-files -co --exclude-standard '__tests__/integration/replay-cases/*.case.ts', each file's header. */
function caseHeaders(): Map<string, CaseHeader> {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '__tests__/integration/replay-cases/*.case.ts'],
    { encoding: 'utf8' }).split('\n').filter(Boolean);
  return new Map(files.map((f) => {
    const text = readFileSync(f, 'utf8');
    return [f, { firstLine: text.split('\n')[0], method: METHOD_FIELD.exec(text)?.[1] ?? null }];
  }));
}

/** "<METHOD> <route key>" for each method of an entry whose reason is exactly MEM_PRJ_REASON. */
export function stillOwed(unkeyed: Readonly<Record<string, { methods: readonly string[]; reason: string }>>): string[] {
  return Object.entries(unkeyed).filter(([, u]) => u.reason === MEM_PRJ_REASON)
    .flatMap(([route, u]) => u.methods.map((m) => `${m} ${route}`));
}

describe('RF-1: replay test coverage of the write routes', () => {
  it('NFR-INT-02: every retry-keyed write route and method has a replay case file', () => {
    expect(uncovered(RETRY_KEYED_WRITES, PENDING_ROUTES, caseHeaders())).toEqual([]);
  });

  it('NFR-INT-02: every route that writes one of the seven kinds is retry-keyed', () => {
    const missing: string[] = [];
    for (const [file, methods] of Object.entries(ROUTE_ACTIONS))
      for (const [m, action] of Object.entries(methods))
        if (m !== 'GET' && (SEVEN_KIND_ACTIONS as readonly string[]).includes(action!)
            && !RETRY_KEYED_WRITES[file]?.includes(m as never) && UNKEYED_WRITES[file]?.reason !== 'writes nothing')
          missing.push(`${m} ${file}`);
    expect(missing).toEqual([]);
  });

  it('NFR-INT-02: the replay lint names a route and method that has no case file', () => {
    const k = { 'app/api/x/route.ts': ['POST'] };
    const one = (firstLine: string, method: string | null = 'POST') => new Map([['x.case.ts', { firstLine, method }]]);
    expect(uncovered(k, [], new Map())).toEqual(['POST app/api/x/route.ts']);
    expect(uncovered(k, ['app/api/x/route.ts'], new Map())).toEqual([]);
    expect(uncovered(k, [], one(`${CASE_LINE}app/api/x/route.ts`))).toEqual([]);
    expect(uncovered(k, [], one(`// ${CASE_LINE}app/api/x/route.ts`))).toEqual(['POST app/api/x/route.ts']);
    expect(uncovered(k, [], one(`${CASE_LINE}app/api/x/route.ts.bak`))).toEqual(['POST app/api/x/route.ts']);
    expect(uncovered(k, [], one(`${CASE_LINE}app/api/x/route.ts`, null))).toEqual(['POST app/api/x/route.ts']);
    // Two keyed methods on one route (as members/[userId] holds PATCH and DELETE): one case file covers one method only.
    const two = { 'app/api/y/route.ts': ['PATCH', 'DELETE'] };
    expect(uncovered(two, [], new Map([['y.case.ts', { firstLine: `${CASE_LINE}app/api/y/route.ts`, method: 'PATCH' }]])))
      .toEqual(['DELETE app/api/y/route.ts']);
  });

  it('NFR-INT-02: every case file names its method on a line the lint reads', () => {
    expect([...caseHeaders()].filter(([, c]) => c.method === null).map(([f]) => f)).toEqual([]);
  });

  // Round 9 (owner answer A1): MEM and PRJ move rows 21 to 29 to RETRY_KEYED_WRITES; until then K0b lists them under MEM_PRJ_REASON
  it('NFR-INT-02: the release check names a method still listed as keyed by MEM or PRJ, and ignores every other reason', () => {
    const u = {
      'app/api/a/route.ts': { methods: ['PATCH', 'DELETE'], reason: MEM_PRJ_REASON },
      'app/api/b/route.ts': { methods: ['POST'], reason: 'writes nothing' },
      'app/api/c/route.ts': { methods: ['POST'], reason: 'removed by RM' },
    };
    expect(stillOwed(u)).toEqual(['PATCH app/api/a/route.ts', 'DELETE app/api/a/route.ts']);
    expect(stillOwed({ 'app/api/a/route.ts': { methods: ['POST'], reason: `${MEM_PRJ_REASON} ` } })).toEqual([]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-INT-02: at the release candidate no write method is still listed as keyed by MEM or PRJ', () => {
    expect(stillOwed(UNKEYED_WRITES)).toEqual([]);   // RELEASE_CANDIDATE=1 (set by V and RC); without it these rows are allowed
  });
});
