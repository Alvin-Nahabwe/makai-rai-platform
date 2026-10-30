import { type CONTENT_BUNDLE_FILES, hashBundleFiles } from '@/lib/content/bundleHash';
import { readContentBytes, readContentIndex, runningSemver } from '@/lib/content/root';
import { SEMVER_RE } from '@/lib/content/semver';
import { AppError } from '@/lib/http/errors';
import type {
  ContentArea, ContentControl, ContentModule, ContentQuestion, ContentSemver, DocumentHelpFile, LoadedContent,
  LoadedQuestion, ReasonCodeEntry,
} from '@/types/content';
import type { ScopeAnswer, Stage } from '@/types/record';

/**
 * Load a content version and look up its questions, areas, controls and reason codes (FR-CNT-01 to 04, 06, 07).
 *
 * The only way a version's files reach the product. Bytes come from `lib/content/root` and nowhere else, so the
 * build trace stays literal and a test can swap in the fixture bundle (contract "Static read paths"). Nothing
 * here touches the file system or builds a path: the version name is checked first, and `root` checks the
 * file name again.
 */

type BundleFile = (typeof CONTENT_BUNDLE_FILES)[number];
type Read = (file: BundleFile) => Uint8Array;
type Json = Record<string, unknown>;

/** Stage order of the question bank (7.1.6): a stage's questions are numbered from 0 in this walk. */
const STAGES: readonly Stage[] = ['pre-processing', 'in-processing', 'post-processing'];
/** The one value a condition may carry (contract, loader row): the question applies unless the gate answer is "no". */
const CONDITION_VALUE = 'yes' as const satisfies ScopeAnswer;
const REASON_STATUSES = ['not_applicable', 'not_yet'] as const satisfies readonly ReasonCodeEntry['status'][];

const cache = new Map<ContentSemver, LoadedContent>();

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Freezes plain objects, lists and the objects held in maps, all the way down, so one caller cannot change what
 * every request reads. A frozen `Map` still accepts `set`; the maps are typed `ReadonlyMap`, which stops that.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of value instanceof Map ? value.values() : Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * Builds the loaded form of a version from a reader of its five hashed files. Pure: it reads nothing but
 * through `read`, each file at most once, so the hash describes the very bytes that were parsed. The loader
 * calls it with the content root's reader; the content check (`lib/content/validate.ts`, scripts and tests
 * only) calls it over any directory, so there is one parser of a version.
 *
 * It checks the structure the product relies on and nothing about wording: text that is not UTF-8 or not JSON,
 * a file of the wrong shape, a stage missing or extra, a repeated or missing id, a reason code with an
 * unknown status, and a question whose condition has a value other than "yes" or does not name a gate question all throw,
 * naming the version and the file. A version that cannot be read whole is a defect of the deployment, never
 * something to serve in part, and a failed build is not cached. The rules about content (lengths, sign-offs,
 * `meta.version`, which control an area lists) are the content check's, not the loader's.
 *
 * The result is frozen, because it is shared by every request of the process.
 */
