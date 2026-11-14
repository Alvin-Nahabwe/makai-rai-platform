import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentType } from '@/types/record';
import { RENDERERS, type RenderInput, type ResolvedField } from '@/lib/documents/render';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { formatFingerprint } from '@/lib/seal/format';

/**
 * No printed line overprints another (walk finding B1). A unitless line height on the page style is turned into points
 * with the page's own font size, so a larger style that does not declare its own inherits a line box shorter than its
 * text: the 20 pt title printed through "Organisation:" on every issued document. These cases read each page back
 * with pdftotext -bbox and compare the line boxes.
 */

const FINGERPRINT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).status !== null;

function input(type: DocumentType, names: { organisationName: string; projectName: string }): RenderInput {
  const map = loadFieldMap(type);
  const fields: ResolvedField[] = map.fields.slice(0, 35).map((f, i) => ({
    fieldId: f.fieldId, label: f.label, section: f.section,
    text: i % 3 === 0 ? `${'A long answer the team wrote about this field. '.repeat(8)}${f.fieldId}` : `Line one for ${f.fieldId}\nLine two`,
    provenance: 'From Q-PP-12 v1 (content 5.0.0). Decided by Amina; declared 2 Nov 2026.',
  }));
  fields.push({
    fieldId: 'ZZ-SEALS', label: 'Seals used', section: 'Record and sign-off', provenance: '',
    text: `Seal 2 of Pre-processing review 1: sealed 3 Nov 2026 09:00:00 UTC by Amina (owner); decisions entered by 2 people. Fingerprint ${formatFingerprint(FINGERPRINT, 'full')}`,
  });
  const seals = [{ sealId: 's1', sealNumber: 2, reviewId: 'r1', reviewName: 'Pre-processing review 1', fingerprint: FINGERPRINT }];
  return { map, fields, seals, issuedAt: '2026-11-03T10:42:07.000Z', ...names };
}

/** One printed line as pdftotext -bbox reads it: the words that share a box height, merged left to right. */
type PrintedLine = { text: string; xMin: number; xMax: number; yMin: number; yMax: number };

function printedLines(pdf: Buffer): PrintedLine[][] {
  const dir = mkdtempSync(join(tmpdir(), 'doca-lines-'));
  try {
    writeFileSync(join(dir, 'x.pdf'), pdf);
    const bbox = execFileSync('pdftotext', ['-bbox', join(dir, 'x.pdf'), '-'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return [...bbox.matchAll(/<page width="[\d.]+" height="[\d.]+">([\s\S]*?)<\/page>/g)].map(([, inner]) => {
      const lines = new Map<string, PrintedLine>();
      for (const m of inner.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
        const [xMin, yMin, xMax, yMax] = [m[1], m[2], m[3], m[4]].map(Number);
        const key = `${yMin}|${yMax}`;
        const line = lines.get(key);
        if (line) Object.assign(line, { text: `${line.text} ${m[5]}`, xMin: Math.min(line.xMin, xMin), xMax: Math.max(line.xMax, xMax) });
        else lines.set(key, { text: m[5], xMin, xMax, yMin, yMax });
      }
      return [...lines.values()].sort((a, b) => a.yMin - b.yMin);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Overprint tolerance, in points. pdftotext's box for a word runs from the font's ascent to its descent (1.3 em for Geist),
 * which is taller than the ink. Two lines set exactly at that pitch touch and print cleanly, and a 10.5 pt label that wraps
 * at the page's 13.5 pt pitch overlaps its own next line's box by 0.15 pt with no ink touching. The fault this guards
 * against overlapped by 8.5 pt (the 20 pt title over "Organisation:"); a 14 pt heading set at 13.5 pt would overlap by 4.7.
 */
const OVERPRINT_TOLERANCE = 0.5;

/** Every pair of lines on the page that share horizontal space and whose boxes overlap by more than the tolerance. */
function overprints(page: PrintedLine[]): string[] {
  const found: string[] = [];
  page.forEach((a, i) => page.slice(i + 1).forEach((b) => {
    const sideBySide = a.xMax <= b.xMin || b.xMax <= a.xMin;
    const overlap = Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin);
    if (!sideBySide && overlap > OVERPRINT_TOLERANCE) found.push(`"${a.text}" and "${b.text}" overlap by ${overlap.toFixed(2)} pt`);
  }));
  return found;
}

describe('printed lines never overprint (walk B1)', () => {
  const long = (what: string) => `${what} ${'with a long registered name that keeps going '.repeat(4)}`.slice(0, 150);
  const cases = (['data_card', 'model_card', 'mitigation_plan'] as const).flatMap((type) => [
    { type, names: 'short', organisationName: 'Org', projectName: 'Project' },
    { type, names: '150-character', organisationName: long('Organisation'), projectName: long('Project') },
  ]);

  it.skipIf(!HAS_PDFTOTEXT && !process.env.CI).each(cases)('FR-DOC-02: $type with $names names: the title clears the line after it, and no two lines overlap on any page', async ({ type, organisationName, projectName }) => {
    const { pdf } = await RENDERERS[type]!(input(type, { organisationName, projectName }));
    const pages = printedLines(pdf);
    expect(pages.length).toBeGreaterThan(1);                                    // the footer is checked against a full page
    const [title, next] = pages[0];
    expect(next.text.startsWith('Organisation:'), next.text).toBe(true);
    expect(title.yMax - next.yMin, `title "${title.text}" against "${next.text}"`).toBeLessThanOrEqual(OVERPRINT_TOLERANCE);
    const project = pages[0].findIndex((l) => l.text.startsWith('Project:'));
    if (organisationName.length > 100) expect(project, 'the long organisation name wraps').toBeGreaterThan(2);
    expect(pages.map(overprints)).toEqual(pages.map(() => []));
  });
});
