// Checks that the links on the controls still answer (SRS 10.6: "Checked automatically for liveness
// at the freeze. A link that fails is removed.").
//
//   node scripts/content/check-links.mjs <assessmentAreas.json>
//
// Prints one line per distinct url, `status=<n|error> url=<url>`, and exits 1 when any link is dead,
// 2 when it was not given exactly one readable areas file or the file holds no link (a check that
// looked at nothing must not look like a pass), 0 otherwise. A link is alive when its final answer,
// after redirects, is 200 to 399. Detail goes to standard error; standard output holds the lines only.
//
// Built-ins only. It asks each address once, one after another, and keeps no response: a HEAD
// request first, a GET only when the host refuses HEAD (405 or 403), and the body of either is
// dropped unread. It sends no cookie and no credential, and it never requests an address that is
// not https.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'makrai-link-check';

/**
 * @param {string[]} urls
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ url: string, status: number | null, ok: boolean, error?: string }>>}
 */
export async function checkLinks(urls, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = [];
  for (const url of urls) results.push(await checkOne(url, fetchImpl, timeoutMs));
  return results;
}

/**
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 */
async function checkOne(url, fetchImpl, timeoutMs) {
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
    return { url, status: null, ok: false, error: 'not an https address, so it was not requested' };
  }
  try {
    let status = await requestStatus(fetchImpl, url, 'HEAD', timeoutMs);
    if (status === 405 || status === 403) status = await requestStatus(fetchImpl, url, 'GET', timeoutMs);
    return { url, status, ok: status >= 200 && status <= 399 };
  } catch (e) {
    return { url, status: null, ok: false, error: describeError(e) };
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {'HEAD' | 'GET'} method
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function requestStatus(fetchImpl, url, method, timeoutMs) {
  const res = await fetchImpl(url, {
    method,
    redirect: 'follow',
    credentials: 'omit',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel();
  return res.status;
}

/** @param {unknown} e */
function describeError(e) {
  const err = /** @type {{ name?: string, message?: string, cause?: { message?: string, code?: string, errors?: Array<{ message?: string }> } }} */ (e ?? {});
  // Node reports a refused connection to a host with several addresses as an AggregateError with an
  // empty message: its code and its members' messages are then the only reason there is.
  const c = err.cause;
  const why = c?.message || [c?.code, ...(c?.errors ?? []).map((x) => x.message)].filter(Boolean).join(': ');
  return `${err.name ?? 'Error'}: ${err.message ?? String(e)}${why ? ` (${why})` : ''}`;
}

/**
 * @param {string} file
 * @returns {Map<string, string[]>} each distinct url, in first-seen order, with the ids of the controls that list it
 */
function readLinks(file) {
  let areas;
  try {
    areas = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${/** @type {Error} */ (e).message}`);
  }
  if (!Array.isArray(areas?.controls)) throw new Error(`cannot read ${file}: it has no controls list`);
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  for (const c of areas.controls) {
    if (c?.resources !== undefined && !Array.isArray(c.resources)) {
      throw new Error(`cannot read ${file}: resources of control ${c?.id} is not a list`);
    }
    for (const r of c?.resources ?? []) owners.set(r?.url, [...(owners.get(r?.url) ?? []), c.id]);
  }
  return owners;
}

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => void process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => void process.stderr.write(s));
  if (argv.length !== 1) {
    stderr('usage: node scripts/content/check-links.mjs <assessmentAreas.json>\n');
    return 2;
  }
  let owners;
  try {
    owners = readLinks(argv[0]);
  } catch (e) {
    stderr(`${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
  if (owners.size === 0) {
    stderr(`no link found in ${argv[0]}: nothing was checked\n`);
    return 2;
  }
  const results = await checkLinks([...owners.keys()], io);
  for (const r of results) stdout(`status=${r.status ?? 'error'} url=${r.url}\n`);
  const dead = results.filter((r) => !r.ok);
  for (const r of dead) stderr(`dead: ${r.url} [${(owners.get(r.url) ?? []).join(', ')}] (${r.error ?? `status ${r.status}`})\n`);
  stderr(`${results.length} links checked, ${dead.length} dead\n`);
  // Offline, behind a proxy Node ignores, or with DNS down, every link fails the same way and the
  // list of dead links is meaningless: say so before anyone removes a link on its strength.
  if (results.every((r) => r.status === null)) stderr('no link answered at all: check this machine\'s network before removing any link\n');
  return dead.length === 0 ? 0 : 1;
}

// Runs only when started as a script. Both paths are resolved first: Node reports import.meta.url as the
// real path but leaves process.argv[1] as typed, so a link to the script would otherwise run nothing and exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
