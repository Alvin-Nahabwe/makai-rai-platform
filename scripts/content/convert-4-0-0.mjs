#!/usr/bin/env node
/**
 * One-time conversion of the 4.0.0 content files into the starting files of content 5.0.0.
 *
 * Kept in the repository for review only: no test re-runs it, because the content workstream
 * (C-TXT, C-RES, C-TPL, C-NB) edits its output afterwards. It refuses to run when any output
 * file already exists, so running it again cannot overwrite those edits.
 *
 * Run from anywhere: `node scripts/content/convert-4-0-0.mjs`. No dependency.
 *
 * Every input is read and checked, and every output built, before the first write. A check
 * that fails stops the run with exit 1 and writes nothing. Each file is created with the 'wx'
 * flag (fails if it exists); if a write fails, the files this run created, including one it only part-wrote, are removed again.
 *
 * What it writes, each as `JSON.stringify(value, null, 2) + '\n'`:
 *   data/content/index.json                { running: '5.0.0', versions: ['5.0.0'] }
 *   data/content/5.0.0/questionBank.json   data/questionBank.json with the changes of SRS 10.1.1:
 *                                          meta is { version: '5.0.0' }; no weight, scale or
 *                                          crossStageCondition; no condition on Q-IP-06
 *                                          (FR-CNT-06); condition.value 'yes' on Q-PP-13 and
 *                                          Q-PP-14; no options on the gate Q-PP-GATE-SENSITIVE
 *                                          (FR-CNT-04); empty expectedPractice, whyAsked,
 *                                          reasonPrompt and evidenceExamples for C-TXT to fill
 *   data/content/5.0.0/assessmentAreas.json  data/assessmentAreas.json with meta.version '5.0.0'
 *                                          and no notebook or template field on any control
 *                                          (FR-CNT-05: availability is release data, recorded in
 *                                          data/resources.json once a file passes its review; the
 *                                          4.0.0 paths are not carried over)
 *   data/content/5.0.0/projectConfig.json  the bytes of data/projectConfig.json, unchanged
 *   data/content/5.0.0/reasonCodes.json    the 14 rows of SRS 10.1.5 (lines 3986-3999)
 *   data/content/5.0.0/documentHelp.json   the three help lines of SRS 10.3.9 (lines 4499-4501)
 *   data/content/5.0.0/signoffs.json       { records: [] }
 *   data/resources.json                    { templates: [], notebooks: [] }
 *
 * The 4.0.0 files at data/ stay in place: the frozen assessments pin 4.0.0 (SRS 11.3 item 7).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'content', '5.0.0');

const GATE = 'Q-PP-GATE-SENSITIVE';
const GATE_DEPENDENT = ['Q-PP-13', 'Q-PP-14'];
const UNCONDITIONED = 'Q-IP-06';

/** SRS 10.1.5, lines 3986-3999, in table order. The SRS marks the question ids as code; the marks are dropped here. */
const REASON_CODES = [
  { code: 'na_no_personal_data', label: 'No personal data is involved', useWhen: 'The project holds no information that could identify a person. Set by the platform on Q-PP-13 and Q-PP-14 when the gate is "no".', reasonMustSay: 'How you know: which data you checked.' },
  { code: 'na_no_people_affected', label: 'The system makes no decisions or predictions about people', useWhen: 'Its outputs are about things (crops, roads, weather) and no person is judged by them.', reasonMustSay: "Who uses the outputs, and why no person is affected. Use carefully: a crop model's errors still fall on farmers." },
  { code: 'na_no_deployment', label: 'The system will not be used beyond the research study', useWhen: 'Post-processing practices for a model that will never be deployed.', reasonMustSay: 'What would change this, for example a plan to hand the model to a ministry.' },
  { code: 'na_not_this_kind_of_system', label: 'Does not apply to this kind of system or method', useWhen: 'For example, no labels exist, so label quality does not apply; or the system is rule-based.', reasonMustSay: 'What kind of system it is.' },
  { code: 'na_answered_elsewhere', label: 'Answered under another question', useWhen: 'A near-duplicate already records the same practice (10.1.9).', reasonMustSay: "The other question's id." },
  { code: 'na_other', label: 'Other', useWhen: 'None of the above.', reasonMustSay: 'Why the practice does not apply.' },
  { code: 'ny_planned_later', label: 'Planned for a later point in the project', useWhen: 'The practice belongs to a later step, for example monitoring before deployment.', reasonMustSay: 'When it is planned.' },
  { code: 'ny_awaiting_ethics', label: 'Waiting for an ethics or regulatory decision', useWhen: 'A committee or regulator must decide first.', reasonMustSay: 'Which body, and when you applied.' },
  { code: 'ny_awaiting_data_access', label: 'Waiting for data or data-access approval', useWhen: 'The data, or permission to use it, has not arrived.', reasonMustSay: 'From whom.' },
  { code: 'ny_awaiting_partner', label: 'Waiting for a partner or another team', useWhen: 'Someone outside the team must act first.', reasonMustSay: 'Who, by role.' },
  { code: 'ny_needs_resources', label: 'Needs money, computing or staff time the project does not have', useWhen: 'The team knows how but cannot pay for it or staff it now.', reasonMustSay: 'What is missing.' },
  { code: 'ny_needs_skills', label: 'Needs skills or guidance the team does not have yet', useWhen: 'The team does not yet know how. The suggestions, templates and notebooks are aimed at this case.', reasonMustSay: 'What the team needs to learn.' },
  { code: 'ny_first_considered', label: 'Not considered before this record', useWhen: 'The question raised something the team had not thought about.', reasonMustSay: 'Nothing more; this is an honest answer.' },
  { code: 'ny_other', label: 'Other', useWhen: 'None of the above.', reasonMustSay: 'Why the practice is not yet in place.' },
].map(({ code, label, useWhen, reasonMustSay }) => ({
  code,
  status: code.startsWith('na_') ? 'not_applicable' : 'not_yet',
  label,
  useWhen,
  reasonMustSay,
}));

