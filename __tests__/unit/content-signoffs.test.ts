import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '@/lib/integrity/canonical.mjs';
import { buildLoadedContent, questionsInStage } from '@/lib/content/loader';
import { signOffHash, signOffItems, signOffPayload, type SignOffBatch } from '@/lib/content/signoffs';
import { sentenceCount, validateContentVersion } from '@/lib/content/validate';
import { DOCUMENT_TYPES } from '@/types/record';

/**
 * Sign-off digests and the completeness rules of a content version (FR-CNT-02, SRS 10.1.0 step 4, 10.1.10 QC-01,
 * QC-02, QC-05, QC-06; R-61). Every case works on a temporary copy of H0's fixture bundle, read with plain file
 * reads, so nothing here goes through the mocked `@/lib/content/root`; the one case that reads the real 5.0.0
 * starting files names no question id.
 */

const FIXTURES = join(process.cwd(), '__tests__', 'fixtures', 'content');
const BATCHES: readonly SignOffBatch[] = ['pre-processing', 'in-processing', 'post-processing', 'help-and-reason-codes',
  'question-set:pre-processing', 'question-set:in-processing', 'question-set:post-processing'];
const AT = '2026-10-31T10:00:00.000Z';

type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- the files are edited as plain JSON
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const json = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const tempDir = () => { const r = mkdtempSync(join(tmpdir(), 'cnt-signoffs-')); roots.push(r); return r; };

/** A temporary copy of one of H0's fixture versions, under a temporary content root, so its directory name is the semver. */
function copyFixture(semver: string): string {
  const dir = join(tempDir(), semver);
  cpSync(join(FIXTURES, semver), dir, { recursive: true });
  return dir;
}
function editBank(dir: string, edit: (bank: Json) => void): void {
  const bank = json(join(dir, 'questionBank.json'));
  edit(bank);
  write(join(dir, 'questionBank.json'), bank);
}
const questionsOf = (bank: Json): Json[] => Object.values(bank.stages as Json).flatMap((s: Json) => s.modules.flatMap((m: Json) => m.questions));
function editQuestion(dir: string, id: string, edit: (q: Json) => Json): void {
  editBank(dir, (bank) => {
    for (const s of Object.values(bank.stages as Json)) for (const m of (s as Json).modules) m.questions = m.questions.map((q: Json) => (q.id === id ? edit(q) : q));
  });
}
/**
 * H0's fixture keeps 4.0.0's conditional help texts on the follow-up questions ("When data representativeness was
 * not audited ..."), which QC-06 refuses in a complete version; a complete copy rewrites them first.
 */
