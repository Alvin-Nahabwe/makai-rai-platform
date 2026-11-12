import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateContentVersion } from '@/lib/content/validate';
import { proposalStatus, withApprovedCopy } from '../content/helpers/draft-proposal';

/**
 * The structure of the versioned content directory (SRS 10.1.1, ADR-C9; contract "Content bundle").
 *
 * Every version index.json lists goes through the content check, `validateContentVersion`, without the completeness
 * rules (the companion texts and sign-offs are C-TXT's, and `content-release.test.ts` enforces them once any sign-off
 * exists). The check builds each version with the loader's own parser over plain file reads of the committed files,
 * never the fixture bundle, and holds it to the backbone, the mapping and the ids of the 4.0.0 baseline at data/, or
 * of the approved question-set proposal once C-TXT commits one. Counts and ids are read from the content (call
 * R-62), never written here. The https and QC-05 cases read the files as JSON themselves, a second root beside the
 * checker's.
 */
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

interface Control { id: string; resources?: Array<{ url: string }> }
interface Code { code: string; status: string; label: string }

const C = 'data/content';
const idx = json(`${C}/index.json`);
const v = idx.running;

describe('content bundle structure', () => {
  it('FR-CNT-01 FR-CNT-03 FR-CNT-04 FR-CNT-05 FR-CNT-06: every listed version passes the content check (structure, mapping, ids)', () => {
    expect(idx.versions).toContain(v);
    for (const ver of idx.versions as string[]) {
      const proposal = `docs/content/question-set-${ver}/proposal.json`;
      const check = (file: string | null) => validateContentVersion(`${C}/${ver}`, { baselineDir: 'data', proposalFile: file, completeness: false });
      const status = proposalStatus(proposal);
      expect(['approved', 'checked'], `${ver}: its proposal status is ${String(status)}`).toContain(status === null ? 'approved' : status);
      // A draft awaiting the owner's sitting has a proposal that says 'checked'; its content is checked through an approved copy.
      if (status === 'checked') expect(withApprovedCopy(proposal, check), ver).toEqual([]);
      else expect(check(status === null ? null : proposal), ver).toEqual([]);
    }
  });
  it('the running version has a committed proposal that says approved (a draft can be listed, never run)', () => {
    expect(proposalStatus(`docs/content/question-set-${v}/proposal.json`)).toBe('approved');
  });
  it('FR-CNT-01 NFR-SEC-11: every control resource link of every listed version is https', () => {
    // Every version index.json lists, not only the running one: S-13 shows an older version's wording and links.
    for (const ver of idx.versions as string[]) {
      const controls: Control[] = json(`${C}/${ver}/assessmentAreas.json`).controls;
      for (const c of controls) for (const r of c.resources ?? []) expect(new URL(r.url).protocol, `${ver} ${c.id} ${r.url}`).toBe('https:');
    }
  });
  it('FR-CNT-01 (QC-05): reason codes are coded by status and keep the platform and "other" codes', () => {
    const codes: Code[] = json(`${C}/${v}/reasonCodes.json`).codes;
    for (const c of codes) { expect(c.code).toMatch(/^(na|ny)_[a-z_]+$/); expect(c.status).toBe(c.code.startsWith('na_') ? 'not_applicable' : 'not_yet'); expect(c.label.length).toBeGreaterThan(0); }
    expect(codes.map((c) => c.code)).toEqual(expect.arrayContaining(['na_no_personal_data', 'na_other', 'ny_other']));
    expect(Object.keys(json(`${C}/${v}/documentHelp.json`)).sort()).toEqual(['data_card', 'mitigation_plan', 'model_card']);
  });
});

/** A parsed content file, edited by path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSON
type Json = any;

describe('content check: a mapping key and a resource type the pages would drop or label wrongly', () => {
  const FIXTURE = '__tests__/fixtures/content/0.0.1-fixture';
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
  /** A copy of H0's fixture bundle with one file edited, checked as the release check checks a version. */
  function problemsAfter(file: 'questionBank.json' | 'assessmentAreas.json', edit: (j: Json) => void): string[] {
    const root = mkdtempSync(join(tmpdir(), 'content-key-')); roots.push(root);
    const dir = join(root, '0.0.1-fixture');   // the directory name is the version
    cpSync(FIXTURE, dir, { recursive: true });
    const j = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    edit(j);
    writeFileSync(join(dir, file), JSON.stringify(j));
    return validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: false });
  }
  const checklist = (j: Json) => (Object.values(j.stages) as Json[]).flatMap((st) => st.modules.flatMap((m: Json) => m.questions as Json[])).find((q) => q.id === 'Q-PP-17')!;

  it('FR-CNT-04 FR-SUG-02: an optionGapMap key that is not one of the question\'s options is refused, naming the key and the question', () => {
    expect(problemsAfter('questionBank.json', () => {})).toEqual([]);   // the unedited copy passes, so the next line is the edit's doing
    const problems = problemsAfter('questionBank.json', (j) => {
      const q = checklist(j);
      q.optionGapMap['Labelling bias'] = q.optionGapMap['Labeling bias'];
      delete q.optionGapMap['Labeling bias'];
    });
    expect(problems.join('\n')).toMatch(/question Q-PP-17: optionGapMap key "Labelling bias" is not one of its options/);
  });

  it('FR-CNT-01 FR-SUG-04: a control type other than technical, procedural or informational is refused (S-27 has a section for each, the card a word for each)', () => {
    const problems = problemsAfter('assessmentAreas.json', (j) => { j.controls[0].type = 'strategic'; });
    expect(problems.join('\n')).toMatch(/control C-01: type "strategic" is not technical, procedural or informational/);
  });

  it('FR-CNT-01 UX-13: a control resource type outside framework, tool, paper and guidance is refused', () => {
    const problems = problemsAfter('assessmentAreas.json', (j) => { j.controls[0].resources = [{ title: 'A post', url: 'https://example.org/p', type: 'blog' }]; });
    expect(problems.join('\n')).toMatch(/control C-01: resource type "blog" is not framework, tool, paper or guidance/);
  });
});
