// node __tests__/fixtures/content/generate.mjs
//
// Writes the fixture content bundle next to this file: index.json and one directory per fixture version
// (0.0.1-fixture, 0.0.2-fixture) in the format of data/content/<semver>/ (contract "Content bundle").
// The output is committed, and a second run leaves `git status` clean.
//
// Why a fixture. Every test that names a question id runs on a bundle that holds that id, never on the real
// 5.0.0 content, so no test depends on which ids the question-set revision keeps. The fixture therefore holds
// the 78 question ids of v0.5.0, the 21 areas and the 28 controls, in the 5.0.0 file shape, with generated
// texts of the lengths FR-CNT-02 allows.
//
// Inputs. It reads data/questionBank.json, data/assessmentAreas.json and data/projectConfig.json, which at
// v0.5.0 hold content version 4.0.0. It refuses to run once they hold anything else (the 5.0.0 revision moves
// them), because a regenerated fixture would then follow the revision. The committed output is the fixture of
// record from that point on.
//
// The two versions differ only in the `text` and `expectedPractice` of Q-PP-01, Q-PP-12 and Q-IP-05 (and
// `meta.version`), for the tests of FR-CNT-07 and FR-CNT-08 that need a second bundle with changed wording.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const readData = (name) => JSON.parse(readFileSync(join(repo, 'data', name), 'utf8'));

const VERSIONS = ['0.0.1-fixture', '0.0.2-fixture'];
const REVISED = ['Q-PP-01', 'Q-PP-12', 'Q-IP-05']; // the three questions whose wording differs in 0.0.2-fixture
const GATE = 'Q-PP-GATE-SENSITIVE';

const bank = readData('questionBank.json');
const areasSource = readData('assessmentAreas.json');
const projectConfig = readData('projectConfig.json');

const questionCount = Object.values(bank.stages).flatMap((s) => s.modules).flatMap((m) => m.questions).length;
if (bank.meta.version !== '4.0.0' || bank.meta.totalQuestions !== 78 || questionCount !== 78 || areasSource.areas.length !== 21 || areasSource.controls.length !== 28) {
  console.error('generate.mjs: data/ no longer holds the v0.5.0 content (4.0.0, 78 questions, 21 areas, 28 controls); the committed fixture is the fixture of record');
  process.exit(1);
}

function question(q, semver) {
  const id = q.id;
  const revised = semver === '0.0.2-fixture' && REVISED.includes(id);
  const out = { id, type: q.type, text: revised ? `Revised in ${semver}: ${q.text}` : q.text, principle: q.principle };
  // The gate's answers are yes, no and not sure (FR-CNT-04), not the two option strings of v0.5.0.
  if (q.options && id !== GATE) out.options = q.options;
  out.gaps = q.gaps;
  if (q.optionGapMap) out.optionGapMap = q.optionGapMap;
  // 5.0.0 keeps a condition only on the two questions that depend on the gate; Q-IP-06 loses its v0.5.0 one.
  if (id === 'Q-PP-13' || id === 'Q-PP-14') out.condition = { questionId: GATE, value: 'yes' };
  if (q.helpText) out.helpText = q.helpText;
  if (q.example) out.example = q.example;
  out.expectedPractice = revised
    ? `Fixture expected practice for ${id}, revised in 0.0.2: the team records what it does, where and when.`
    : `Fixture expected practice for ${id}: the team records what it does and where.`;
  out.whyAsked = `Fixture reason for asking ${id}: it shows where the team stands.`;
  out.reasonPrompt = `Fixture reason prompt for ${id}: say what was done and why. Name who can confirm it.`;
  out.evidenceExamples = [`Fixture evidence example 1 for ${id}`, `Fixture evidence example 2 for ${id}`];
  return out;
}

function questionBank(semver) {
  const stages = {};
  for (const [stage, { modules }] of Object.entries(bank.stages)) {
    stages[stage] = {
      modules: modules.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        momentsOfBias: m.momentsOfBias,
        questions: m.questions.map((q) => question(q, semver)),
      })),
    };
  }
  return { meta: { version: semver, totalQuestions: 78, estimatedCompletionMinutes: bank.meta.estimatedCompletionMinutes }, stages };
}

