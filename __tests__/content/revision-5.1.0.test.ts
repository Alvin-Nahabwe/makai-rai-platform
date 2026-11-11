/**
 * Content 5.1.0 is a draft for the owner's sitting: 5.0.0 plus the proposed changes in
 * `docs/content/question-set-5.1.0/changes.json`, with `helpText` and `example` removed. 5.0.0 stays the running
 * version, and nothing here is signed (`data/content/5.1.0/signoffs.json` holds no record).
 *
 * `changes.json` is the single source: the bundle, the sitting pack and this test read it. A row is
 * `{ row, id, file, field, from, to, decision, final }`; where it points:
 *   questionBank.json     id = question id, field = a question field
 *   reasonCodes.json      id = reason code, field = a code field
 *   documentHelp.json     id = the document type key, field = "text"
 *   assessmentAreas.json  id = "meta" or a risk area id, field = a path inside it (for example "references[0].relevance")
 *   projectConfig.json    id = "projectConfig", field = a key of the file
 * The value a row puts in the bundle is `final`, or `from` when the owner declined it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { claimMatches } from '@/lib/claims/pattern';
import { sentenceCount, validateContentVersion } from '@/lib/content/validate';

import { withApprovedCopy } from './helpers/draft-proposal';

const OLD = 'data/content/5.0.0';
const NEW = 'data/content/5.1.0';
const CHANGES_FILE = 'docs/content/question-set-5.1.0/changes.json';
const PROPOSAL_FILE = 'docs/content/question-set-5.1.0/proposal.json';
const FILES = ['assessmentAreas.json', 'projectConfig.json', 'questionBank.json', 'reasonCodes.json', 'documentHelp.json'] as const;
type FileName = (typeof FILES)[number];

interface Change { row: string; id: string; file: FileName; field: string; from: string; to: string; decision: 'pending' | 'accept' | 'edit' | 'decline'; final: string }
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- walks arbitrary content JSON

const read = (dir: string, f: string): Json => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const readBundle = (dir: string): Record<FileName, Json> => Object.fromEntries(FILES.map((f) => [f, read(dir, f)])) as Record<FileName, Json>;
const changes = JSON.parse(readFileSync(CHANGES_FILE, 'utf8')) as Change[];

/** The object a row's field lives in. */
function holder(bundle: Record<FileName, Json>, c: Change): Json {
  const where = c.file;
  if (where === 'questionBank.json') {
    const qs = Object.values(bundle[where].stages as Record<string, Json>).flatMap((s) => s.modules.flatMap((m: Json) => m.questions));
    return qs.find((q: Json) => q.id === c.id);
  }
  if (where === 'reasonCodes.json') return bundle[where].codes.find((r: Json) => r.code === c.id);
  if (where === 'documentHelp.json') return bundle[where];
  if (where === 'assessmentAreas.json') return c.id === 'meta' ? bundle[where].meta : bundle[where].areas.find((a: Json) => a.id === c.id);
  return bundle[where];
}
/** `a.b[0].c` as the steps ["a", "b", 0, "c"]. */
const steps = (field: string): Array<string | number> => [...field.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]));
function get(o: Json, field: string): unknown { return steps(field).reduce((x, k) => x?.[k], o); }
function set(o: Json, field: string, v: string): void {
  const s = steps(field);
  const last = s.pop() as string | number;
  s.reduce((x, k) => x[k], o)[last] = v;
}
const valueOf = (c: Change): string => (c.decision === 'decline' ? c.from : c.final);

/** 5.0.0 with the rows applied, helpText and example removed, and meta.version 5.1.0. */
function expected(): Record<FileName, Json> {
  const b = readBundle(OLD);
  for (const c of changes) {
    const h = holder(b, c);
    expect(h, `${c.row} ${c.id}: nothing at that place`).toBeDefined();
    if (c.file === 'documentHelp.json') h[c.id] = valueOf(c);
    else set(h, c.field, valueOf(c));
  }
  for (const s of Object.values(b['questionBank.json'].stages as Record<string, Json>)) {
    for (const m of s.modules) for (const q of m.questions) { delete q.helpText; delete q.example; }
  }
  b['questionBank.json'].meta.version = '5.1.0';
  b['assessmentAreas.json'].meta.version = '5.1.0';
  return b;
}

