// The liveness check for control resource links (scripts/content/check-links.mjs).
//
// SRS 10.6: "Resource links: Checked automatically for liveness at the freeze. A link that fails is
// removed." Nothing here touches the network: every case injects its own `fetchImpl`, except the one
// that runs the command with no argument, which fails before it reads a file.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLinks, main } from '../../scripts/content/check-links.mjs';

const LIVE = 'https://live.example/a';
const GONE = 'https://gone.example/b';
const SLOW = 'https://slow.example/c';

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a table: a number is the status, an Error is thrown. HEAD and GET share the answer unless `byMethod` says otherwise. */
function fakeFetch(table: Record<string, number | Error>, byMethod: Record<string, Record<string, number>> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const forMethod = byMethod[url]?.[init?.method ?? 'GET'];
    const answer: unknown = forMethod ?? table[url];
    if (answer instanceof Error) throw answer;
    if (typeof answer !== 'number') throw new Error(`the fake has no answer for ${url}`);
    return { status: answer } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

const scratchDirs: string[] = [];
function areasFile(controls: Array<{ id: string; urls: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-links-'));
  scratchDirs.push(dir);
  const file = join(dir, 'assessmentAreas.json');
  const body = { controls: controls.map((c) => ({ id: c.id, resources: c.urls.map((url) => ({ title: 't', url, type: 'tool' })) })) };
  writeFileSync(file, JSON.stringify(body));
  return file;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
};

describe('liveness check for control resource links (CG-08)', () => {
  it('CG-08: link check reports a dead link and exits 1', async () => {
    const { fetchImpl, calls } = fakeFetch({ [LIVE]: 200, [GONE]: 404, [SLOW]: abortError() });

    const results = await checkLinks([LIVE, GONE, SLOW], { fetchImpl });
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results.map((r) => r.url)).toEqual([LIVE, GONE, SLOW]);
    expect(results[1].status).toBe(404);
    expect(results[2].status).toBeNull();
    expect(results[2].error).toMatch(/AbortError/);
    for (const { init } of calls) {
      expect(init.redirect).toBe('follow');
      expect(init.credentials).toBe('omit');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }

    // The command: one line per url, exit code 1 while any link is dead.
    const io = sink();
    const file = areasFile([{ id: 'C-01', urls: [LIVE, GONE] }, { id: 'C-02', urls: [SLOW] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [LIVE]: 200, [GONE]: 404, [SLOW]: abortError() }).fetchImpl, ...io })).toBe(1);
    expect(io.out).toEqual([`status=200 url=${LIVE}\n`, `status=404 url=${GONE}\n`, `status=error url=${SLOW}\n`]);
  });

  it('CG-08: link check exits 0 and prints one line per distinct url when every link is alive', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-01', urls: [LIVE] }, { id: 'C-02', urls: [LIVE, GONE] }]);
    const { fetchImpl, calls } = fakeFetch({ [LIVE]: 200, [GONE]: 301 });
    expect(await main([file], { fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`status=200 url=${LIVE}\n`, `status=301 url=${GONE}\n`]);
    expect(calls.filter((c) => c.url === LIVE)).toHaveLength(1); // a url shared by two controls is asked once
  });

  it('CG-08: statuses 200 to 399 are alive and everything else is dead', async () => {
    const statuses = [200, 204, 301, 304, 399, 400, 404, 410, 429, 500, 503];
    const table = Object.fromEntries(statuses.map((s) => [`https://s${s}.example/`, s]));
    const results = await checkLinks(Object.keys(table), { fetchImpl: fakeFetch(table).fetchImpl });
    expect(results.map((r) => [r.status, r.ok])).toEqual(statuses.map((s) => [s, s >= 200 && s <= 399]));
  });

  it('CG-08: link check asks again with GET when HEAD answers 405 or 403, and only then', async () => {
    const A = 'https://head-405.example/';
    const B = 'https://head-403.example/';
    const C = 'https://head-404.example/';
    const { fetchImpl, calls } = fakeFetch(
      { [A]: 200, [B]: 404, [C]: 404 },
      { [A]: { HEAD: 405, GET: 200 }, [B]: { HEAD: 403, GET: 404 }, [C]: { HEAD: 404 } },
    );
    const results = await checkLinks([A, B, C], { fetchImpl });
    expect(results.map((r) => [r.status, r.ok])).toEqual([[200, true], [404, false], [404, false]]);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `HEAD ${A}`, `GET ${A}`, `HEAD ${B}`, `GET ${B}`, `HEAD ${C}`,
    ]);
  });

  it('CG-08 NFR-SEC-11: link check never requests a url that is not https', async () => {
    const bad = ['http://plain.example/', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//no-scheme.example/', 'not a url', ''];
    const { fetchImpl, calls } = fakeFetch({});
    const results = await checkLinks(bad, { fetchImpl });
    expect(calls).toEqual([]);
    expect(results.map((r) => [r.url, r.ok, r.status])).toEqual(bad.map((u) => [u, false, null]));
    for (const r of results) expect(r.error).toMatch(/https/);
  });

  it('CG-08: link check sends no credentials or cookies', async () => {
    const { fetchImpl, calls } = fakeFetch({ [LIVE]: 200 });
    await checkLinks([LIVE], { fetchImpl });
    const names = Object.keys((calls[0].init.headers ?? {}) as Record<string, string>).map((h) => h.toLowerCase());
    expect(calls[0].init.credentials).toBe('omit');
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('authorization');
  });

  it('CG-08: link check stops a request that outlives the timeout and reports it dead', async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const [r] = await checkLinks([SLOW], { fetchImpl: hang, timeoutMs: 20 });
    expect(r).toMatchObject({ url: SLOW, ok: false, status: null });
    expect(r.error).toMatch(/Timeout/i);
  });

  it('CG-08: link check gives each request 15 seconds unless told otherwise', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await checkLinks([LIVE], { fetchImpl: fakeFetch({ [LIVE]: 200 }).fetchImpl });
    await checkLinks([LIVE], { fetchImpl: fakeFetch({ [LIVE]: 200 }).fetchImpl, timeoutMs: 250 });
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([15000, 250]);
  });

  it('CG-08: the command refuses a file that holds no link instead of reporting success', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-01', urls: [] }, { id: 'C-02', urls: [] }]);
    const { fetchImpl, calls } = fakeFetch({});
    expect(await main([file], { fetchImpl, ...io })).toBe(2);
    expect(calls).toEqual([]);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toMatch(/no link/i);
  });

  it('CG-08: the command refuses more than one file instead of checking only the first', async () => {
    const io = sink();
    const a = areasFile([{ id: 'C-01', urls: [LIVE] }]);
    const b = areasFile([{ id: 'C-02', urls: [GONE] }]);
    const { fetchImpl, calls } = fakeFetch({ [LIVE]: 200, [GONE]: 404 });
    expect(await main([a, b], { fetchImpl, ...io })).toBe(2);
    expect(calls).toEqual([]);
    expect(io.err.join('')).toMatch(/usage/i);
  });

  it('CG-08: input that cannot be read as an areas file exits 2, not the exit code of a dead link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-links-'));
    scratchDirs.push(dir);
    const write = (name: string, body: string) => {
      const f = join(dir, name);
      writeFileSync(f, body);
      return f;
    };
    const inputs = {
      missing: join(dir, 'absent.json'),
      'not json': write('bad.json', '{ "controls": ['),
      'no controls list': write('none.json', '{}'),
      'controls is an object': write('obj.json', '{ "controls": {} }'),
      'resources is a string': write('str.json', '{ "controls": [ { "id": "C-01", "resources": "x" } ] }'),
    };
    for (const [what, file] of Object.entries(inputs)) {
      const io = sink();
      const { fetchImpl, calls } = fakeFetch({});
      expect(await main([file], { fetchImpl, ...io }), what).toBe(2);
      expect(calls, what).toEqual([]);
      expect(io.out, what).toEqual([]);
      expect(io.err.join(''), what).toMatch(/cannot read|no controls|not a list/i);
    }
  });

  it('CG-08: a dead line names the controls that list the link', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-01', urls: [GONE] }, { id: 'C-07', urls: [GONE, LIVE] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [LIVE]: 200, [GONE]: 404 }).fetchImpl, ...io })).toBe(1);
    const dead = io.err.filter((l) => l.startsWith('dead:'));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain(GONE);
    expect(dead[0]).toContain('C-01');
    expect(dead[0]).toContain('C-07');
  });

  it('CG-08: a connection failure reports its reason, also when the error carries only a code', async () => {
    const cause = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:443')], ''), { code: 'ECONNREFUSED' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause });
    const [r] = await checkLinks([GONE], { fetchImpl: fakeFetch({ [GONE]: refused }).fetchImpl });
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/fetch failed/);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('CG-08: when no link answered at all the command says the network may be down, and still exits 1', async () => {
    const io = sink();
    const down = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    const file = areasFile([{ id: 'C-01', urls: [LIVE, GONE] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [LIVE]: down, [GONE]: down }).fetchImpl, ...io })).toBe(1);
    expect(io.err.join('')).toMatch(/no link answered/i);

    // One answer of any kind, a 404 included, shows the network works: no such line.
    const io2 = sink();
    expect(await main([file], { fetchImpl: fakeFetch({ [LIVE]: down, [GONE]: 404 }).fetchImpl, ...io2 })).toBe(1);
    expect(io2.err.join('')).not.toMatch(/no link answered/i);
  });

  it('CG-08: the command still runs when started through a symbolic link to the script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-links-'));
    scratchDirs.push(dir);
    const link = join(dir, 'check-links-link.mjs');
    symlinkSync(join(process.cwd(), 'scripts', 'content', 'check-links.mjs'), link);
    const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/usage/i);
  });

  it('CG-08: the command with no file prints how to use it and exits 2', async () => {
    const io = sink();
    expect(await main([], { fetchImpl: fakeFetch({}).fetchImpl, ...io })).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toMatch(/usage/i);

    // The entry point turns that return value into the process exit code.
    const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'content', 'check-links.mjs')], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });
});
