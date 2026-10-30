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
import { checkLinks, main, MANUAL_CHECK } from '../../scripts/content/check-links.mjs';

const LIVE = 'https://live.example/a';
const GONE = 'https://gone.example/b';
const SLOW = 'https://slow.example/c';
// The four addresses MANUAL_CHECK lists (a person opens each once before release).
const ISO = 'https://www.iso.org/standard/81230.html'; // 403 from bot protection
const DOI = 'https://doi.org/10.1145/3287560.3287596'; // redirects to dl.acm.org, which answers 403 to a script
const AI_ACT = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689'; // 202 with a WAF challenge
const GDPR = 'https://eur-lex.europa.eu/eli/reg/2016/679/oj'; // 202 with a WAF challenge

type Call = { url: string; init: RequestInit };
/** An answer: a status, an Error to throw, or a redirect (a status with a Location header, or with none). */
type Answer = number | Error | { status: number; location?: string; headers?: Record<string, string> };

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
      const { status, location, headers } = answer as { status: number; location?: string; headers?: Record<string, string> };
      const all = { ...(location === undefined ? {} : { location }), ...headers };
      return { status, headers: new Headers(all), body } as unknown as Response;
    }
    throw new Error(`the fake has no answer for ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const redirect = (location: string, status = 301): Answer => ({ status, location });
/** The answer EUR-Lex gives a script: 202, no body, and the AWS WAF header that says a challenge was served. */
const waf = (): Answer => ({ status: 202, headers: { 'x-amzn-waf-action': 'challenge' } });
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

  it('CG-08 FR-PUB-03: a listed link that answers 403 is printed as manual and does not fail the run', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-26', urls: [ISO] }, { id: 'C-01', urls: [LIVE] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [ISO]: 403, [LIVE]: 200 }).fetchImpl, ...io })).toBe(0);
    expect(MANUAL_CHECK[ISO].reason).toMatch(/\S/);
    expect(io.out).toEqual([`manual ${ISO} ${MANUAL_CHECK[ISO].reason}\n`, `status=200 url=${LIVE}\n`]);
    expect(io.err.filter((l) => l.startsWith('dead:'))).toEqual([]);
    expect(io.err.join('')).toMatch(/2 links checked, 0 dead, 1 to open by hand/);
  });

  it('CG-08: an unlisted link that answers 403 is dead and fails the run, also on the host or path of a listed one', async () => {
    const lookalikes = [GONE, 'https://www.iso.org/standard/99999.html', `${ISO}?x=1`, `${ISO}#top`];
    for (const url of lookalikes) {
      const io = sink();
      const file = areasFile([{ id: 'C-26', urls: [url] }]);
      expect(await main([file], { fetchImpl: fakeFetch({ [url]: 403 }).fetchImpl, ...io }), url).toBe(1);
      expect(io.out, url).toEqual([`status=403 url=${url}\n`]);
      expect(io.err.filter((l) => l.startsWith('dead:')), url).toHaveLength(1);
    }
  });

  it('CG-08: a listed link that answers anything other than 403 or a WAF challenge, 404 included, is dead', async () => {
    for (const status of [400, 401, 404, 410, 429, 500, 503]) {
      const io = sink();
      const file = areasFile([{ id: 'C-26', urls: [ISO] }]);
      expect(await main([file], { fetchImpl: fakeFetch({ [ISO]: status }).fetchImpl, ...io }), String(status)).toBe(1);
      expect(io.out, String(status)).toEqual([`status=${status} url=${ISO}\n`]);
    }
  });

  it('CG-08: a listed link that fails to connect or times out is dead, not manual', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    for (const answer of [abortError(), refused]) {
      const io = sink();
      const file = areasFile([{ id: 'C-26', urls: [ISO] }]);
      expect(await main([file], { fetchImpl: fakeFetch({ [ISO]: answer }).fetchImpl, ...io })).toBe(1);
      expect(io.out).toEqual([`status=error url=${ISO}\n`]);
    }
  });

  it('CG-08 FR-PUB-03: a listed EUR-Lex link behind a WAF challenge (202 and x-amzn-waf-action: challenge) is manual', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-02', urls: [AI_ACT] }, { id: 'C-11', urls: [GDPR] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [AI_ACT]: waf(), [GDPR]: waf() }).fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`manual ${AI_ACT} ${MANUAL_CHECK[AI_ACT].reason}\n`, `manual ${GDPR} ${MANUAL_CHECK[GDPR].reason}\n`]);
    expect(io.err.join('')).toMatch(/2 links checked, 0 dead, 2 to open by hand/);
  });

  it('CG-08: a listed link that is served normally is confirmed, not manual: a 200, or a 202 without the WAF header', async () => {
    const io = sink();
    const file = areasFile([{ id: 'C-26', urls: [ISO] }, { id: 'C-02', urls: [AI_ACT] }, { id: 'C-11', urls: [GDPR] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [ISO]: 200, [AI_ACT]: 200, [GDPR]: 202 }).fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`status=200 url=${ISO}\n`, `status=200 url=${AI_ACT}\n`, `status=202 url=${GDPR}\n`]);
    expect(io.err.join('')).toMatch(/3 links checked, 0 dead, 0 to open by hand/);
  });

  it('CG-08 FR-PUB-03: a listed link that redirects to a page answering 403 is manual (the DOI to dl.acm.org case)', async () => {
    const acm = 'https://dl.acm.org/doi/10.1145/3287560.3287596';
    const io = sink();
    const file = areasFile([{ id: 'C-17', urls: [DOI] }]);
    const { fetchImpl, calls } = fakeFetch({ [DOI]: redirect(acm), [acm]: 403 });
    expect(await main([file], { fetchImpl, ...io })).toBe(0);
    expect(io.out).toEqual([`manual ${DOI} ${MANUAL_CHECK[DOI].reason}\n`]);
    expect(calls.map((c) => c.url)).toEqual([DOI, acm]); // the redirect is still followed and asked

    // The same redirect ending in a 404 is dead.
    const io2 = sink();
    expect(await main([file], { fetchImpl: fakeFetch({ [DOI]: redirect(acm), [acm]: 404 }).fetchImpl, ...io2 })).toBe(1);
    expect(io2.out).toEqual([`status=404 url=${DOI} final=${acm}\n`]);
  });

  it('CG-08: checkLinks marks a manual link with its reason and keeps it not-ok, so a caller that ignores the mark fails closed', async () => {
    const [manual, dead] = await checkLinks([ISO, GONE], { fetchImpl: fakeFetch({ [ISO]: 403, [GONE]: 403 }).fetchImpl });
    expect(manual).toMatchObject({ url: ISO, status: 403, ok: false, manual: MANUAL_CHECK[ISO].reason });
    expect(dead).toMatchObject({ url: GONE, status: 403, ok: false });
    expect(dead).not.toHaveProperty('manual');
  });

  it('CG-08 FR-PUB-03: MANUAL_CHECK holds exactly the two links bot protection refuses and the two EUR-Lex addresses, each an https url with a reason and its landing host', () => {
    expect(MANUAL_CHECK).toEqual({
      [DOI]: { reason: '403 from bot protection', host: 'dl.acm.org' },
      [ISO]: { reason: '403 from bot protection', host: 'www.iso.org' },
      [AI_ACT]: { reason: '202 with x-amzn-waf-action: challenge', host: 'eur-lex.europa.eu' },
      [GDPR]: { reason: '202 with x-amzn-waf-action: challenge', host: 'eur-lex.europa.eu' },
    });
    for (const [url, entry] of Object.entries(MANUAL_CHECK)) {
      expect(URL.canParse(url) && new URL(url).protocol, url).toBe('https:');
      expect(typeof entry.reason === 'string' && entry.reason.trim().length > 0, url).toBe(true);
      // A host as URL writes it: no scheme, path, port or upper case, so the comparison with a landing address is exact.
      expect(new URL(`https://${entry.host}/`).host, url).toBe(entry.host);
      expect(Object.isFrozen(entry), url).toBe(true);
    }
  });

  it('CG-08: a listed link behind a WAF challenge is manual whatever the case of the header value', async () => {
    for (const value of ['challenge', 'Challenge', 'CHALLENGE']) {
      const [r] = await checkLinks([GDPR], { fetchImpl: fakeFetch({ [GDPR]: { status: 202, headers: { 'x-amzn-waf-action': value } } }).fetchImpl });
      expect(r, value).toMatchObject({ ok: false, status: 202, manual: MANUAL_CHECK[GDPR].reason });
    }
  });

  it('CG-08: a 202 bot challenge from a link that is not listed is dead and fails the run, whatever the case of the header value', async () => {
    // A challenge proves nothing exists at the address. A one-character edit to a listed EUR-Lex address
    // leaves the list, and the host still answers the challenge for any path.
    const edited = `${AI_ACT}&from=EN`;
    // `Headers.get` joins a field sent twice with ", ", so the doubled header still names the challenge.
    for (const value of ['challenge', 'Challenge', 'challenge, challenge']) {
      const io = sink();
      const file = areasFile([{ id: 'C-02', urls: [edited] }]);
      const answer: Answer = { status: 202, headers: { 'x-amzn-waf-action': value } };
      expect(await main([file], { fetchImpl: fakeFetch({ [edited]: answer }).fetchImpl, ...io }), value).toBe(1);
      expect(io.out, value).toEqual([`status=202 url=${edited}\n`]);
      const dead = io.err.filter((l) => l.startsWith('dead:'));
      expect(dead, value).toHaveLength(1);
      expect(dead[0], value).toContain(edited);
      expect(dead[0], value).toContain('C-02');
      expect(dead[0], value).toMatch(/x-amzn-waf-action/);
      expect(io.err.filter((l) => l.startsWith('warning:')), value).toEqual([]);
      const [r] = await checkLinks([edited], { fetchImpl: fakeFetch({ [edited]: answer }).fetchImpl });
      expect(r, value).toMatchObject({ url: edited, status: 202, ok: false });
      expect(r, value).not.toHaveProperty('manual');
    }

    // A 202 without the header and a plain 200 stay alive; a listed link behind the challenge stays manual.
    const quiet = sink();
    const file2 = areasFile([{ id: 'C-01', urls: [LIVE, GONE] }, { id: 'C-11', urls: [GDPR] }]);
    expect(await main([file2], { fetchImpl: fakeFetch({ [LIVE]: 200, [GONE]: 202, [GDPR]: waf() }).fetchImpl, ...quiet })).toBe(0);
    expect(quiet.out).toEqual([`status=200 url=${LIVE}\n`, `status=202 url=${GONE}\n`, `manual ${GDPR} ${MANUAL_CHECK[GDPR].reason}\n`]);
    expect(quiet.err.join('')).toMatch(/3 links checked, 0 dead, 1 to open by hand/);
  });

  it('CG-08: a listed link whose redirect chain ends on another host than its entry names is dead, whatever it answers there', async () => {
    const elsewhere = 'https://parked.example/doi/10.1145/3287560.3287596';
    const answers: Array<[string, Answer]> = [['403', 403], ['a WAF challenge', waf()], ['200', 200], ['202', 202]];
    for (const [what, answer] of answers) {
      const io = sink();
      const file = areasFile([{ id: 'C-17', urls: [DOI] }]);
      expect(await main([file], { fetchImpl: fakeFetch({ [DOI]: redirect(elsewhere), [elsewhere]: answer }).fetchImpl, ...io }), what).toBe(1);
      expect(io.out[0], what).toMatch(new RegExp(`^status=\\d+ url=${DOI.replace(/[.?/]/g, '\\$&')} final=${elsewhere.replace(/[.?/]/g, '\\$&')}\\n$`));
      const dead = io.err.filter((l) => l.startsWith('dead:'));
      expect(dead, what).toHaveLength(1);
      expect(dead[0], what).toContain('parked.example');
      expect(dead[0], what).toContain(MANUAL_CHECK[DOI].host);
      expect(io.err.filter((l) => l.startsWith('manual:')), what).toEqual([]);
    }

    // The same rule with no redirect at all: the DOI answering 403 on doi.org itself did not land on dl.acm.org.
    const [direct] = await checkLinks([DOI], { fetchImpl: fakeFetch({ [DOI]: 403 }).fetchImpl });
    expect(direct).toMatchObject({ url: DOI, finalUrl: DOI, status: 403, ok: false });
    expect(direct).not.toHaveProperty('manual');
    expect(direct.error).toMatch(/dl\.acm\.org/);

    // A host that differs only by its www prefix is another host.
    const bare = 'https://iso.org/standard/81230.html';
    const [moved] = await checkLinks([ISO], { fetchImpl: fakeFetch({ [ISO]: redirect(bare), [bare]: 200 }).fetchImpl });
    expect(moved).toMatchObject({ url: ISO, finalUrl: bare, status: 200, ok: false });
    expect(moved.error).toMatch(/www\.iso\.org/);

    // The comparison is of the whole host, port included: a host that holds, ends with or extends the
    // expected one is another host. Upper case and the default port are the same host, as URL writes it.
    const others = ['https://dl.acm.org.evil.example/doi/x', 'https://xdl.acm.org/doi/x', 'https://sub.dl.acm.org/doi/x', 'https://dl.acm.org:8443/doi/x', 'https://dl.acm.org./doi/x'];
    for (const landing of others) {
      const [r] = await checkLinks([DOI], { fetchImpl: fakeFetch({ [DOI]: redirect(landing), [landing]: 403 }).fetchImpl });
      expect(r, landing).toMatchObject({ ok: false, status: 403 });
      expect(r, landing).not.toHaveProperty('manual');
    }
    for (const same of ['https://DL.ACM.ORG/doi/x', 'https://dl.acm.org:443/doi/x']) {
      const landing = new URL(same).href; // the address the check asks after resolving the Location
      const [r] = await checkLinks([DOI], { fetchImpl: fakeFetch({ [DOI]: redirect(same), [landing]: 403 }).fetchImpl });
      expect(r, same).toMatchObject({ ok: false, status: 403, manual: MANUAL_CHECK[DOI].reason });
    }
  });

  it('CG-08: an unlisted link is judged by its own address, also when it redirects into a listed one or to a challenge', async () => {
    // The list is keyed by the address in the file: an unlisted address that reaches a listed one is not listed.
    const eliVariant = `${GDPR}/eng`;
    const isoVariant = 'https://www.iso.org/standard/81230';
    const table: Record<string, Answer> = { [eliVariant]: redirect(GDPR, 302), [GDPR]: waf(), [isoVariant]: redirect(ISO), [ISO]: 403 };
    const results = await checkLinks([eliVariant, isoVariant], { fetchImpl: fakeFetch(table).fetchImpl });
    expect(results.map((r) => [r.url, r.finalUrl, r.status, r.ok])).toEqual([
      [eliVariant, GDPR, 202, false],
      [isoVariant, ISO, 403, false],
    ]);
    for (const r of results) expect(r, r.url).not.toHaveProperty('manual');

    // An unlisted link that redirects to a challenge is dead, as one that is challenged at its own address.
    const start = 'https://data.europa.eu/eli/reg/2016/679/oj';
    const page = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679';
    const io = sink();
    const file = areasFile([{ id: 'C-11', urls: [start] }]);
    expect(await main([file], { fetchImpl: fakeFetch({ [start]: redirect(page, 303), [page]: waf() }).fetchImpl, ...io })).toBe(1);
    expect(io.out).toEqual([`status=202 url=${start} final=${page}\n`]);
    const dead = io.err.filter((l) => l.startsWith('dead:'));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain('C-11');
    expect(dead[0]).toMatch(/x-amzn-waf-action/);
  });

  it('CG-08: a listed link that lands on the host its entry names is judged as before: 403 or a challenge is manual, 2xx alive', async () => {
    const acm = 'https://dl.acm.org/doi/10.1145/3287560.3287596';
    const page = 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689';
    const table: Record<string, Answer> = { [DOI]: redirect(acm), [acm]: 403, [AI_ACT]: redirect(page, 302), [page]: waf(), [ISO]: 200 };
    const results = await checkLinks([DOI, AI_ACT, ISO], { fetchImpl: fakeFetch(table).fetchImpl });
    expect(results.map((r) => [r.url, r.ok, r.manual ?? null])).toEqual([
      [DOI, false, MANUAL_CHECK[DOI].reason],
      [AI_ACT, false, MANUAL_CHECK[AI_ACT].reason],
      [ISO, true, null],
    ]);
  });

  it('CG-08: the manual line on standard error names the controls and the address a redirect ended at', async () => {
    const acm = 'https://dl.acm.org/doi/10.1145/3287560.3287596';
    const io = sink();
    const file = areasFile([{ id: 'C-17', urls: [DOI] }, { id: 'C-26', urls: [ISO] }]);
    const answers = { [DOI]: redirect(acm), [acm]: 403, [ISO]: 403 };
    expect(await main([file], { fetchImpl: fakeFetch(answers).fetchImpl, ...io })).toBe(0);
    const lines = io.err.filter((l) => l.startsWith('manual:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[C-17]');
    expect(lines[0]).toContain(`at ${acm}`);
    expect(lines[1]).toContain('[C-26]');
    expect(lines[1]).not.toContain(' at ');
    expect(io.out[0]).toBe(`manual ${DOI} ${MANUAL_CHECK[DOI].reason}\n`); // standard output keeps the ruled format
  });

  it('CG-08 NFR-SEC-11: a resource url that is not a string, or holds a control character, is bad input (exit 2), not a link', async () => {
    const bad: Array<[string, unknown]> = [
      ['an array holding a listed address', [ISO]],
      ['a number', 7],
      ['a missing url', undefined],
      ['a newline that could forge an output line', `${GONE}\nmanual ${GONE} 403 from bot protection`],
      ['a tab', `${GONE}\t`],
    ];
    for (const [what, url] of bad) {
      const file = join(scratch(), 'assessmentAreas.json');
      writeFileSync(file, JSON.stringify({ controls: [{ id: 'C-26', resources: [{ title: 't', url, type: 'tool' }] }] }));
      const io = sink();
      const { fetchImpl, calls } = fakeFetch({ [ISO]: 403, [GONE]: 404 });
      expect(await main([file], { fetchImpl, ...io }), what).toBe(2);
      expect(calls, what).toEqual([]);
      expect(io.out, what).toEqual([]);
      expect(io.err.join(''), what).toMatch(/not a string|control character/i);
    }
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