function areas(semver) {
  return {
    meta: { ...areasSource.meta, version: semver },
    areas: areasSource.areas,
    // Availability of a notebook or template lives outside the hashed content (FR-CNT-05).
    controls: areasSource.controls.map(({ notebook, template, ...control }) => control),
  };
}

// SRS 10.1.5: the 14 reason codes, with their labels, "Use it when" and "The reason must say" text.
const REASON_CODES = [
  ['na_no_personal_data', 'No personal data is involved', 'The project holds no information that could identify a person. Set by the platform on Q-PP-13 and Q-PP-14 when the gate is "no".', 'How you know: which data you checked.'],
  ['na_no_people_affected', 'The system makes no decisions or predictions about people', 'Its outputs are about things (crops, roads, weather) and no person is judged by them.', "Who uses the outputs, and why no person is affected. Use carefully: a crop model's errors still fall on farmers."],
  ['na_no_deployment', 'The system will not be used beyond the research study', 'Post-processing practices for a model that will never be deployed.', 'What would change this, for example a plan to hand the model to a ministry.'],
  ['na_not_this_kind_of_system', 'Does not apply to this kind of system or method', 'For example, no labels exist, so label quality does not apply; or the system is rule-based.', 'What kind of system it is.'],
  ['na_answered_elsewhere', 'Answered under another question', 'A near-duplicate already records the same practice (10.1.9).', "The other question's id."],
  ['na_other', 'Other', 'None of the above.', 'Why the practice does not apply.'],
  ['ny_planned_later', 'Planned for a later point in the project', 'The practice belongs to a later step, for example monitoring before deployment.', 'When it is planned.'],
  ['ny_awaiting_ethics', 'Waiting for an ethics or regulatory decision', 'A committee or regulator must decide first.', 'Which body, and when you applied.'],
  ['ny_awaiting_data_access', 'Waiting for data or data-access approval', 'The data, or permission to use it, has not arrived.', 'From whom.'],
  ['ny_awaiting_partner', 'Waiting for a partner or another team', 'Someone outside the team must act first.', 'Who, by role.'],
  ['ny_needs_resources', 'Needs money, computing or staff time the project does not have', 'The team knows how but cannot pay for it or staff it now.', 'What is missing.'],
  ['ny_needs_skills', 'Needs skills or guidance the team does not have yet', 'The team does not yet know how. The suggestions, templates and notebooks are aimed at this case.', 'What the team needs to learn.'],
  ['ny_first_considered', 'Not considered before this record', 'The question raised something the team had not thought about.', 'Nothing more; this is an honest answer.'],
  ['ny_other', 'Other', 'None of the above.', 'Why the practice is not yet in place.'],
];
const reasonCodes = {
  codes: REASON_CODES.map(([code, label, useWhen, reasonMustSay]) => ({
    code,
    status: code.startsWith('na_') ? 'not_applicable' : 'not_yet',
    label,
    useWhen,
    reasonMustSay,
  })),
};

const documentHelp = {
  data_card: 'Fixture help for the data card: describe the data the system learns from.',
  model_card: 'Fixture help for the model card: describe what the model does and where it stops working.',
  mitigation_plan: 'Fixture help for the mitigation plan: list each finding and what the team will do about it.',
};

const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

write(join(here, 'index.json'), { running: VERSIONS[0], versions: VERSIONS });
for (const semver of VERSIONS) {
  const dir = join(here, semver);
  write(join(dir, 'assessmentAreas.json'), areas(semver));
  write(join(dir, 'projectConfig.json'), projectConfig);
  write(join(dir, 'questionBank.json'), questionBank(semver));
  write(join(dir, 'reasonCodes.json'), reasonCodes);
  write(join(dir, 'documentHelp.json'), documentHelp);
  write(join(dir, 'signoffs.json'), { records: [] });
}
