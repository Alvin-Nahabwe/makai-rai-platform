import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgRole } from '@prisma/client';
import type { OrgFixture } from './recordFixture';

/**
 * The replay harness of NFR-INT-02 (00-contract.md, "Further cross-unit symbols", `replayCases.ts` row; gaps G037,
 * G100): one case file per retry-keyed write route and method, under `__tests__/integration/replay-cases/`, each
 * beginning `// FR-DEC-07 NFR-INT-02 replay case for <ROUTE_ACTIONS key>` and exporting `replayCase`.
 * `__tests__/integration/retry-keyed-writes.test.ts` runs every case: a replay, the same request id with a changed
 * request, and 20 concurrent copies. The harness sends bodies only; each route digests its own path and body, so a
 * case's `params` are part of what is replayed. Each case runs against an emptied database and a new organisation.
 *
 * A producer of a `RETRY_KEYED_WRITES` route adds its case file in the commit that deletes the route from
 * `PENDING_ROUTES` (or, when that commit comes before `unit/dec-a` is in its branch, in its first commit after rebasing
 * onto it); otherwise the coverage case of `retry-keyed-writes.test.ts` fails naming the route.
 */
export interface ReplayCase {
  /** The `ROUTE_ACTIONS` key, for example 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts'. */
  route: string;
  /** The handler the harness calls. */
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Default `{ first: 201, replay: 200 }`; a 204 route declares `{ first: 204, replay: 204 }`; rows 26 DELETE on oneself and 27 `{ first: 204, replay: 404 }`. */
  statuses?: { first: number; replay: number };
  /** Default 1: the change in `rows()` after the first call; -1 for a removal. */
  effect?: 1 | -1;
  /** `false` skips the generated changed-request case (rows 27 and 26 DELETE on oneself: the gate refuses their second call). */
  changedRequest?: false;
  prepare(fx: OrgFixture): Promise<{
    role: OrgRole;
    params: Record<string, string>;
    /** A fresh but identical body on every call. */
    body: () => Record<string, unknown> | FormData;
    /** The same request id, another value. */
    changedBody: () => Record<string, unknown> | FormData;
    /** The same request id against another object (a route whose body is only `{ requestId }`). */
    changedParams?: () => Record<string, string>;
    /** A count that moves by exactly `effect` after the first call (with `changedParams`: over both objects). */
    rows: () => Promise<number>;
    /** Only for a route whose reply body names the resource; absent, ids are not compared (a 204 has no body). */
    resourceId?: (json: unknown) => string;
  }>;
}

export type PreparedReplay = Awaited<ReturnType<ReplayCase['prepare']>>;
export type ReplayBody = Record<string, unknown> | FormData;

/** What the generated 409 case sends: with `changedParams`, `body()` to `changedParams()` (`changedBody` is ignored); otherwise `changedBody()` to `params`. */
export function conflictingRequest(p: PreparedReplay): { params: Record<string, string>; body: ReplayBody } {
  return p.changedParams ? { params: p.changedParams(), body: p.body() } : { params: p.params, body: p.changedBody() };
}

/** The two statuses the generated case expects: the case's own, else `{ first: 201, replay: 200 }`. */
export function expectedStatuses(c: Pick<ReplayCase, 'statuses'>): { first: number; replay: number } {
  return c.statuses ?? { first: 201, replay: 200 };
}

/** True when the two reply bodies name the same resource; true without comparing when the case has no `resourceId`. */
export function sameResource(p: PreparedReplay, first: unknown, replay: unknown): boolean {
  return p.resourceId === undefined || p.resourceId(first) === p.resourceId(replay);
}

/** The change in `rows()` the generated cases expect: the case's own `effect`, else 1. */
export function expectedEffect(c: Pick<ReplayCase, 'effect'>): 1 | -1 {
  return c.effect ?? 1;
}

/** False only when the case sets `changedRequest: false`. */
export function checksChangedRequest(c: Pick<ReplayCase, 'changedRequest'>): boolean {
  return c.changedRequest !== false;
}

/**
 * What is wrong with the 20 concurrent copies of a case, as the contract's ReplayCase row asks: an answer that is neither
 * `statuses.first` nor `statuses.replay`, or a change in `rows()` other than one `effect`, each as one line. How many
 * copies answer `first` is not checked: in receipt mode, copies that passed the gate before the first committed replay
 * with the first's status (MEM's rows 26 DELETE on oneself and 27).
 */
export function concurrentCopiesProblems(c: Pick<ReplayCase, 'statuses' | 'effect'>, statuses: readonly number[], delta: number): string[] {
  const { first, replay } = expectedStatuses(c);
  const problems = statuses.filter((s) => s !== first && s !== replay).map((s) => `answer ${s} is neither ${first} nor ${replay}`);
  if (delta !== expectedEffect(c)) problems.push(`rows() changed by ${delta}, not ${expectedEffect(c)}`);
  return problems;
}

const CASE_DIR = join(process.cwd(), '__tests__', 'integration', 'replay-cases');

/**
 * Every `*.case.ts` under `__tests__/integration/replay-cases/`, in file-name order. A case file that exports no
 * `replayCase`, or whose first line does not name the route its case runs (the line V-prog's RF-1 lint reads),
 * throws, naming the file, so a case can neither be dropped silently nor be counted for another route.
 */
export async function loadReplayCases(): Promise<ReplayCase[]> {
  const files = readdirSync(CASE_DIR).filter((f) => f.endsWith('.case.ts')).sort();
  return Promise.all(files.map(async (f) => {
    const mod = (await import(/* @vite-ignore */ join(CASE_DIR, f))) as { replayCase?: ReplayCase };
    if (mod.replayCase === undefined) throw new Error(`replay case ${f} exports no replayCase`);
    const firstLine = readFileSync(join(CASE_DIR, f), 'utf8').split('\n', 1)[0];
    if (firstLine !== `// FR-DEC-07 NFR-INT-02 replay case for ${mod.replayCase.route}`) {
      throw new Error(`replay case ${f}: its first line does not name its route ${mod.replayCase.route}`);
    }
    return mod.replayCase;
  }));
}