/** SRS 10.3.9, lines 4499-4501; the table quotes each text, the quotes are not part of it. */
const DOCUMENT_HELP = {
  data_card: 'Teams use this as the description of the data in a data transfer agreement, or as dataset documentation for a conference or repository. Check what your requester asks for.',
  model_card: "Teams paste this into a model card on a repository such as Hugging Face, or use it to answer a venue's checklist. It informs, but does not replace, a regulator's technical file.",
  mitigation_plan: 'Teams use this where a protocol, a data protection impact assessment or a funder asks for the risks and the measures against them; a plan from a later seal can go with an annual renewal or an amendment. The platform gives no ratings: if your template asks for likelihood and impact, add them outside the platform.',
};

/** In write order; the write list below is checked against it. */
const outputs = [
  ...['questionBank.json', 'assessmentAreas.json', 'projectConfig.json', 'reasonCodes.json', 'documentHelp.json', 'signoffs.json'].map((f) => join(OUT, f)),
  join(DATA, 'content', 'index.json'),
  join(DATA, 'resources.json'),
];
const present = outputs.filter((p) => existsSync(p));
if (present.length > 0) {
  console.error(`convert-4-0-0: refusing to overwrite existing output:\n  ${present.join('\n  ')}`);
  process.exit(1);
}

const fail = (msg) => {
  console.error(`convert-4-0-0: ${msg}`);
  process.exit(1);
};
const readJson = (file) => {
  const raw = readFileSync(join(DATA, file), 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fail(`data/${file} is not JSON: ${e.message}`);
  }
};
const text = (value) => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NEW_FIELDS = ['expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples'];

