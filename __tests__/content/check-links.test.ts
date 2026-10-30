// The liveness check for control resource links (scripts/content/check-links.mjs).
//
// SRS 10.6: "Resource links: Checked automatically for liveness at the freeze. A link that fails is
// removed." A link is alive when a GET of its final address answers 2xx. Redirects are followed by
// hand: at most 5, every hop https, a 3xx without a Location is broken.
//
// Nothing here touches the network: every case injects its own `fetchImpl`, except the ones that run
// the command with no argument, which fail before they read a file.
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
/** An answer: a status, an Error to throw, or a redirect (a status with a Location header, or with none). */
type Answer = number | Error | { status: number; location?: string };

/** A fetch that answers from a table keyed by the exact address asked, and records every call. */
function fakeFetch(table: Record<string, Answer>, byMethod: Record<string, Record<string, Answer>> = {}) {
  const calls: Call[] = [];
  const state = { cancelled: 0 };
  const body = { cancel: async () => void state.cancelled++ };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const answer: unknown = byMethod[url]?.[init?.method ?? 'GET'] ?? table[url];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return { status: answer, headers: new Headers(), body } as unknown as Response;
    if (answer && typeof answer === 'object') {
      const { status, location } = answer as { status: number; location?: string };
      return { status, headers: new Headers(location === undefined ? {} : { location }), body } as unknown as Response;
    }
    throw new Error(`the fake has no answer for ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const redirect = (location: string, status = 301): Answer => ({ status, location });
/** `https://chain.example/0` redirects to `/1` ... the last one answers 200: `redirects` redirects in all. */
function chain(redirects: number) {
  const at = (i: number) => `https://chain.example/${i}`;
  const table: Record<string, Answer> = {};
  for (let i = 0; i < redirects; i++) table[at(i)] = redirect(at(i + 1));
  table[at(redirects)] = 200;
  return { start: at(0), end: at(redirects), table };
}

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-links-'));
  scratchDirs.push(dir);
  return dir;
}
function areasFile(controls: Array<{ id: string; urls: string[] }>): string {
  const file = join(scratch(), 'assessmentAreas.json');
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
      expect(init.redirect).toBe('manual');
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
    const { fetchImpl, calls } = fakeFetch({ [LIVE]: 200, [GONE]: 204 });
    expect(await main([file], { fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`status=200 url=${LIVE}\n`, `status=204 url=${GONE}\n`]);
    expect(calls.filter((c) => c.url === LIVE)).toHaveLength(1); // a url shared by two controls is asked once
  });

  it('CG-08: only a 2xx answer is alive; 4xx, 5xx and a 3xx with no Location are dead', async () => {
    const answers: Array<[number, boolean]> = [[200, true], [204, true], [299, true], [300, false], [301, false], [304, false], [399, false], [400, false], [404, false], [410, false], [429, false], [500, false], [503, false]];
    const table = Object.fromEntries(answers.map(([s]) => [`https://s${s}.example/`, s]));
    const results = await checkLinks(Object.keys(table), { fetchImpl: fakeFetch(table).fetchImpl });
    expect(results.map((r) => r.ok)).toEqual(answers.map(([, alive]) => alive));
    expect(results.filter((r) => r.status === null)).toEqual([]); // a 3xx with no Location carries its status
    for (const r of results.filter((x) => x.status !== null && x.status >= 300 && x.status < 400)) expect(r.error, String(r.status)).toMatch(/Location/);
  });

  it('CG-08: a link is judged by a GET: a host that answers HEAD 200 and GET 404 is dead, and no HEAD is sent', async () => {
    const { fetchImpl, calls } = fakeFetch({ [GONE]: 404 }, { [GONE]: { HEAD: 200, GET: 404 } });
    const [r] = await checkLinks([GONE], { fetchImpl });
    expect(r).toMatchObject({ url: GONE, ok: false, status: 404 });
    expect(calls.map((c) => c.init.method)).toEqual(['GET']);
  });

  it('CG-08: link check follows redirects by hand, resolves a relative Location and reports the final address', async () => {
    const OLD = 'https://old.example/doc';
    const MID = 'https://mid.example/docs/';
    const END = 'https://mid.example/docs/intro';
    const { fetchImpl, calls } = fakeFetch({ [OLD]: redirect(MID), [MID]: redirect('/docs/intro', 302), [END]: 200 });
    const [r] = await checkLinks([OLD], { fetchImpl });
    expect(r).toMatchObject({ url: OLD, finalUrl: END, status: 200, ok: true });
    expect(calls.map((c) => c.url)).toEqual([OLD, MID, END]);
  });

  it('CG-08: the command prints the final address of a redirected link after its url', async () => {
    const OLD = 'https://old.example/doc';
    const NEW = 'https://new.example/doc';
    const io = sink();
    const file = areasFile([{ id: 'C-05', urls: [OLD, LIVE] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [OLD]: redirect(NEW), [NEW]: 200, [LIVE]: 200 }).fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`status=200 url=${OLD} final=${NEW}\n`, `status=200 url=${LIVE}\n`]);
  });

  it('CG-08: at most 5 redirects are followed; a 6th is broken', async () => {
    const ok5 = chain(5);
    const [alive] = await checkLinks([ok5.start], { fetchImpl: fakeFetch(ok5.table).fetchImpl });
    expect(alive).toMatchObject({ ok: true, status: 200, finalUrl: ok5.end });

    const bad6 = chain(6);
    const { fetchImpl, calls } = fakeFetch(bad6.table);
    const [dead] = await checkLinks([bad6.start], { fetchImpl });
    expect(dead).toMatchObject({ ok: false, status: null });
    expect(dead.error).toMatch(/redirect/i);
    expect(calls).toHaveLength(6); // the 6th redirect is not followed
    expect(calls.map((c) => c.url)).not.toContain(bad6.end);
  });

  it('CG-08: a redirect loop ends as dead after the cap instead of running on', async () => {
    const LOOP = 'https://loop.example/';
    const { fetchImpl, calls } = fakeFetch({ [LOOP]: redirect(LOOP) });
    const [r] = await checkLinks([LOOP], { fetchImpl });
    expect(r).toMatchObject({ ok: false, status: null });
    expect(calls).toHaveLength(6);
  });

  it('CG-08 NFR-SEC-11: a redirect to an address that is not https is broken and is never requested', async () => {
    for (const target of ['http://plain.example/landed', 'ftp://files.example/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      const { fetchImpl, calls } = fakeFetch({ [LIVE]: redirect(target) });
      const [r] = await checkLinks([LIVE], { fetchImpl });
      expect(r, target).toMatchObject({ url: LIVE, finalUrl: LIVE, ok: false, status: null });
      expect(r.error, target).toMatch(/https/);
      expect(calls.map((c) => c.url), target).toEqual([LIVE]);
    }
  });

  it('CG-08: a redirect with no Location, or one that does not parse, is broken', async () => {
    const table: Record<string, Answer> = {
      'https://no-location.example/': { status: 302 },
      'https://empty-location.example/': { status: 302, location: '' },
      'https://bad-location.example/': { status: 302, location: 'https://[not-an-address' },
    };
    const results = await checkLinks(Object.keys(table), { fetchImpl: fakeFetch(table).fetchImpl });
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(results[0].error).toMatch(/Location/);
    expect(results[1].error).toMatch(/Location/);
    expect(results[2].error).toMatch(/parse|address/i);
  });

  it('CG-08: a dead link behind a redirect reports where it stopped', async () => {
    const OLD = 'https://old.example/doc';
    const NEW = 'https://new.example/doc';
    const [r] = await checkLinks([OLD], { fetchImpl: fakeFetch({ [OLD]: redirect(NEW), [NEW]: 404 }).fetchImpl });
    expect(r).toMatchObject({ url: OLD, finalUrl: NEW, status: 404, ok: false });

    const io = sink();
    const file = areasFile([{ id: 'C-06', urls: [OLD] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [OLD]: redirect(NEW), [NEW]: 404 }).fetchImpl, ...io })).toBe(1);
    expect(io.out).toEqual([`status=404 url=${OLD} final=${NEW}\n`]);
    expect(io.err.filter((l) => l.startsWith('dead:'))[0]).toContain(NEW);
  });

  it('CG-08 NFR-SEC-11: link check never requests a url that is not https', async () => {
    const bad = ['http://plain.example/', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//no-scheme.example/', 'not a url', ''];
    const { fetchImpl, calls } = fakeFetch({});
    const results = await checkLinks(bad, { fetchImpl });
    expect(calls).toEqual([]);
    expect(results.map((r) => [r.url, r.ok, r.status])).toEqual(bad.map((u) => [u, false, null]));
    for (const r of results) expect(r.error).toMatch(/https/);
  });

  it('CG-08: link check sends no credentials or cookies, on every hop', async () => {
    const { start, table } = chain(2);
    const { fetchImpl, calls } = fakeFetch(table);
    await checkLinks([start], { fetchImpl });
    expect(calls).toHaveLength(3);
    for (const { init } of calls) {
      const names = Object.keys((init.headers ?? {}) as Record<string, string>).map((h) => h.toLowerCase());
      expect(init.credentials).toBe('omit');
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('authorization');
    }
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

  it('CG-08: link check drops the body of every answer unread', async () => {
    const { start, table } = chain(2);
    const { fetchImpl, calls, state } = fakeFetch({ ...table, [GONE]: 404 });
    await checkLinks([start, GONE], { fetchImpl });
    expect(calls).toHaveLength(4);
    expect(state.cancelled).toBe(4);
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
    const dir = scratch();
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
    const link = join(scratch(), 'check-links-link.mjs');
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