export function buildLoadedContent(semver: ContentSemver, read: Read): LoadedContent {
  const fail = (what: string, cause?: unknown): never => {
    throw new Error(`content ${semver}: ${what}`, cause === undefined ? undefined : { cause });
  };
  const bytes = new Map<BundleFile, Uint8Array>();
  const once: Read = (file) => {
    let b = bytes.get(file);
    if (b === undefined) {
      b = read(file);
      bytes.set(file, b);
    }
    return b;
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parse = (file: BundleFile): unknown => {
    const raw = once(file);
    try {
      return JSON.parse(decoder.decode(raw));
    } catch (e) {
      return fail(`${file} is not valid UTF-8 JSON`, e);
    }
  };
  const record = (v: unknown, where: string): Json => (isRecord(v) ? v : fail(`${where} is not an object`));
  const list = (v: unknown, where: string): unknown[] => (Array.isArray(v) ? v : fail(`${where} is not a list`));
  const idOf = (item: Json, where: string): string =>
    typeof item.id === 'string' && item.id !== '' ? item.id : fail(`${where} has no id`);
  const byId = <T>(items: readonly unknown[], where: string): Map<string, T> => {
    const out = new Map<string, T>();
    for (const item of items) {
      const id = idOf(record(item, where), where);
      if (out.has(id)) fail(`${where} id ${id} appears twice`);
      out.set(id, item as T);
    }
    return out;
  };

  const contentHash = hashBundleFiles(once);

  const stages = record(record(parse('questionBank.json'), 'questionBank.json').stages, 'questionBank.json stages');
  for (const key of Object.keys(stages)) if (!STAGES.includes(key as Stage)) fail(`questionBank.json has an unknown stage ${key}`);
  const questions: LoadedQuestion[] = [];
  const moduleIds = new Set<string>();
  for (const stage of STAGES) {
    if (!(stage in stages)) fail(`questionBank.json has no stage ${stage}`);
    let order = 0;
    for (const m of list(record(stages[stage], `stage ${stage}`).modules, `stage ${stage} modules`)) {
      const mod = record(m, `stage ${stage} module`) as unknown as ContentModule & Json;
      const moduleId = idOf(mod, `stage ${stage} module`);
      if (moduleIds.has(moduleId)) fail(`module id ${moduleId} appears twice`);
      moduleIds.add(moduleId);
      for (const q of list(mod.questions, `module ${moduleId} questions`)) {
        idOf(record(q, `module ${moduleId} question`), `module ${moduleId} question`);
        questions.push({ ...(q as ContentQuestion), stage, moduleId, moduleTitle: mod.title, order: order++ });
      }
    }
  }
  const questionMap = byId<LoadedQuestion>(questions, 'question');
  for (const q of questions) {
    if (q.condition === undefined) continue;
    const cond: unknown = q.condition;
    if (!isRecord(cond) || cond.value !== CONDITION_VALUE) fail(`question ${q.id} has a condition whose value is not "${CONDITION_VALUE}"`);
    const gate = questionMap.get(q.condition.questionId);
    if (gate === undefined || gate.type !== 'gate') fail(`question ${q.id} has a condition on ${String(q.condition.questionId)}, which is not a gate question`);
  }

  const areaFile = record(parse('assessmentAreas.json'), 'assessmentAreas.json');
  const areas = byId<ContentArea>(list(areaFile.areas, 'assessmentAreas.json areas'), 'area');
  const controls = byId<ContentControl>(list(areaFile.controls, 'assessmentAreas.json controls'), 'control');

  const codes = list(record(parse('reasonCodes.json'), 'reasonCodes.json').codes, 'reasonCodes.json codes');
  const seenCodes = new Set<string>();
  for (const c of codes) {
    const entry = record(c, 'reasonCodes.json code');
    if (typeof entry.code !== 'string' || entry.code === '') fail('a reason code has no code');
    if (seenCodes.has(entry.code as string)) fail(`reason code ${entry.code as string} appears twice`);
    seenCodes.add(entry.code as string);
    if (typeof entry.status !== 'string' || !(REASON_STATUSES as readonly string[]).includes(entry.status)) fail(`reason code ${entry.code as string} has an unknown status`);
  }

  const documentHelp = record(parse('documentHelp.json'), 'documentHelp.json');
  for (const [type, line] of Object.entries(documentHelp)) if (typeof line !== 'string') fail(`documentHelp.json ${type} is not text`);

  return deepFreeze({
    semver,
    contentHash,
    questions: questionMap,
    areas,
    controls,
    reasonCodes: codes as ReasonCodeEntry[],
    documentHelp: documentHelp as DocumentHelpFile,
  });
}

/**
 * Any listed version, read once per process (the files cannot change under a running server, and a new
 * content version ships as a new deployment). `semver` may come from a database column or a request, so it is
 * checked against the semver pattern and against the versions `index.json` lists before anything is read;
 * anything else answers `unknown_content_version` (500: no caller can fix a version the product does not hold).
 * The message is the code alone, because a response carries it and the value is not ours to echo.
 */
export function loadContent(semver: ContentSemver): LoadedContent {
  if (typeof semver !== 'string' || !SEMVER_RE.test(semver)) throw new AppError(500, 'unknown_content_version');
  // A list, not a string: `'5.0.0-rc1'.includes('5.0.0')` is true.
  const { versions } = readContentIndex();
  if (!Array.isArray(versions) || !versions.includes(semver)) throw new AppError(500, 'unknown_content_version');
  const cached = cache.get(semver);
  if (cached !== undefined) return cached;
  const loaded = buildLoadedContent(semver, (file) => readContentBytes(semver, file));
  cache.set(semver, loaded);
  return loaded;
}

/** The version `index.json` names as running. */
export function runningContent(): LoadedContent {
  return loadContent(runningSemver());
}

/** A stage's questions in module order, then file order; `order` runs 0, 1, 2, ... (7.1.6). */
export function questionsInStage(c: LoadedContent, stage: Stage): LoadedQuestion[] {
  return [...c.questions.values()].filter((q) => q.stage === stage);
}

/** The reason codes of one status, in file order (SRS 10.1.5). */
export function reasonCodesFor(c: LoadedContent, status: 'not_applicable' | 'not_yet'): ReasonCodeEntry[] {
  return c.reasonCodes.filter((r) => r.status === status);
}

/**
 * FR-CNT-04: a question with a `condition` on the gate applies when the gate's current scope answer is
 * `'yes'` or `'not_sure'`, and also while the gate has no answer (`null`): missing a consent question is worse
 * than answering one too many (owner question 7). So only a recorded `'yes'` or `'no'` is compared with the
 * condition; any other value a caller passes (`null`, `'not_sure'`, or an unset value that slipped past the
 * type) leaves the question showing. A question the content lacks never applies.
 */
export function questionApplies(c: LoadedContent, questionId: string, gate: ScopeAnswer | null): boolean {
  const q = c.questions.get(questionId);
  if (q === undefined) return false;
  if (q.condition === undefined) return true;
  if (gate !== 'yes' && gate !== 'no') return true;
  return gate === q.condition.value;
}
