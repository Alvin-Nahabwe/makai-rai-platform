/**
 * Content tests of the 5.0.0 texts that CNT's validateContentVersion does not check (CW-03; units/C-TXT.md Task 8).
 * QC-01's lengths and sentence limits, QC-02's coverage and the basic QC-06 rule are CNT's (lib/content/validate.ts).
 * No test here asserts a question count: counts are read from the content (call R-62).
 *
 * This file reads the real bundle (contract "Content bundle", the fixture rule: only CNT and C-TXT call loadContent
 * on it). "New text" is every expected practice, "why this is asked", reason prompt and evidence example, and every
 * stem, help text and example that differs from v0.5.0 (`data/questionBank.json`, the d13be0c bank).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { scanLines } from '@/__tests__/helpers/logCapture';
import { REVIEWED_CLAIM_NAMES, claimBearingNames, claimsOutsideNames, frameworkNames, readFrameworkNames } from '@/__tests__/helpers/frameworkNames';
import { questionsIn } from '@/__tests__/helpers/contentQuestions';
import { applyTexts, type StageTexts } from '@/scripts/content/apply-texts';
import { STAGES, type Stage } from '@/types/record';
import { loadContent, reasonCodesFor } from '@/lib/content/loader';
import { CONTENT_BUNDLE_FILES } from '@/lib/content/bundleHash';
import type { LoadedQuestion, ReasonCodeEntry } from '@/types/content';
import { sentences, words } from './helpers/text';

vi.unmock('@/lib/content/root');

const c = loadContent('5.0.0');
// The framework's own area and control names, exempt where they appear verbatim (coordinator ruling, 5 Nov 2026,
// on the owner's sitting 2 answer T4 "allow"); read from the 5.0.0 file at test time.
const names = readFrameworkNames('data/content/5.0.0/assessmentAreas.json');
const claimsIn = (text: string) => claimsOutsideNames(text, names);
const questions = [...c.questions.values()];

type OldQuestion = { id: string; text: string; helpText?: string; example?: string };
const oldBank = JSON.parse(readFileSync('data/questionBank.json', 'utf8')) as { stages: Record<string, { modules: Array<{ questions: OldQuestion[] }> }> };
const old = new Map(Object.values(oldBank.stages).flatMap((s) => s.modules.flatMap((m) => m.questions)).map((q) => [q.id, q]));

/** Every new text of the bundle, named `<id>.<field>`. */
function newTexts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const q of questions) {
    const was = old.get(q.id);
    out.push({ where: `${q.id}.expectedPractice`, text: q.expectedPractice });
    out.push({ where: `${q.id}.whyAsked`, text: q.whyAsked });
    out.push({ where: `${q.id}.reasonPrompt`, text: q.reasonPrompt });
    q.evidenceExamples.forEach((e, i) => out.push({ where: `${q.id}.evidenceExamples[${i}]`, text: e }));
    if (was === undefined || q.text !== was.text) out.push({ where: `${q.id}.text`, text: q.text });
    if (q.helpText !== undefined && q.helpText !== was?.helpText) out.push({ where: `${q.id}.helpText`, text: q.helpText });
    if (q.example !== undefined && q.example !== was?.example) out.push({ where: `${q.id}.example`, text: q.example });
  }
  return out;
}