function strings(o: Json, path = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[path, o]];
  if (Array.isArray(o)) return o.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (o !== null && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

describe('content 5.1.0, the draft for the owner', () => {
  it('5.1.0 equals 5.0.0 with the proposed changes applied, helpText and example removed, and meta.version 5.1.0', () => {
    const want = expected();
    for (const f of FILES) expect(read(NEW, f), f).toEqual(want[f]);
  });

  it("every change row's from is the 5.0.0 text, and its id and field are unique", () => {
    const old = readBundle(OLD);
    for (const c of changes) {
      const h = holder(old, c);
      const was = c.file === 'documentHelp.json' ? h?.[c.id] : get(h, c.field);
      expect(was, `${c.row} ${c.id} ${c.field}`).toBe(c.from);
    }
    const keys = changes.map((c) => `${c.file}|${c.id}|${c.field}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('every row is pending, or accepted with its final text; the draft shows each final as proposed', () => {
    for (const c of changes) {
      expect(['pending', 'accept', 'edit', 'decline'], c.row).toContain(c.decision);
      if (c.decision === 'pending') expect(c.final, c.row).toBe(c.to);
      if (c.decision === 'accept') expect(c.final, c.row).toBe(c.to);
    }
  });

  it('the risk-area cut: 67 whyAsked rows, every one ending its text without the "Risk area" sentence', () => {
    const cut = changes.filter((c) => c.row.includes('WA-tail'));
    expect(cut).toHaveLength(67);
    for (const c of cut) {
      expect(c.field).toBe('whyAsked');
      // The owner accepted the cut; for Q-PP-05 and Q-PP-24 he also edited the cut text (row WA-tail+owner-edit), and `to` still shows the cut as drafted.
      expect(c.decision, c.id).toBe(c.row.endsWith('owner-edit') ? 'edit' : 'accept');
      // The cut removes exactly the final "Risk area(s): ..." sentence and the space before it, nothing else.
      const m = /^(.*) (Risk areas?: [^.]*\.)$/.exec(c.from);
      expect(m, c.id).not.toBeNull();
      expect(c.to, c.id).toBe(m?.[1]);
      expect(/Risk areas?: /.test(c.final), c.id).toBe(false);
    }
    const bank = read(NEW, 'questionBank.json');
    const left = Object.values(bank.stages as Record<string, Json>).flatMap((s) => s.modules.flatMap((m: Json) => m.questions)).filter((q: Json) => /Risk areas?: /.test(q.whyAsked));
    expect(left.map((q: Json) => q.id)).toEqual([]);
  });

  it('no question of 5.1.0 holds helpText or example', () => {
    const bank = read(NEW, 'questionBank.json');
    const qs = Object.values(bank.stages as Record<string, Json>).flatMap((s) => s.modules.flatMap((m: Json) => m.questions));
    expect(qs.filter((q: Json) => 'helpText' in q || 'example' in q).map((q: Json) => q.id)).toEqual([]);
    expect(qs).toHaveLength(67);
  });

  it('the owner answered every row (11 Nov 2026, 19:43 EAT): none is pending, two are edited, and the committed proposal says approved', () => {
    expect(changes.filter((c) => c.decision === 'pending').map((c) => c.row)).toEqual([]);
    expect(changes.filter((c) => c.decision === 'edit').map((c) => `${c.row} ${c.id}`)).toEqual(['WA-tail+owner-edit Q-PP-05', 'WA-tail+owner-edit Q-PP-24']);
    expect(changes.filter((c) => c.decision === 'decline')).toEqual([]);
    expect((JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8')) as { status: string }).status).toBe('approved');
  });

  it("the two edited texts end as the owner chose, and pass the length and claim checks", () => {
    const edited = new Map(changes.filter((c) => c.decision === 'edit').map((c) => [c.id, c.final]));
    expect(edited.get('Q-PP-05')?.endsWith('this question asks about those rights, and a separate question asks about particular groups.')).toBe(true);
    expect(edited.get('Q-PP-24')?.endsWith('for example through multi-stakeholder consultation.')).toBe(true);
    for (const t of edited.values()) {
      expect(claimMatches(t)).toEqual([]);
      // whyAsked: 1 to 300 characters and at most two sentences (lib/content/validate.ts:577, QC-01).
      expect(t.length).toBeGreaterThanOrEqual(1);
      expect(t.length).toBeLessThanOrEqual(300);
      expect(sentenceCount(t)).toBeLessThanOrEqual(2);
    }
  });

  /** The validator reads a proposal only when its status is 'approved' (lib/content/validate.ts:173-177), so these cases check an approved copy. */
  const validate = (completeness: boolean): string[] =>
    withApprovedCopy(PROPOSAL_FILE, (file) => validateContentVersion(NEW, { baselineDir: 'data', proposalFile: file, completeness }));

  it("validateContentVersion('data/content/5.1.0') against the 4.0.0 baseline and the proposal (approved copy, kept for any future draft) returns no problem", () => {
    expect(validate(false)).toEqual([]);
  });

  it('with completeness on, the only problems are the seven missing sign-offs (QC-01 lengths hold)', () => {
    const problems = validate(true);
    expect(problems.filter((p) => !/^5\.1\.0: sign-off [\w:-]+: no record$/.test(p))).toEqual([]);
    expect(problems).toHaveLength(7);
  });

  it('no 5.1.0 rendered field holds a claim word that is not already in 5.0.0 at the same place, and no changed field holds one', () => {
    const oldHits = new Set(FILES.flatMap((f) => strings(read(OLD, f)).filter(([, s]) => claimMatches(s).length > 0).map(([p]) => `${f}${p}`)));
    const fresh = FILES.flatMap((f) => strings(read(NEW, f)).filter(([p, s]) => claimMatches(s).length > 0 && !oldHits.has(`${f}${p}`)).map(([p]) => `${f}${p}`));
    expect(fresh).toEqual([]);
    expect(changes.filter((c) => claimMatches(c.final).length > 0).map((c) => c.row)).toEqual([]);
  });

  it('no rendered string of 5.1.0 names a first institution\'s country, city or regulator, except what is listed', () => {
    // Countries, cities, languages and regulators of the five first institutions (APHRC, AHRI, Douala General Hospital, IRESSEF, Makerere).
    const names = /Ugand|Kenya|Ethiopi|Cameroon|Senegal|Kampala|Nairobi|Addis|Douala|Dakar|Gulu|Acholi|Luganda|Makerere|UNCST|NACOSTI|ODPC|Data Protection and Privacy Act|Data Protection Act/i;
    // What legitimately remains: the institution that runs the platform. No resource title or study note holds one today; a new occurrence fails here.
    const allowed = new Set(['projectConfig.json.institution']);
    const hits = FILES.flatMap((f) => strings(read(NEW, f)).filter(([, v]) => names.test(v)).map(([p]) => `${f}${p}`)).filter((h) => !allowed.has(h));
    expect(hits).toEqual([]);
  });

  it('the proposal differs from 5.0.0\'s only in the 27 reworded stems (action, text) and its status; reasons are kept', () => {
    const was = JSON.parse(readFileSync('docs/content/question-set-5.0.0/proposal.json', 'utf8')) as Json;
    const now = JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8')) as Json;
    expect({ ...now, status: undefined, actions: undefined }).toEqual({ ...was, status: undefined, actions: undefined });
    expect(now.actions).toHaveLength(was.actions.length);
    const stems = new Map(changes.filter((c) => c.file === 'questionBank.json' && c.field === 'text').map((c) => [c.id, valueOf(c)]));
    let reworded = 0;
    now.actions.forEach((a: Json, i: number) => {
      const old = was.actions[i];
      if (a.action === 'reword') {
        reworded += 1;
        expect(old.action, a.id).toBe('keep');
        expect(a.text, a.id).toBe(stems.get(a.id));
        const { action: _a, text: _t, ...rest } = a;
        const { action: _o, ...oldRest } = old;
        expect(rest, a.id).toEqual(oldRest);
      } else {
        expect(a, a.id).toEqual(old);
        expect(stems.has(a.id), a.id).toBe(false);
      }
    });
    expect(reworded).toBe(stems.size);
    expect(reworded).toBe(27);
  });

  it('index.json keeps 5.0.0 running and lists 5.1.0', () => {
    const index = JSON.parse(readFileSync('data/content/index.json', 'utf8')) as { running: string; versions: string[] };
    expect(index.running).toBe('5.0.0');
    expect(index.versions).toContain('5.1.0');
  });
});
