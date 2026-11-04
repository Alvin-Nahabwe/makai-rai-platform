import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-FND-08 (SRS line 923): finding, mitigation and accepted-risk counts reach members only, and no email, platform
 * administrator page or public page. Combined with ORG's FR-ORG-03 test, which renders S-23 and S-24 over the sentinel fixture
 * (SRS line 547).
 *
 * WHAT THIS CAN AND CANNOT SHOW. It reads the source of the places that must not see a count and fails when one imports a
 * findings, follow-up, project-count, seal, review or document service, or names a findings model with a read. It proves no
 * count is *read* there; the rendered pages are ORG's sentinel test. The files are FOUND on every run (a walk of each root),
 * so a module added tomorrow is checked tomorrow. A root that does not exist yet (`lib/data/admin.ts` is ORG's) is skipped;
 * the non-vacuity check below walks the roots that do.
 */

const ROOT = path.join(__dirname, '../..');
/** The places that serve a non-member: emails, the public pages, the platform-administrator pages and routes, and the legal texts. */
const OUTSIDE_MEMBERS = ['lib/email', 'app/(public)', 'app/(authenticated)/admin', 'app/api/admin', 'lib/data/admin.ts', 'lib/legal'];
/** A findings, follow-up, project, seal, review or document service (by its path tail, so a relative import is caught), or a read of a findings model. */
const FINDINGS_DATA = /(?:from|import\()\s*['"](?:[^'"]*\/(?:data\/(?:findings|teamFindings|followup|projects|seals|reviews|documents)|findings\/[A-Za-z]+)|\.\/(?:findings|teamFindings|followup|projects|seals|reviews|documents))(?:\.(?:ts|tsx|mjs|js))?['"]|\.(?:finding|findingEvent|mitigationVersion|acceptedRisk|stageReview|seal)\.(?:find|count|aggregate|groupBy)/;

function walk(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    if (/\.(ts|tsx|mjs)$/.test(rel)) out.push(rel);
    return out;
  }
  for (const name of readdirSync(abs)) walk(path.posix.join(rel, name), out);
  return out;
}

const filesUnder = (roots: readonly string[]) => roots.flatMap((r) => walk(r));
const grepFiles = (roots: readonly string[], pattern: RegExp) =>
  filesUnder(roots).filter((f) => pattern.test(readFileSync(path.join(ROOT, f), 'utf8')));

describe('finding counts reach members only (FR-FND-08)', () => {
  it('FR-FND-08: no email, administrator or public module can read findings or their counts', () => {
    expect(filesUnder(OUTSIDE_MEMBERS).length).toBeGreaterThan(10);   // the walk found the places it guards
    expect(grepFiles(OUTSIDE_MEMBERS, FINDINGS_DATA)).toEqual([]);
  });

  it('FR-FND-08: the pattern catches an import, a relative import, a dynamic import and a model read, and spares a text that only says the word', () => {
    for (const bad of [
      "import { listFindings } from '@/lib/data/findings';",
      "import { x } from '../data/seals';",
      "const m = await import('@/lib/data/projects');",
      "import { groupFindings } from '@/lib/findings/groups';",
      'await tx.finding.count({ where: {} });',
      'await tx.acceptedRisk.groupBy({ by: [] });',
      "import { loadFindingsPage } from '@/lib/findings/pageData';",
      "import { FindingsPageView } from '@/components/findings/FindingsPageView';",
      "import { listFindings } from './findings';",
      "import { x } from './followup.ts';",
      "import { x } from '@/lib/data/findings.ts';",
      "import { x } from '@/lib/data/findings.mjs';",
      "import { FindingsPageView } from '@/components/findings/FindingsPageView.tsx';",
      "import { x } from './findings.js';",
    ]) expect(FINDINGS_DATA.test(bad), bad).toBe(true);
    for (const fine of [
      "import { sendMail } from '@/lib/email/send';",
      "import { x } from '@/lib/data/identity';",
      "import { x } from './identity';",
      '// Findings are for members only.',
    ]) expect(FINDINGS_DATA.test(fine), fine).toBe(false);
  });

  it('FR-FND-08: the email templates take no count argument', () => {
    const templates = filesUnder(['lib/email/templates', 'lib/email/templates.ts']);
    expect(templates.length).toBeGreaterThan(0);
    for (const f of templates) {
      expect(readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/\b(findings?|mitigations?|acceptedRisks?)(Count|Total|Open)\b/i);
    }
  });
});