/** Every string field of every question, named `<id>.<field>`. */
function allQuestionStrings(q: LoadedQuestion): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const add = (field: string, v: unknown) => {
    if (typeof v === 'string') out.push({ field, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => add(`${field}[${i}]`, x));
  };
  for (const f of ['text', 'principle', 'helpText', 'example', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples', 'options'] as const) add(f, q[f]);
  return out;
}

// SRS 10.1.5 (lines 3986-3999), transcribed: code, the status its prefix names, label, use it when, the reason must say.
// Inline code marks of the SRS (backticks) are dropped; the words are the SRS's, except na_answered_elsewhere's
// "use it when", which drops "(10.1.9)" (owner, sitting 2, 5 Nov 2026 13:29 EAT, T2: "Accept as proposed").
const SRS_REASON_CODES: ReasonCodeEntry[] = [
  {"code": "na_no_personal_data", "status": "not_applicable", "label": "No personal data is involved", "useWhen": "The project holds no information that could identify a person. Set by the platform on Q-PP-13 and Q-PP-14 when the gate is \"no\".", "reasonMustSay": "How you know: which data you checked."},
  {"code": "na_no_people_affected", "status": "not_applicable", "label": "The system makes no decisions or predictions about people", "useWhen": "Its outputs are about things (crops, roads, weather) and no person is judged by them.", "reasonMustSay": "Who uses the outputs, and why no person is affected. Use carefully: a crop model's errors still fall on farmers."},
  {"code": "na_no_deployment", "status": "not_applicable", "label": "The system will not be used beyond the research study", "useWhen": "Post-processing practices for a model that will never be deployed.", "reasonMustSay": "What would change this, for example a plan to hand the model to a ministry."},
  {"code": "na_not_this_kind_of_system", "status": "not_applicable", "label": "Does not apply to this kind of system or method", "useWhen": "For example, no labels exist, so label quality does not apply; or the system is rule-based.", "reasonMustSay": "What kind of system it is."},
  {"code": "na_answered_elsewhere", "status": "not_applicable", "label": "Answered under another question", "useWhen": "Another question already records the same practice.", "reasonMustSay": "The other question's id."},
  {"code": "na_other", "status": "not_applicable", "label": "Other", "useWhen": "None of the above.", "reasonMustSay": "Why the practice does not apply."},
  {"code": "ny_planned_later", "status": "not_yet", "label": "Planned for a later point in the project", "useWhen": "The practice belongs to a later step, for example monitoring before deployment.", "reasonMustSay": "When it is planned."},
  {"code": "ny_awaiting_ethics", "status": "not_yet", "label": "Waiting for an ethics or regulatory decision", "useWhen": "A committee or regulator must decide first.", "reasonMustSay": "Which body, and when you applied."},
  {"code": "ny_awaiting_data_access", "status": "not_yet", "label": "Waiting for data or data-access approval", "useWhen": "The data, or permission to use it, has not arrived.", "reasonMustSay": "From whom."},
  {"code": "ny_awaiting_partner", "status": "not_yet", "label": "Waiting for a partner or another team", "useWhen": "Someone outside the team must act first.", "reasonMustSay": "Who, by role."},
  {"code": "ny_needs_resources", "status": "not_yet", "label": "Needs money, computing or staff time the project does not have", "useWhen": "The team knows how but cannot pay for it or staff it now.", "reasonMustSay": "What is missing."},
  {"code": "ny_needs_skills", "status": "not_yet", "label": "Needs skills or guidance the team does not have yet", "useWhen": "The team does not yet know how. The suggestions, templates and notebooks are aimed at this case.", "reasonMustSay": "What the team needs to learn."},
  {"code": "ny_first_considered", "status": "not_yet", "label": "Not considered before this record", "useWhen": "The question raised something the team had not thought about.", "reasonMustSay": "Nothing more; this is an honest answer."},
  {"code": "ny_other", "status": "not_yet", "label": "Other", "useWhen": "None of the above.", "reasonMustSay": "Why the practice is not yet in place."}
] as ReasonCodeEntry[];

// SRS 10.3.9 (lines 4499-4501), verbatim, except mitigation_plan, reworded with the CW-02 checker's text (owner,
// sitting 2, 5 Nov 2026 13:29 EAT, T1: "Accept as proposed"): no "ratings", and no sentence over 30 words.
const SRS_DOCUMENT_HELP = {
  data_card: 'Teams use this as the description of the data in a data transfer agreement, or as dataset documentation for a conference or repository. Check what your requester asks for.',
  model_card: "Teams paste this into a model card on a repository such as Hugging Face, or use it to answer a venue's checklist. It informs, but does not replace, a regulator's technical file.",
  mitigation_plan: 'Teams use this where a protocol, a data protection impact assessment or a funder asks for the risks and the measures against them. A plan from a later seal can go with an annual renewal or an amendment. The platform does not estimate likelihood or impact: if your template asks for them, add them outside the platform.',
};

// SRS 10.1.6 (line 4015), the gate's expected practice, verbatim.
const GATE_PRACTICE = 'The team checked every field and file it will hold, including free text, images and audio, for anything that could identify a person directly or in combination with other data, and recorded the answer.';

describe('content 5.0.0 texts', () => {
  it('reads every question of the bundle and some new text', () => {
    expect(questions.length).toBeGreaterThan(0);
    expect(newTexts().length).toBeGreaterThan(questions.length * 4);
  });

  it("QC-01: the gate's expected practice describes the check (10.1.6)", () => {
    const gates = questions.filter((q) => q.type === 'gate');
    for (const g of gates) expect(g.expectedPractice, g.id).toBe(GATE_PRACTICE);
  });

  it('QC-03 FR-PUB-01: no new text holds a dash, a curly quote, "e.g.", "i.e." or a claim', () => {
    const bad = newTexts().filter((t) => /[–—‘’“”]/.test(t.text) || /\b(e\.g|i\.e)\./i.test(t.text));
    expect(bad.map((t) => `${t.where}: ${t.text}`)).toEqual([]);
    const claims = newTexts().filter((t) => claimsIn(t.text).length > 0);
    expect(claims.map((t) => `${t.where}: ${claimsIn(t.text).map((m) => m.text).join(', ')}`)).toEqual([]);
  });

  it('QC-03 FR-PUB-01: no question string holds a claim outside the allow-list, read as the lint reads it (AL-7 stems by id, exact path entries)', () => {
    // The lint's rule (C4 F6): an { id } entry exempts only that question's text; a { path, text } entry exempts only
    // the string at that path with exactly that text (for example Q-PO-11's three options). Nothing else is skipped.
    const allowlist = JSON.parse(readFileSync('__tests__/lint/claim-allowlist.json', 'utf8')) as Array<{ id?: string; path?: string; text?: string }>;
    const allowedStems = new Set(allowlist.flatMap((e) => (typeof e.id === 'string' ? [e.id] : [])));
    const pathEntries = new Map(allowlist.flatMap((e) => (typeof e.path === 'string' && typeof e.text === 'string' ? [[e.path, e.text] as const] : [])));
    const bankRaw = JSON.parse(readFileSync('data/content/5.0.0/questionBank.json', 'utf8')) as unknown;
    const pathOf = new Map(questionsIn(bankRaw).map(({ q, path }) => [q.id as string, path]));
    const hits: string[] = [];
    for (const q of questions) {
      for (const s of allQuestionStrings(q)) {
        if (s.field === 'text' && allowedStems.has(q.id)) continue;
        if (pathEntries.get(`questionBank.json#${pathOf.get(q.id)}.${s.field}`) === s.text) continue;
        if (claimsIn(s.text).length > 0) hits.push(`${q.id}.${s.field}: ${s.text}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('QC-03 FR-PUB-01 (C4 CR-1, SEC-1): the framework names carrying a claim word are exactly the three reviewed ones, and a new one is not exempt', () => {
    expect([...claimBearingNames(names)].sort()).toEqual([...REVIEWED_CLAIM_NAMES].sort());
    const planted = frameworkNames({ areas: [{ name: 'Model Robustness Failure' }, { name: 'Audit-Ready Certification' }], controls: [{ name: 'Fine' }] });
    expect(claimBearingNames(planted)).toEqual(['Model Robustness Failure', 'Audit-Ready Certification']);
    expect(claimBearingNames(planted).filter((n) => !REVIEWED_CLAIM_NAMES.includes(n))).toEqual(['Audit-Ready Certification']);
    expect(claimsOutsideNames('Risk area: Audit-Ready Certification.', planted).map((m) => m.text)).toEqual(['Audit-Ready', 'Certification']);
    expect(claimsOutsideNames('Risk area: Model Robustness Failure.', planted)).toEqual([]);
  });

  it('CW-03 (C4 SPEC-1): apply-texts on the committed bank changes nothing, and a stray or missing entry is refused', () => {
    const bank = JSON.parse(readFileSync('data/content/5.0.0/questionBank.json', 'utf8')) as Parameters<typeof applyTexts>[0];
    const texts = Object.fromEntries(STAGES.map((st) => [st, JSON.parse(readFileSync(`docs/content/texts-5.0.0/${st}.json`, 'utf8')) as StageTexts])) as Record<Stage, StageTexts>;
    expect(applyTexts(bank, texts)).toEqual(bank);
    const stray = structuredClone(texts);
    stray['pre-processing']['Q-PP-99'] = stray['pre-processing']['Q-PP-01'];
    expect(() => applyTexts(bank, stray)).toThrow(/Q-PP-99/);
    const missing = structuredClone(texts);
    delete missing['in-processing']['Q-IP-01'];
    expect(() => applyTexts(bank, missing)).toThrow(/Q-IP-01 has no entry/);
  });

  it('QC-03 FR-PUB-01 SRS 7.5.5: only a verbatim framework name is exempt; a non-name "failure" in a why-asked text is still caught', () => {
    expect(names).toEqual(expect.arrayContaining(['Model Robustness Failure', 'Reproducibility Failure']));
    // The real texts that name a Failure area hold it verbatim, and nothing else in them is a claim.
    const naming = questions.filter((q) => /Robustness Failure|Reproducibility Failure/.test(q.whyAsked));
    expect(naming.length).toBeGreaterThan(0);
    for (const q of naming) expect(claimsIn(q.whyAsked), q.id).toEqual([]);
    // The same text with a non-name "failure" added, or the name altered, is a hit.
    const ending = 'Risk area: Model Robustness Failure.';
    expect(claimsIn(`A model can fail in use without warning. ${ending}`).map((m) => m.text)).toEqual(['fail']);
    expect(claimsIn('One failure goes unseen. Risk area: Reproducibility Failure.').map((m) => m.text)).toEqual(['failure']);
    expect(claimsIn('Risk area: model robustness failure.').map((m) => m.text)).toEqual(['failure']);
    expect(claimsIn('Risk areas: Model Robustness Failures.').map((m) => m.text)).toEqual(['Failures']);
  });

  it('QC-03 NFR-SEC-11: no text holds markup: questions, module titles and descriptions, reason codes and document help lines', () => {
    const markup = (t: string) => /[<>]|javascript:/i.test(t);
    const marked = questions.flatMap((q) => allQuestionStrings(q).filter((s) => markup(s.text)).map((s) => `${q.id}.${s.field}`));
    // C4 SEC-2: the other user-facing hashed texts.
    const bankRaw = JSON.parse(readFileSync('data/content/5.0.0/questionBank.json', 'utf8')) as { stages: Record<string, { modules: Array<Record<string, unknown>> }> };
    const modules = Object.values(bankRaw.stages).flatMap((st) => st.modules);
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) {
      for (const f of ['title', 'description'] as const) if (typeof m[f] !== 'string' || markup(m[f] as string)) marked.push(`module ${String(m.id)}.${f}`);
    }
    expect(c.reasonCodes.length).toBeGreaterThan(0);
    for (const r of c.reasonCodes) for (const f of ['label', 'useWhen', 'reasonMustSay'] as const) if (markup(r[f])) marked.push(`reasonCode ${r.code}.${f}`);
    const help = Object.entries(c.documentHelp);
    expect(help.length).toBe(3);
    for (const [k, v] of help) if (typeof v !== 'string' || markup(v)) marked.push(`documentHelp ${k}`);
    expect(marked).toEqual([]);
    expect(markup('<b>x</b>') && markup('javascript:alert(1)'), 'the check itself').toBe(true);
  });

  const maps = ['data_card', 'model_card'].map((d) => `data/fieldmaps/${d}.json`);
  it.skipIf(!maps.every((m) => existsSync(m)))('QC-04 W10: every question a field map reads names its document in its reason prompt', () => {
    for (const [file, doc] of [[maps[0], /data card/i], [maps[1], /model card/i]] as const) {
      const map = JSON.parse(readFileSync(file, 'utf8')) as { fields: Array<{ fieldId: string; sources: Array<{ kind: string; questionId?: string; option?: string }> }> };
      for (const f of map.fields) {
        for (const s of f.sources) {
          if (s.kind !== 'record' && s.kind !== 'record_option') continue;
          const q = c.questions.get(s.questionId ?? '');
          expect(q, `${file} ${f.fieldId} reads ${s.questionId}`).toBeDefined();
          expect(q?.reasonPrompt, `${s.questionId} (${f.fieldId})`).toMatch(doc);
          if (s.kind === 'record_option') expect(q?.options ?? [], `${f.fieldId} option ${s.option}`).toContain(s.option);
        }
      }
    }
  });

  it('QC-05: the reason codes are the 14 of SRS 10.1.5 in a hashed file, and na_no_personal_data is a not-applicable code', () => {
    expect(CONTENT_BUNDLE_FILES).toContain('reasonCodes.json');
    expect(c.reasonCodes.map(({ code, status, label, useWhen, reasonMustSay }) => ({ code, status, label, useWhen, reasonMustSay }))).toEqual(SRS_REASON_CODES);
    expect(reasonCodesFor(c, 'not_applicable').map((r) => r.code)).toContain('na_no_personal_data');
  });

  it('QC-05 FR-DOC-01: the three document help lines are those of SRS 10.3.9', () => {
    expect(CONTENT_BUNDLE_FILES).toContain('documentHelp.json');
    expect({ ...c.documentHelp }).toEqual(SRS_DOCUMENT_HELP);
  });

  it('QC-06 FR-CNT-06: kept follow-up help texts do not assume an earlier shortfall', () => {
    // OD-08 (owner, 5 Nov 2026): all six follow-ups were merged, so 5.0.0 holds none and the rule below checks nothing.
    // The first assertion makes that a stated fact rather than an accident.
    const followUps = questions.filter((q) => /-EXTRA-/.test(q.id));
    expect(followUps.map((q) => q.id)).toEqual([]);
    for (const q of followUps) {
      for (const t of [q.helpText, q.example]) {
        if (t === undefined) continue;
        expect(t, q.id).not.toMatch(/^(When|If|Unless)\b/);
        expect(sentences(t)[0] ?? '', q.id).not.toMatch(/\b(was|were) not\b|\bwere absent\b|\blacks?\b|\bwithout pre-/i);
      }
    }
  });

  it('QC-08 W8: no sentence of new text is longer than 30 words, except the gate text SRS 10.1.6 fixes verbatim', () => {
    // The gate's expected practice is SRS line 4015 word for word (QC-01 above), one sentence of 34 words.
    const long = newTexts().filter((t) => t.text !== GATE_PRACTICE).flatMap((t) => sentences(t.text).filter((s) => words(s) > 30).map((s) => `${t.where} (${words(s)} words): ${s}`));
    expect(long).toEqual([]);
  });

  it('W9 NFR-PRIV-03: no new text holds an email address or a phone number', () => {
    const texts = newTexts().map((t) => t.text);
    expect(scanLines(texts, { markers: false, emails: true })).toEqual([]);
    expect(texts.filter((t) => /\+?\d[\d\s-]{8,}\d/.test(t))).toEqual([]);
  });
});

describe('text helpers', () => {
  it('sentences splits where CNT counts a sentence end, and words counts runs of non-space', () => {
    expect(sentences('One. Two? Three!')).toEqual(['One.', 'Two?', 'Three!']);
    expect(sentences('Use 0.5 here. Then stop...')).toEqual(['Use 0.5 here.', 'Then stop...']);
    expect(sentences('')).toEqual([]);
    expect(words('a  b\tc')).toBe(3);
  });
});