// data/questionBank.json -> questionBank.json
const bank = readJson('questionBank.json');
if (!same(Object.keys(bank), ['meta', 'stages'])) fail(`data/questionBank.json top-level keys are ${JSON.stringify(Object.keys(bank))}, expected ["meta","stages"]`);
if (bank.meta?.version !== '4.0.0') fail(`data/questionBank.json meta.version is ${JSON.stringify(bank.meta?.version)}, expected "4.0.0"`);
bank.meta = { version: '5.0.0' };
const seen = new Set();
for (const stage of Object.values(bank.stages)) {
  for (const mod of stage.modules) {
    for (const q of mod.questions) {
      const at = `data/questionBank.json ${q.id}`;
      if (seen.has(q.id)) fail(`${at} appears twice`);
      seen.add(q.id);
      for (const k of NEW_FIELDS) if (k in q) fail(`${at} already has ${k}`);
      delete q.weight;
      delete q.scale;
      delete q.crossStageCondition;
      if (q.id === UNCONDITIONED) {
        if (!same(q.condition, { questionId: 'Q-IP-05', minValue: 1 })) fail(`${at} condition is ${JSON.stringify(q.condition)}, expected {"questionId":"Q-IP-05","minValue":1}`);
        delete q.condition;
      }
      if (GATE_DEPENDENT.includes(q.id)) {
        if (!same(q.condition, { questionId: GATE, value: 'Yes' })) fail(`${at} condition is ${JSON.stringify(q.condition)}, expected {"questionId":"${GATE}","value":"Yes"}`);
        q.condition.value = 'yes';
      }
      if (q.type === 'gate') {
        if (q.id !== GATE) fail(`${at} is a second gate`);
        // The 'Yes' -> 'yes' rewrite above reads the gate's answers; they must be the two 4.0.0 ones.
        if (!same(q.options, ['Yes', 'No'])) fail(`${at} options are ${JSON.stringify(q.options)}, expected ["Yes","No"]`);
        if (!same(q.gaps, []) || 'optionGapMap' in q) fail(`${at} carries a risk-area mapping`);
        delete q.options;
      }
      if (q.condition && !GATE_DEPENDENT.includes(q.id)) fail(`${at} keeps a condition ${JSON.stringify(q.condition)}`);
      q.expectedPractice = '';
      q.whyAsked = '';
      q.reasonPrompt = '';
      q.evidenceExamples = [];
    }
  }
}
for (const id of [GATE, UNCONDITIONED, ...GATE_DEPENDENT]) if (!seen.has(id)) fail(`data/questionBank.json has no ${id}`);

// data/assessmentAreas.json -> assessmentAreas.json
const areas = readJson('assessmentAreas.json');
if (areas.meta?.version !== '4.0.0') fail(`data/assessmentAreas.json meta.version is ${JSON.stringify(areas.meta?.version)}, expected "4.0.0"`);
if (!Array.isArray(areas.controls) || areas.controls.length === 0) fail('data/assessmentAreas.json has no controls');
areas.meta.version = '5.0.0';
for (const control of areas.controls) {
  delete control.notebook;
  delete control.template;
}

// data/projectConfig.json is copied byte for byte, after a check that it parses.
const projectConfig = readFileSync(join(DATA, 'projectConfig.json'));
try {
  JSON.parse(projectConfig.toString('utf8'));
} catch (e) {
  fail(`data/projectConfig.json is not JSON: ${e.message}`);
}

const files = [
  [join(OUT, 'questionBank.json'), text(bank)],
  [join(OUT, 'assessmentAreas.json'), text(areas)],
  [join(OUT, 'projectConfig.json'), projectConfig],
  [join(OUT, 'reasonCodes.json'), text({ codes: REASON_CODES })],
  [join(OUT, 'documentHelp.json'), text(DOCUMENT_HELP)],
  [join(OUT, 'signoffs.json'), text({ records: [] })],
  [join(DATA, 'content', 'index.json'), text({ running: '5.0.0', versions: ['5.0.0'] })],
  [join(DATA, 'resources.json'), text({ templates: [], notebooks: [] })],
];
if (files.length !== outputs.length || files.some(([p], i) => p !== outputs[i])) fail('the output list and the files written differ');

mkdirSync(OUT, { recursive: true });
const written = [];
try {
  for (const [path, body] of files) {
    // Listed before the write: 'wx' creates the file before it writes, so a write that fails partway has already
    // made it and the rollback below must remove it too. A failure with EEXIST made nothing (the file was there
    // already, created by someone else after the check above), so that one is not ours to remove.
    written.push(path);
    try {
      writeFileSync(path, body, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') written.pop();
      throw e;
    }
  }
} catch (e) {
  const left = [];
  for (const path of written) {
    try {
      rmSync(path);
    } catch {
      left.push(path);
    }
  }
  fail(`write failed (${e.message}); removed the ${written.length - left.length} file(s) this run had written` +
    (left.length > 0 ? `; could not remove, delete by hand:\n  ${left.join('\n  ')}` : ''));
}
console.log(`convert-4-0-0: wrote ${written.length} files`);
