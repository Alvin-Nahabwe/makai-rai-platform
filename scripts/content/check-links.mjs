// Checks that the links on the controls still answer (SRS 10.6: "Checked automatically for liveness
// at the freeze. A link that fails is removed.").
//
//   node scripts/content/check-links.mjs <assessmentAreas.json>
//
// Prints one line per distinct url, `status=<n|error> url=<url>` with ` final=<address>` after it when
// the link redirected, or `manual <url> <reason>` for a link left to a person (below). It exits 1 when any
// link is dead, 2 when it was not given exactly one readable areas file or the file holds no link or a
// url that is not a string or holds a control character (a check that looked at nothing must not look
// like a pass), 0 otherwise. Detail goes to standard error; standard output holds those lines only.
// `status=` is the final answer's status, not the verdict: a dead link can print a 2xx there (a bot
// challenge, a listed link that landed on another host). The verdict is the exit code, and the dead
// links are exactly the `dead:` lines on standard error.
//
// A link is alive only when a GET of its final address answers 2xx, except a 202 that is AWS WAF's bot
// challenge (`x-amzn-waf-action: challenge`, no page): a challenge proves nothing exists at the address,
// so it is dead. A link on MANUAL_CHECK is the one exception: when its redirect chain ends on the host its
// entry names and the host refuses a script there (403) or challenges it, it is printed as
// `manual <url> <reason>` and does not fail the run; a person opens it in a browser once before release.
// A listed link that ends on any other host is dead, whatever it answers there. Every other answer from a
// listed link, and every answer from a link not listed, is judged as for any link.
//
// Redirects are followed by hand, at most 5: a 6th, a redirect with no Location, one that does not
// parse, and one to an address that is not https (a downgrade) all make the link dead, and the address
// they point to is never requested.
//
// Built-ins only. It asks each address once, one after another, and keeps no response: each answer's
// body is dropped unread. It sends no cookie and no credential, and it never requests an address that
// is not https.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'makrai-link-check';

/**
 * The only links a refusal is not held against: one entry per exact address, with the reason a script
 * cannot confirm it and the host its redirect chain must end on (as `URL.host` writes it). Both refusals
 * are the host's bot protection, which this check does not try to get round; the owner opens each address
 * in a browser once before release. An address is added here only by a ruling, and a change to this list
 * shows in the test that pins it.
 * @type {Readonly<Record<string, Readonly<{ reason: string, host: string }>>>}
 */
export const MANUAL_CHECK = Object.freeze({
  'https://doi.org/10.1145/3287560.3287596': Object.freeze({ reason: '403 from bot protection', host: 'dl.acm.org' }),
  'https://www.iso.org/standard/81230.html': Object.freeze({ reason: '403 from bot protection', host: 'www.iso.org' }),
  'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689': Object.freeze({ reason: '202 with x-amzn-waf-action: challenge', host: 'eur-lex.europa.eu' }),
  'https://eur-lex.europa.eu/eli/reg/2016/679/oj': Object.freeze({ reason: '202 with x-amzn-waf-action: challenge', host: 'eur-lex.europa.eu' }),
});

/** The header value AWS WAF sets on the answer that is a challenge instead of the page. */
const WAF_CHALLENGE = 'challenge';

