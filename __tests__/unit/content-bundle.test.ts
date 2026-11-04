import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { validateContentVersion } from '@/lib/content/validate';

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
      expect(validateContentVersion(`${C}/${ver}`, { baselineDir: 'data', proposalFile: existsSync(proposal) ? proposal : null, completeness: false }), ver).toEqual([]);
    }
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
