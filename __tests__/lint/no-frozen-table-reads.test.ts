import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * PRJ Task 1b (SRS 11.2, FR-PRJ-02, NFR-MNT-01): `assessments` and `remediation_items` are kept and frozen, and
 * "no code reads it". The property is asserted over the tree, so a read that returns anywhere under app, components
 * or lib fails here. A line whose trimmed text starts with //, * or a block-comment opener is dropped before
 * matching, so a comment that names a table is not a read.
 */
const READS = /\.assessments\b|\bassessments\s*:\s*(\{|true|Assessment)|\.(assessment|remediationItem)\.(find\w*|count|aggregate|groupBy)\(|\bremediationItems\b|\bcompletedRemediations\b|\b(FROM|JOIN)\s+"?(assessments|remediation_items)\b/;

const NOT_YET = [
  'app/(authenticated)/orgs/[slug]/dashboard/page.tsx', 'components/dashboard/ProjectCard.tsx',   // Task 6 removes these two entries
  'app/(authenticated)/orgs/[slug]/projects/page.tsx',                                            // Task 7 removes this one
  'lib/data/framework.ts',                                                                        // CNT's unit/cnt retires it; Task 9 removes this one
];
// Its relation map names assessments and completedRemediations in order to refuse them: a guard, not a read.
const GUARD = ['lib/data/identity.ts'];

function textFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full.split(path.sep).join('/'));
    }
  };
  // A missing root throws (ENOENT) rather than being skipped, so a renamed directory cannot make the scan pass over nothing.
  for (const r of roots) walk(r);
  return out.sort();
}

function codeLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  });
}

function filesWithCodeMatching(roots: string[], re: RegExp): string[] {
  return textFiles(roots).filter((f) => codeLines(f).some((l) => re.test(l)));
}

// Built from parts, so this file does not match its own scan (it is under __tests__, outside the roots, in any case).
const EVIDENCE_LEVEL_EXPORTS = [['EVIDENCE_COUNT_', 'INCLUDE'], ['withDerived', 'EvidenceLevel'], ['deriveEvidence', 'Level']]
  .map((parts) => new RegExp(`\\b${parts.join('')}\\b`));

describe('the frozen tables are not read', () => {
  it('SRS 11.2 FR-PRJ-02: no module under app, components or lib reads assessments or remediation_items', () => {
    const hits = filesWithCodeMatching(['app', 'components', 'lib'], READS).filter((f) => !NOT_YET.includes(f) && !GUARD.includes(f));
    expect(hits).toEqual([]);
  });

  it('NFR-MNT-01 FR-PRJ-02: EVIDENCE_COUNT_INCLUDE, withDerivedEvidenceLevel and deriveEvidenceLevel are gone from app, components and lib', () => {
    for (const re of EVIDENCE_LEVEL_EXPORTS) expect(filesWithCodeMatching(['app', 'components', 'lib'], re), String(re)).toEqual([]);
  });
});