function completeCopy(semver: string): string {
  const dir = copyFixture(semver);
  editBank(dir, (bank) => {
    for (const q of questionsOf(bank)) if (q.id.includes('-EXTRA-') && /^When /.test(q.helpText ?? '')) q.helpText = 'Guidance for every team that answers this question.';
  });
  // ... and 4.0.0's one http source link (PP-03), which the release check refuses (NFR-SEC-11).
  const areasPath = join(dir, 'assessmentAreas.json');
  const areasFile = json(areasPath);
  for (const a of areasFile.areas) for (const r of a.references ?? []) if (typeof r.url === 'string') r.url = r.url.replace(/^http:/, 'https:');
  write(areasPath, areasFile);
  return dir;
}
const loadDir = (dir: string) => buildLoadedContent(basename(dir), (f) => readFileSync(join(dir, f)));
/** Writes signoffs.json with one record per batch, built from the current texts, as C-TXT's sign-off script does. */
function signAll(dir: string): void {
  const c = loadDir(dir);
  write(join(dir, 'signoffs.json'), { records: BATCHES.map((batch) => {
    const p = signOffPayload(c, batch);
    return { batch, approver: 'Owner', at: AT, sha256: signOffHash(p), items: signOffItems(p) };
  }) });
}
function dropRecord(dir: string, batch: string): void {
  const f = json(join(dir, 'signoffs.json'));
  f.records = f.records.filter((r: Json) => r.batch !== batch);
  write(join(dir, 'signoffs.json'), f);
}
/** A question-set proposal over the 4.0.0 bank at data/ (`QuestionSetProposal`); every id not named in `actions` or `cut` is kept. */
function writeProposal(o: { status: string; cut?: string[]; keepRest?: boolean; actions?: Json[]; newQuestions?: Json[] }): string {
  const baseBytes = readFileSync('data/questionBank.json');
  const named = new Map((o.actions ?? []).map((a) => [a.id, a]));
  const actions = questionsOf(JSON.parse(baseBytes.toString('utf8'))).flatMap((q) => {
    if (o.cut?.includes(q.id)) return [{ action: 'cut', id: q.id, originalText: q.text, reason: 'r' }];
    if (named.has(q.id)) return [{ originalText: q.text, reason: 'r', ...named.get(q.id) }];
    return o.keepRest === false ? [] : [{ action: 'keep', id: q.id, originalText: q.text, reason: 'r' }];
  });
  const file = join(tempDir(), 'proposal.json');
  write(file, { base: { commit: 'd13be0c', file: 'data/questionBank.json', sha256: sha256(baseBytes) }, status: o.status, actions,
    newQuestions: o.newQuestions ?? [], survivors: [], decisions: { 'OD-08': 'a', 'OD-09': 'a', 'OD-C3': 'a' }, repoints: [], disputed: [] });
  return file;
}
const check = (dir: string, opts: { proposalFile?: string | null; completeness?: boolean } = {}) =>
  validateContentVersion(dir, { baselineDir: 'data', proposalFile: opts.proposalFile ?? null, completeness: opts.completeness ?? true });

const RP3 = 'Say how consent was obtained (written, oral with a witness, community and individual), in which languages, and whether it covers AI use and sharing. If a committee waived consent, name the committee and the reference. This text is printed in the data card under "Informed consent". Attach the blank form, never signed forms.';