/**
 * @param {string[]} urls
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ url: string, finalUrl: string, status: number | null, ok: boolean, error?: string, manual?: string }>>}
 *   `finalUrl` is the last address asked: `url` itself unless the link redirected. `manual` is the reason
 *   from MANUAL_CHECK when the link is listed, its final address is on the entry's host, and its final
 *   answer there was a 403 or a 202 WAF challenge (either kind, for any entry); `ok` stays false for it,
 *   so a caller that does not read `manual` fails closed.
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
    return { url, finalUrl: url, status: null, ok: false, error: 'not an https address, so it was not requested' };
  }
  let current = url;
  /** @param {string} error */
  const broken = (error) => ({ url, finalUrl: current, status: null, ok: false, error });
  try {
    for (let redirects = 0; ; redirects++) {
      const { status, location, wafAction } = await requestOnce(fetchImpl, current, timeoutMs);
      if (status < 300 || status > 399) {
        const entry = Object.hasOwn(MANUAL_CHECK, url) ? MANUAL_CHECK[url] : undefined;
        const landed = new URL(current).host;
        if (entry && landed !== entry.host) {
          return { url, finalUrl: current, status, ok: false, error: `status ${status} on ${landed}, but MANUAL_CHECK expects this link to land on ${entry.host}` };
        }
        if (entry && (status === 403 || isChallenge(status, wafAction))) return { url, finalUrl: current, status, ok: false, manual: entry.reason };
        if (isChallenge(status, wafAction)) {
          return { url, finalUrl: current, status, ok: false, error: `status ${status} with x-amzn-waf-action: ${wafAction}, a bot challenge: no page was served` };
        }
        return { url, finalUrl: current, status, ok: status >= 200 && status <= 299 };
      }
      if (!location) return { ...broken(`status ${status} without a Location header`), status };
      if (redirects === MAX_REDIRECTS) return broken(`more than ${MAX_REDIRECTS} redirects`);
      if (!URL.canParse(location, current)) return broken(`redirect to an address that does not parse: ${location}`);
      const next = new URL(location, current);
      if (next.protocol !== 'https:') return broken(`redirect to ${next.href}, which is not https, so it was not requested`);
      current = next.href;
    }
  } catch (e) {
    return broken(describeError(e));
  }
}

/**
 * Whether an answer is AWS WAF's bot challenge: a 202 with `x-amzn-waf-action: challenge` (any case). A
 * header sent more than once reaches here joined by commas (`Headers.get`), so any member counts.
 * @param {number} status
 * @param {string | null} wafAction
 */
function isChallenge(status, wafAction) {
  return status === 202 && wafAction !== null && wafAction.split(',').some((v) => v.trim().toLowerCase() === WAF_CHALLENGE);
}

/**
 * One GET that does not follow redirects. Only the status, Location and WAF header are kept; the body is dropped unread.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, location: string | null, wafAction: string | null }>}
 */
async function requestOnce(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel();
  return { status: res.status, location: res.headers.get('location'), wafAction: res.headers.get('x-amzn-waf-action') };
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
    for (const r of c?.resources ?? []) {
      // A url that is not a string would be matched against MANUAL_CHECK by coercion, and a control character
      // in one would let it forge a line of this command's own output.
      if (typeof r?.url !== 'string') throw new Error(`cannot read ${file}: a resource url of control ${c?.id} is not a string`);
      if (/[\u0000-\u001f\u007f]/.test(r.url)) throw new Error(`cannot read ${file}: a resource url of control ${c?.id} holds a control character`);
      owners.set(r.url, [...(owners.get(r.url) ?? []), c.id]);
    }
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
  for (const r of results) {
    stdout(r.manual ? `manual ${r.url} ${r.manual}\n` : `status=${r.status ?? 'error'} url=${r.url}${r.finalUrl === r.url ? '' : ` final=${r.finalUrl}`}\n`);
  }
  const manual = results.filter((r) => r.manual);
  const dead = results.filter((r) => !r.ok && !r.manual);
  const at = (/** @type {{ url: string, finalUrl: string }} */ r) => (r.finalUrl === r.url ? '' : `, at ${r.finalUrl}`);
  for (const r of manual) stderr(`manual: ${r.url} [${(owners.get(r.url) ?? []).join(', ')}] (status ${r.status}${at(r)}, ${r.manual})\n`);
  for (const r of dead) stderr(`dead: ${r.url} [${(owners.get(r.url) ?? []).join(', ')}] (${r.error ?? `status ${r.status}`}${at(r)})\n`);
  stderr(`${results.length} links checked, ${dead.length} dead, ${manual.length} to open by hand\n`);
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
