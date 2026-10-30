/**
 * Command line of the question-set coverage check (SRS 10.1.0 step 2, CW-00).
 *
 *   npx tsx scripts/content/question-set-coverage.ts \
 *     --bank <questionBank.json> --areas <assessmentAreas.json> --proposal <proposal.json> \
 *     --fieldmaps <dir of field-map JSON files> [--srs <the SRS markdown>]
 *
 * Prints `FAIL <reason>` and `LIST <item>` lines and exits 1 on any FAIL. `--bank` is the v0.5.0 file the
 * proposal revises (`git show d13be0c:data/questionBank.json`); its SHA-256 must equal `proposal.base.sha256`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  baseQuestions,
  checkCoverage,
  DOCUMENT_TYPES,
  isMainModule,
  questionControlPairs,
  readFieldMaps,
  reviseQuestions,
  revisedQuestionControlPairs,
  scanSrsIds,
  scanSrsSections,
  STAGES,
  type CoverageAreas,
  type CoverageBank,
} from './coverage';
import type { QuestionSetProposal } from './types';

const FLAGS = ['--bank', '--areas', '--proposal', '--fieldmaps', '--srs'] as const;
const REQUIRED = ['--bank', '--areas', '--proposal', '--fieldmaps'] as const;

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown argument ${flag}`);
    if (args.has(flag)) throw new Error(`${flag} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    args.set(flag, value);
  }
  for (const flag of REQUIRED) if (!args.has(flag)) throw new Error(`missing ${flag}`);
  return args;
}

export function runCli(argv: string[]): { lines: string[]; exitCode: number } {
  const args = parseArgs(argv);
  const bankBytes = readFileSync(args.get('--bank') as string);
  const bank = JSON.parse(bankBytes.toString('utf8')) as CoverageBank;
  const areasBytes = readFileSync(args.get('--areas') as string);
  const areas = JSON.parse(areasBytes.toString('utf8')) as CoverageAreas;
  const proposal = JSON.parse(readFileSync(args.get('--proposal') as string, 'utf8')) as QuestionSetProposal;
  const maps = readFieldMaps(args.get('--fieldmaps') as string);
  const srsPath = args.get('--srs');
  const srsText = srsPath === undefined ? undefined : readFileSync(srsPath, 'utf8');

  const heads: string[] = [];
  const fails: string[] = [];
  const results: string[] = [];

  // The proposal revises one exact input.
  const bankSha = createHash('sha256').update(bankBytes).digest('hex');
  if (bankSha !== proposal.base.sha256) {
    fails.push(`FAIL bank file sha256 ${bankSha} is not proposal base sha256 ${proposal.base.sha256}`);
  }
  for (const type of DOCUMENT_TYPES) {
    if (!maps.some((m) => m.documentType === type)) fails.push(`FAIL no field map for ${type} in the --fieldmaps directory`);
  }

  const base = baseQuestions(bank);
  const count = (action: string): number => proposal.actions.filter((a) => a.action === action).length;
  const areasSha = createHash('sha256').update(areasBytes).digest('hex');
  heads.push(`LIST inputs bank-sha256=${bankSha} areas-sha256=${areasSha}`);
  heads.push(`LIST base questions=${base.length} areas=${areas.areas.length} controls=${areas.controls.length}`);
  heads.push(
    `LIST proposal status=${proposal.status} actions=${proposal.actions.length} keep=${count('keep')} reword=${count('reword')} ` +
      `merge=${count('merge')} cut=${count('cut')} replace=${count('replace')}`,
  );
  const fieldCount = maps.reduce((n, m) => n + m.fields.length, 0);
  const sourceCount = maps.reduce(
    (n, m) =>
      n +
      m.fields.reduce(
        (k, f) => k + f.sources.filter((s) => (s.kind === 'record' || s.kind === 'record_option') && s.questionId !== undefined).length,
        0,
      ),
    0,
  );
  heads.push(
    `LIST fieldmaps documents=${maps.map((m) => m.documentType).join(',')} fields=${fieldCount} ` +
      `question-sources=${sourceCount} repoints=${proposal.repoints.length}`,
  );

  const result = checkCoverage({ bank, areas, proposal, maps, srsText });
  for (const f of result.failures) fails.push(`FAIL ${f}`);

  const revised = reviseQuestions(bank, proposal);
  results.push(
    `LIST questions=${revised.length} ` + STAGES.map((s) => `${s}=${revised.filter((q) => q.stage === s).length}`).join(' '),
  );
  if (result.failures.length === 0) {
    const sum = (m: Map<string, Set<string>>): number => [...m.values()].reduce((n, set) => n + set.size, 0);
    results.push(`LIST pairs=${sum(revisedQuestionControlPairs(bank, areas, proposal))}`);
    results.push(`LIST pairs-base=${sum(questionControlPairs(bank, areas))}`);
  }
  for (const q of revised) if (q.areas.size === 0) results.push(`LIST unmapped question=${q.id}`);
  for (const t of result.thinnedAreas) {
    results.push(`LIST thinned area=${t.area} stage=${t.stage} before=${t.before} after=${t.after}`);
  }
  if (srsText === undefined) {
    results.push('LIST srs-named skipped (no --srs)');
  } else {
    const named = scanSrsIds(srsText);
    const sections = scanSrsSections(srsText);
    if (sections.length !== 4) {
      const have = sections.length === 0 ? 'it has none of them' : `it has only ${sections.map((n) => `## ${n}.`).join(', ')}`;
      fails.push(`FAIL --srs file lacks the section headings ## 3., ## 4., ## 7. and ## 12.: ${have}`);
    }
    results.push(`LIST srs-scanned sections=${sections.join(',')} ids=${named.size}`);
    for (const id of result.affectedSrsIds) {
      const action = proposal.actions.find((a) => a.id === id);
      results.push(`LIST srs-named id=${id} action=${action?.action} lines=${(named.get(id) as number[]).join(',')}`);
    }
    if (result.affectedSrsIds.length === 0) results.push('LIST srs-named none');
  }

  return { lines: [...heads, ...fails, ...results], exitCode: fails.length > 0 ? 1 : 0 };
}

if (isMainModule(import.meta.url)) {
  const { lines, exitCode } = runCli(process.argv.slice(2));
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = exitCode;
}