describe('sign-offs and completeness', () => {
  it('FR-CNT-02: the sentence counter on the SRS worked examples', () => {
    expect(sentenceCount(RP3)).toBe(4);           // SRS line 4069, 324 code points
    expect(sentenceCount('Teams often assume AI is the answer before checking whether a rule, a dashboard or a better manual process would do as well. A model that is not needed still costs money, power and upkeep, and its errors fall on the people it serves.')).toBe(2);
  });

  it('FR-CNT-02: a fixture copy with every batch signed is complete; a missing batch is named', () => {
    const dir = completeCopy('0.0.1-fixture');           // temp copy of H0's fixture under a temp content root
    signAll(dir);                                       // writes signoffs.json: one record per batch from signOffPayload, signOffHash, signOffItems
    expect(validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: true })).toEqual([]);
    dropRecord(dir, 'question-set:in-processing');
    expect(validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: true })).toEqual([expect.stringContaining('question-set:in-processing')]);
  });

  it('FR-CNT-02: changing one character of a signed text makes its batch unsigned', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    editQuestion(dir, 'Q-PO-01', (q) => ({ ...q, whyAsked: q.whyAsked + ' ' }));
    const problems = validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: true });
    expect(problems.join('\n')).toMatch(/post-processing.*sha256/);
    expect(problems).toHaveLength(1);                   // only the post-processing batch: its question-set batch holds ids and stems only
    expect(problems[0]).not.toMatch(/question-set/);
  });

  it('FR-CNT-02: QC-01 limits are enforced at their edges', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    editQuestion(dir, 'Q-PP-01', (q) => ({ ...q, expectedPractice: 'x'.repeat(39), evidenceExamples: [] }));
    const p = validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: true }).join('\n');
    expect(p).toMatch(/Q-PP-01.*expectedPractice/); expect(p).toMatch(/Q-PP-01.*evidenceExamples/);
  });

  it('FR-CNT-02: QC-01 counts code points and sentences, and each limit holds at its value and fails one past it', () => {
    const dir = completeCopy('0.0.1-fixture');
    const s = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i}.`).join(' ');
    const ok: Array<[string, Json]> = [
      ['Q-PP-01', { expectedPractice: '\u{1F600}'.repeat(400) }],          // 400 code points, 800 UTF-16 units
      ['Q-PP-02', { expectedPractice: 'x'.repeat(40) }],
      ['Q-PP-03', { whyAsked: 'y'.repeat(300) }], ['Q-PP-04', { whyAsked: s(2) }], ['Q-PP-05', { whyAsked: 'z' }],
      ['Q-PP-06', { reasonPrompt: 'r'.repeat(400) }], ['Q-PP-07', { reasonPrompt: s(4) }],
      ['Q-PP-08', { evidenceExamples: ['a', 'b', 'c', 'd'] }], ['Q-PP-09', { evidenceExamples: ['a'] }],
    ];
    const bad: Array<[string, Json, string]> = [
      ['Q-IP-01', { expectedPractice: 'x'.repeat(401) }, 'expectedPractice'], ['Q-IP-02', { expectedPractice: 'x'.repeat(39) }, 'expectedPractice'],
      ['Q-IP-03', { whyAsked: 'y'.repeat(301) }, 'whyAsked'], ['Q-IP-04', { whyAsked: s(3) }, 'whyAsked'], ['Q-IP-05', { whyAsked: '' }, 'whyAsked'],
      ['Q-IP-07', { reasonPrompt: 'r'.repeat(401) }, 'reasonPrompt'], ['Q-IP-08', { reasonPrompt: s(5) }, 'reasonPrompt'], ['Q-IP-09', { reasonPrompt: '' }, 'reasonPrompt'],
      ['Q-IP-10', { evidenceExamples: ['a', 'b', 'c', 'd', 'e'] }, 'evidenceExamples'], ['Q-IP-11', { evidenceExamples: ['a', ''] }, 'evidenceExamples'],
      ['Q-IP-12', { expectedPractice: undefined }, 'expectedPractice'], ['Q-IP-13', { evidenceExamples: 'a' }, 'evidenceExamples'],
    ];
    for (const [id, change] of [...ok, ...bad]) editQuestion(dir, id, (q) => ({ ...q, ...change }));
    // Nothing is signed, so every sign-off line is left out; what remains is exactly one line per broken limit.
    const problems = check(dir).filter((x) => !/sign-off/.test(x));
    expect(problems.map((x) => /question (Q-[A-Z]+-\d+): (\w+)/.exec(x)?.slice(1, 3).join(' ')).sort()).toEqual(bad.map(([id, , f]) => `${id} ${f}`).sort());
    for (const [id] of ok) expect(problems.join('\n')).not.toContain(id);
  });

  it('FR-CNT-02 (QC-06): the follow-up help texts may not begin with a conditional; H0\'s fixture as it is fails on exactly those', () => {
    const dir = copyFixture('0.0.1-fixture'); signAll(dir);
    const qc06 = check(dir).filter((x) => /QC-06/.test(x));
    const expected = questionsOf(json(join(dir, 'questionBank.json'))).filter((q) => q.id.includes('-EXTRA-') && q.helpText.startsWith('When ')).map((q) => q.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(qc06.map((x) => /question (\S+):/.exec(x)?.[1]).sort()).toEqual(expected.sort());
    // nothing else is wrong with the signed copy but 4.0.0's http source link, which the reference rule names
    expect(check(dir).filter((x) => !/QC-06/.test(x))).toEqual([expect.stringMatching(/risk area PP-03: source link "http:\/\/proceedings\.mlr\.press\/v81\/buolamwini18a\.html" is not https \(NFR-SEC-11\)/)]);
    expect(check(dir, { completeness: false })).toEqual([]);
  });

  it('FR-CNT-01 NFR-SEC-11: a risk area\'s source link must be https to release, and has no other scheme', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    expect(check(dir)).toEqual([]);
    for (const url of ['http://example.org/paper', 'javascript:alert(1)', 'not a url']) {
      const f = json(join(dir, 'assessmentAreas.json'));
      f.areas[1].references[0].url = url;
      write(join(dir, 'assessmentAreas.json'), f);
      expect(check(dir), url).toEqual([`0.0.1-fixture: risk area ${f.areas[1].id}: source link ${JSON.stringify(url)} is not https (NFR-SEC-11)`]);
      expect(check(dir, { completeness: false }), url).toEqual([]);   // the release gate: C-TXT fixes a link before sign-off
    }
  });

  it('FR-CNT-01: an approved revision whose cut id is still in the bank is refused', () => {
    const dir = copyFixture('0.0.1-fixture');
    const proposal = writeProposal({ status: 'approved', cut: ['Q-PP-02'], keepRest: true });   // but Q-PP-02 is still in the bank
    expect(validateContentVersion(dir, { baselineDir: 'data', proposalFile: proposal, completeness: false }).join('\n')).toMatch(/Q-PP-02.*cut/);
  });

  it('FR-CNT-01 QC-02 R-61: an approved merge, replace and reword validate only with the mapping, ids and stems they promise', () => {
    // Q-PP-03 (area PP-04) merges into Q-PP-01 (area PP-01); Q-PP-02 is replaced by the new Q-PP-24; Q-PP-04 is reworded.
    // The replacing question as the approved proposal describes it (`newQuestions`): Q-PP-02's 4.0.0 stem, type and principle.
    const q02 = questionsOf(json('data/questionBank.json')).find((q) => q.id === 'Q-PP-02')!;
    const newQuestion = (id: string, change: Json = {}) => ({ id, stage: 'pre-processing', moduleId: 'pre-problem', type: q02.type, text: q02.text,
      principle: q02.principle, gaps: q02.gaps, ...change });
    const proposal = (newId = 'Q-PP-24', text = 'Is the problem stated in one sentence?', cut: string[] = [], newQuestions: Json[] = [newQuestion(newId)]) => writeProposal({ status: 'approved', cut, newQuestions, actions: [
      { action: 'merge', id: 'Q-PP-03', into: 'Q-PP-01' }, { action: 'replace', id: 'Q-PP-02', newId }, { action: 'reword', id: 'Q-PP-04', text },
    ] });
    const revised = (o: { survivorGaps?: string[]; newId?: string; drop?: string[] } = {}) => {
      const dir = copyFixture('0.0.1-fixture');
      editBank(dir, (bank) => {
        const mod = bank.stages['pre-processing'].modules.find((m: Json) => m.id === 'pre-problem');
        const by = (id: string) => mod.questions.find((q: Json) => q.id === id);
        by('Q-PP-01').gaps = o.survivorGaps ?? ['PP-01', 'PP-04'];
        by('Q-PP-04').text = 'Is the problem stated in one sentence?';
        by('Q-PP-02').id = o.newId ?? 'Q-PP-24';
        mod.questions = mod.questions.filter((q: Json) => q.id !== 'Q-PP-03' && !(o.drop ?? []).includes(q.id));
      });
      return dir;
    };
    expect(check(revised(), { proposalFile: proposal(), completeness: false })).toEqual([]);
    // the survivor without the absorbed question's area loses its (PP-04, control) pairs
    expect(check(revised({ survivorGaps: ['PP-01'] }), { proposalFile: proposal(), completeness: false }).join('\n')).toMatch(/Q-PP-01.*QC-02/);
    // a reword the bank does not carry
    expect(check(revised(), { proposalFile: proposal('Q-PP-24', 'Another stem?'), completeness: false }).join('\n')).toMatch(/Q-PP-04.*reword/);
    // a new id that is a 4.0.0 id, here the id of a question the same proposal cuts (R-61: a cut id is never reused)
    const reused = check(revised({ newId: 'Q-PP-05', drop: ['Q-PP-05'] }), { proposalFile: proposal('Q-PP-05', undefined, ['Q-PP-05']), completeness: false }).join('\n');
    expect(reused).toMatch(/Q-PP-05.*4\.0\.0 id.*R-61/);
    // the replacing question must be the one the approved proposal's newQuestions entry describes
    expect(check(revised(), { proposalFile: proposal(undefined, undefined, undefined, []), completeness: false }).join('\n'))
      .toMatch(/question Q-PP-24: the approved proposal adds it, but its newQuestions has no entry for it/);
    for (const field of ['text', 'stage', 'moduleId', 'type', 'principle']) {
      const changed = check(revised(), { proposalFile: proposal(undefined, undefined, undefined, [newQuestion('Q-PP-24', { [field]: field === 'stage' ? 'in-processing' : 'something else' })]), completeness: false });
      expect(changed.join('\n'), field).toMatch(new RegExp(`question Q-PP-24: ${field} is not the one the approved proposal's newQuestions entry gives it`));
    }
    // the same bank with no approved proposal: every id must be a 4.0.0 id and every 4.0.0 id must be there
    const none = check(revised(), { completeness: false }).join('\n');
    expect(none).toMatch(/Q-PP-24.*not a 4\.0\.0 question/); expect(none).toMatch(/Q-PP-03.*missing/); expect(none).toMatch(/Q-PP-04.*text/);
    // a proposal that is not approved counts as none
    expect(check(revised(), { proposalFile: writeProposal({ status: 'checked', cut: ['Q-PP-03'] }), completeness: false }).join('\n')).toMatch(/Q-PP-24.*not a 4\.0\.0 question/);
  });

  it('FR-CNT-01: an approved proposal must cover every 4.0.0 question once and be built on the 4.0.0 bank', () => {
    const dir = copyFixture('0.0.1-fixture');
    const gap = writeProposal({ status: 'approved', keepRest: false, actions: [{ action: 'keep', id: 'Q-PP-01' }] });
    expect(check(dir, { proposalFile: gap, completeness: false }).join('\n')).toMatch(/Q-PP-02.*no action/);
    const p = json(writeProposal({ status: 'approved' }));
    const wrongBase = join(tempDir(), 'proposal.json');
    write(wrongBase, { ...p, base: { ...p.base, sha256: '0'.repeat(64) } });
    expect(check(dir, { proposalFile: wrongBase, completeness: false }).join('\n')).toMatch(/base.*sha256/);
    write(wrongBase, { ...p, actions: [...p.actions, { action: 'keep', id: 'Q-PP-01', originalText: 'x', reason: 'r' }] });
    expect(check(dir, { proposalFile: wrongBase, completeness: false }).join('\n')).toMatch(/Q-PP-01.*more than one action/);
    write(wrongBase, { ...p, actions: [{ action: 'fold', id: 'Q-PP-01' }] });
    expect(check(dir, { proposalFile: wrongBase, completeness: false }).join('\n')).toMatch(/proposal.*actions\[0\]/);
  });

  it('FR-CNT-02: a missing signoffs.json, an unreadable proposal and an unloadable bundle are problem lines, never an empty list or a throw', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    rmSync(join(dir, 'signoffs.json'));
    for (const completeness of [true, false]) expect(check(dir, { completeness }).join('\n')).toMatch(/signoffs\.json/);
    const signed = completeCopy('0.0.1-fixture'); signAll(signed);
    expect(check(signed, { proposalFile: join(tempDir(), 'absent.json'), completeness: false }).join('\n')).toMatch(/proposal.*absent\.json/);
    const notJson = join(tempDir(), 'proposal.json'); writeFileSync(notJson, '{"status":');
    expect(check(signed, { proposalFile: notJson, completeness: false }).join('\n')).toMatch(/proposal.*not valid JSON/);
    writeFileSync(join(signed, 'signoffs.json'), '{"records":');
    expect(check(signed).join('\n')).toMatch(/signoffs\.json.*not valid JSON/);
    const broken = copyFixture('0.0.1-fixture'); writeFileSync(join(broken, 'questionBank.json'), '{');
    expect(check(broken)).toEqual([expect.stringMatching(/questionBank\.json/)]);
    rmSync(join(broken, 'reasonCodes.json'));
    expect(check(broken)).toHaveLength(1);
    expect(check(join(tempDir(), '..'))).toEqual([expect.stringMatching(/not a content version/)]);
  });

  it('FR-CNT-02: a sign-off record is judged by its latest version, and a malformed record is named', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    const f = json(join(dir, 'signoffs.json'));
    const pre = f.records.find((r: Json) => r.batch === 'pre-processing');
    // an older record with a stale hash does not matter; a newer one with a stale hash does
    write(join(dir, 'signoffs.json'), { records: [...f.records, { ...pre, at: '2026-10-30T10:00:00.000Z', sha256: '0'.repeat(64) }] });
    expect(check(dir)).toEqual([]);
    write(join(dir, 'signoffs.json'), { records: [...f.records, { ...pre, at: '2026-11-01T10:00:00+03:00', sha256: '0'.repeat(64) }] });
    expect(check(dir).join('\n')).toMatch(/pre-processing.*sha256/);
    const cases: Array<[Json, RegExp]> = [
      [{ approver: '' }, /records\[\d+\] \(pre-processing\): approver is empty/],
      [{ at: '31 Oct 2026' }, /records\[\d+\] \(pre-processing\): at "31 Oct 2026" is not an ISO time/],
      [{ at: '2026-10-31T10:00:00' }, /records\[\d+\] \(pre-processing\): at "2026-10-31T10:00:00" is not an ISO time with a zone/],
      [{ sha256: 'A'.repeat(64) }, /records\[\d+\] \(pre-processing\): sha256 is not/],
      [{ items: ['Q-PP-01'] }, /sign-off pre-processing: items of records\[\d+\] do not match/],
      [{ batch: 'stage-1' }, /batch "stage-1" is not one of the seven batches/],
    ];
    for (const [change, pattern] of cases) {
      write(join(dir, 'signoffs.json'), { records: [...f.records.filter((r: Json) => r.batch !== 'pre-processing'), { ...pre, ...change }] });
      const problems = check(dir).join('\n');
      expect(problems, JSON.stringify(change)).toMatch(pattern);
      // a record that is not well formed does not count as the batch's sign-off
      if (!('items' in change)) expect(problems, JSON.stringify(change)).toMatch(/sign-off pre-processing: no record/);
    }
  });

  it('FR-CNT-02: the payloads hold exactly the signed texts, in questionsInStage order, and the hash is SHA-256 of their canonical JSON', () => {
    const c = loadDir(copyFixture('0.0.1-fixture'));
    const stage = signOffPayload(c, 'in-processing');
    if (stage.batch !== 'in-processing') throw new Error('narrowing');
    expect(stage.questions.map((q) => q.id)).toEqual(questionsInStage(c, 'in-processing').map((q) => q.id));
    const q0 = questionsInStage(c, 'in-processing')[0];
    expect(stage.questions[0]).toEqual({ id: q0.id, text: q0.text, expectedPractice: q0.expectedPractice, whyAsked: q0.whyAsked, reasonPrompt: q0.reasonPrompt,
      evidenceExamples: [...q0.evidenceExamples], helpText: q0.helpText ?? null, example: q0.example ?? null });
    expect(signOffHash(stage)).toBe(sha256(Buffer.from(canonicalJson(stage), 'utf8')));
    const set = signOffPayload(c, 'question-set:post-processing');
    expect(set).toEqual({ batch: 'question-set:post-processing', questions: questionsInStage(c, 'post-processing').map((q) => ({ id: q.id, text: q.text })) });
    const help = signOffPayload(c, 'help-and-reason-codes');
    expect(signOffItems(help)).toEqual([...DOCUMENT_TYPES.map((t) => `documentHelp:${t}`), ...c.reasonCodes.map((r) => `reasonCode:${r.code}`)]);
    expect(signOffItems(set)).toEqual(questionsInStage(c, 'post-processing').map((q) => q.id));
    expect(() => signOffPayload(c, 'question-set:everything' as SignOffBatch)).toThrow(/question-set:everything/);
  });

  it('FR-CNT-01 QC-02: a mapping of the wrong shape is a problem line, even where the pairs would still match', () => {
    // [question, change, the field the line must name]; each would otherwise be skipped by the pair reading
    const cases: Array<[string, Json, RegExp]> = [
      ['Q-PP-GATE-SENSITIVE', { gaps: 'PP-01' }, /Q-PP-GATE-SENSITIVE: gaps is not a list of risk area ids/],
      ['Q-PP-01', { gaps: ['PP-01', 7] }, /Q-PP-01: gaps is not a list of risk area ids/],
      ['Q-PP-16', { optionGapMap: { 'Missing data analysis': [{ area: 'PP-02', role: 'primary' }], 'Outlier detection': 'IP-07' } }, /Q-PP-16: optionGapMap\["Outlier detection"\] is not a list/],
      ['Q-PP-16', { optionGapMap: { 'Missing data analysis': [{ area: 'PP-02', role: 'primary' }, null] } }, /Q-PP-16: optionGapMap\["Missing data analysis"\]\[1\] is not/],
      ['Q-PP-16', { optionGapMap: { 'Missing data analysis': [{ area: 'PP-02', role: 'primry' }] } }, /Q-PP-16: optionGapMap\["Missing data analysis"\]\[0\] is not/],
      ['Q-PP-16', { optionGapMap: { 'Missing data analysis': [{ role: 'primary' }] } }, /Q-PP-16: optionGapMap\["Missing data analysis"\]\[0\] is not/],
      ['Q-PP-16', { optionGapMap: ['PP-02'] }, /Q-PP-16: optionGapMap is not an object/],
      ['Q-PP-01', { helpText: { text: 'x' } }, /Q-PP-01: helpText is not text/],
      ['Q-PP-01', { example: 3 }, /Q-PP-01: example is not text/],
    ];
    for (const [id, change, pattern] of cases) {
      const dir = copyFixture('0.0.1-fixture');
      editQuestion(dir, id, (q) => ({ ...q, ...change }));
      let problems: string[] = [];
      expect(() => { problems = check(dir, { completeness: false }); }, JSON.stringify(change)).not.toThrow();
      expect(problems.join('\n'), JSON.stringify(change)).toMatch(pattern);
    }
  });

  it('FR-CNT-01 FR-CNT-02: an area, control or file of the wrong shape is a problem line, never a throw', () => {
    const areas = (dir: string, edit: (a: Json) => void) => { const f = json(join(dir, 'assessmentAreas.json')); edit(f); write(join(dir, 'assessmentAreas.json'), f); };
    const cases: Array<[(dir: string) => void, RegExp]> = [
      [(d) => areas(d, (f) => { f.areas[0].controls = {}; }), /risk area \S+: controls is not a list of control ids/],
      [(d) => areas(d, (f) => { f.controls[0].resources = { url: 'https://x.example' }; }), /control \S+: resources is not a list/],
      [(d) => areas(d, (f) => { f.controls[0].resources = [null]; }), /control \S+: resources\[0\] is not a link/],
      [(d) => areas(d, (f) => { f.controls[0].resources = [{ title: 't', url: 'http://plain.example/x' }]; }), /control \S+: resource link "http:\/\/plain\.example\/x" is not https/],
      [(d) => areas(d, (f) => { f.controls[0].resources = [{ title: 't', url: 'javascript:alert(1)' }]; }), /resource link "javascript:alert\(1\)" is not https/],
      [(d) => writeFileSync(join(d, 'projectConfig.json'), '{'), /projectConfig\.json is not valid JSON/],
      // An area's stage decides the stage S-26 shows it under: not a stage at all, or not its 4.0.0 stage (SRS 10.1.1).
      [(d) => areas(d, (f) => { f.areas[0].stage = 'pre_processing'; }), /risk area PP-01: stage "pre_processing" is not one of pre-processing, in-processing, post-processing/],
      [(d) => areas(d, (f) => { f.areas[0].stage = 'in-processing'; }), /risk area PP-01: stage in-processing is not its 4\.0\.0 stage pre-processing/],
      // Every text S-26 and S-12 show as a heading, a label or a link name must be there (no "Principle: undefined").
      [(d) => areas(d, (f) => { f.areas[0].name = ''; }), /risk area PP-01: name is not a non-empty text/],
      [(d) => areas(d, (f) => { delete f.areas[0].principle; }), /risk area PP-01: principle is not a non-empty text/],
      [(d) => areas(d, (f) => { f.areas[0].description = '   '; }), /risk area PP-01: description is not a non-empty text/],
      [(d) => areas(d, (f) => { f.controls[0].name = 7; }), /control C-01: name is not a non-empty text/],
      [(d) => editQuestion(d, 'Q-PO-03', (q) => ({ ...q, principle: '' })), /question Q-PO-03: principle is not a non-empty text/],
      // FR-CNT-01 keeps 6 modules: one whose every question went elsewhere would drop out of S-26's list and count.
      [(d) => editBank(d, (bank) => {
        const [first, second] = bank.stages['pre-processing'].modules;
        second.questions = [...first.questions, ...second.questions]; first.questions = [];
      }), /module pre-problem: holds no question \(FR-CNT-01\)/],
    ];
    for (const [edit, pattern] of cases) {
      const dir = copyFixture('0.0.1-fixture'); edit(dir);
      let problems: string[] = [];
      expect(() => { problems = check(dir, { completeness: false }); }, String(pattern)).not.toThrow();
      expect(problems.join('\n')).toMatch(pattern);
    }
    // a byte order mark, which the loader's decoder accepts, is read the same way here, in every file the check reads
    const bom = copyFixture('0.0.1-fixture');
    const withBom = (f: string) => writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(f)]));
    for (const f of ['questionBank.json', 'assessmentAreas.json']) withBom(join(bom, f));
    expect(check(bom, { completeness: false })).toEqual([]);
    const signed = completeCopy('0.0.1-fixture'); signAll(signed);
    withBom(join(signed, 'signoffs.json'));
    const proposal = writeProposal({ status: 'revised' }); withBom(proposal);
    expect(check(signed)).toEqual([]);
    expect(check(signed, { proposalFile: proposal, completeness: false })).toEqual([]);
  });

  it('FR-CNT-02: a sign-off time that names no calendar instant is refused, and a parse error keeps its cause', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    const f = json(join(dir, 'signoffs.json'));
    for (const at of ['2026-02-30T10:00:00Z', '2026-10-31T24:00:00Z', '2026-10-31T10:60:00Z']) {
      write(join(dir, 'signoffs.json'), { records: f.records.map((r: Json) => (r.batch === 'pre-processing' ? { ...r, at } : r)) });
      expect(check(dir).join('\n'), at).toMatch(new RegExp(`\\(pre-processing\\): at "${at}" is not`));
    }
    const notJson = join(tempDir(), 'proposal.json'); writeFileSync(notJson, '{"status":');
    expect(check(dir, { proposalFile: notJson, completeness: false }).join('\n')).toMatch(/proposal.*not valid JSON \(.+\)/);
  });

  it('FR-CNT-01 FR-CNT-02: a release checks the approved question set: a proposal that is present but not approved is a problem with completeness only', () => {
    const dir = completeCopy('0.0.1-fixture'); signAll(dir);
    const pending = writeProposal({ status: 'revised' });
    expect(check(dir, { proposalFile: pending, completeness: false })).toEqual([]);
    expect(check(dir, { proposalFile: pending })).toEqual([expect.stringMatching(/proposal .* has status revised, not approved/)]);
  });

  it('FR-CNT-02: signOffPayload names the question whose evidence examples are not a list', () => {
    const dir = copyFixture('0.0.1-fixture');
    editQuestion(dir, 'Q-PO-02', (q) => ({ ...q, evidenceExamples: 'one' }));
    expect(() => signOffPayload(loadDir(dir), 'post-processing')).toThrow(/Q-PO-02.*evidenceExamples/);
  });

  it('FR-CNT-01: the committed 5.0.0 starting files are valid without completeness', () => {
    expect(validateContentVersion('data/content/5.0.0', { baselineDir: 'data', proposalFile: null, completeness: false })).toEqual([]);
  });

  it('FR-CNT-02 NFR-SEC-11: the checker reads only with turbopackIgnore and no runtime module imports it', () => {
    const v = readFileSync('lib/content/validate.ts', 'utf8');
    expect(v.match(/readFileSync\((?!\/\*turbopackIgnore: true\*\/)/g) ?? []).toEqual([]);
    expect(v).not.toMatch(/computeVersionBundleHash|contentRoot\(/);
    expect(execSync('grep -rln "@/lib/content/validate" app components lib --include=*.ts --include=*.tsx || true').toString().trim()).toBe('');
  });
});
