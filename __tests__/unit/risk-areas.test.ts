import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { riskAreaIdsOf, riskAreasOf } from '@/lib/content/riskAreas';
import { buildLoadedContent, runningContent } from '@/lib/content/loader';
import type { LoadedContent } from '@/types/content';

/**
 * A question's risk areas (plan 1C Task 4; owner's answer 17.5): its `gaps` ids, then every area of its `optionGapMap`,
 * without duplicates. The content validator reads the same function (lib/content/validate.ts), so there is one reading.
 */
/** The real running bundle (unit tests run on the fixture bundle; data/content/index.json names this one for the server). */
const RUNNING = (JSON.parse(readFileSync('data/content/index.json', 'utf8')) as { running: string }).running;
const c: LoadedContent = buildLoadedContent(RUNNING as never, (file) => readFileSync(`data/content/${RUNNING}/${file}`));

describe('riskAreaIdsOf and riskAreasOf', () => {
  it("riskAreaIdsOf equals the validator's reading for all 67 questions of the running content, and every id is a known area", () => {
    expect(c.questions.size).toBe(67);
    const validator = readFileSync('lib/content/validate.ts', 'utf8');
    // One reading: the validator imports riskAreaIdsOf and keeps no private copy of the walk.
    expect(validator).toMatch(/import \{ riskAreaIdsOf \} from '@\/lib\/content\/riskAreas';/);
    expect(validator).not.toMatch(/function areasOf\(/);
    for (const q of [...c.questions.values(), ...runningContent().questions.values()]) {
      const ids = riskAreaIdsOf(q);
      expect(new Set(ids).size, q.id).toBe(ids.length);
      expect(ids.slice(0, q.gaps.length), q.id).toEqual([...new Set(q.gaps)].slice(0, ids.length));
      const areas = c.questions.has(q.id) && c.questions.get(q.id) === q ? c.areas : runningContent().areas;
      for (const id of ids) expect(areas.has(id), `${q.id} -> ${id}`).toBe(true);
      if (q.type !== 'gate') expect(ids.length, q.id).toBeGreaterThan(0);
    }
  });

  it('a checklist question with empty gaps gets its areas from optionGapMap (Q-PP-16)', () => {
    const q = c.questions.get('Q-PP-16')!;
    expect(q.gaps).toEqual([]);
    const fromOptions = new Set(Object.values(q.optionGapMap ?? {}).flat().map((e) => (typeof e === 'string' ? e : e.area)));
    expect(fromOptions.size).toBeGreaterThan(0);
    expect(new Set(riskAreaIdsOf(q))).toEqual(fromOptions);
  });

  it('gaps first, then option areas, each once; anything that is not a string id is skipped', () => {
    expect(riskAreaIdsOf({ gaps: ['B', 'A', 'B'], optionGapMap: { x: ['A', { area: 'C' }], y: [{ area: 'B' }, 'D'] } })).toEqual(['B', 'A', 'C', 'D']);
    expect(riskAreaIdsOf({ gaps: undefined, optionGapMap: undefined } as never)).toEqual([]);
    expect(riskAreaIdsOf({ gaps: [3, 'A'], optionGapMap: { x: 'nope', y: [null, { area: 4 }, { area: 'E' }] } } as never)).toEqual(['A', 'E']);
  });

  it('riskAreasOf: each area with its name in words and its link to the area card on the framework page; none for the personal data question', () => {
    const q = c.questions.get('Q-PP-01')!;
    const areas = riskAreasOf(q, c);
    expect(areas.map((a) => a.id)).toEqual(riskAreaIdsOf(q));
    for (const a of areas) {
      expect(a.name).toBe(c.areas.get(a.id)!.name);
      expect(a.href).toBe(`/explore/framework#area-card-${a.id}`);
    }
    expect(riskAreasOf(c.questions.get('Q-PP-GATE-SENSITIVE')!, c)).toEqual([]);
  });
});
