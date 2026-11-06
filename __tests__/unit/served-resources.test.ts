import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadResources } from '@/lib/content/resources';

/** The served folders public/templates and public/notebooks hold exactly what data/resources.json lets a card link (G3, G4). */
const r = loadResources();
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * G4's content half (a released notebook's served bytes equal the reviewed ones): data/resources.json releases ten notebooks, and the
 * loop below checks each of them. The executor half is exercised by __tests__/lint/notebook-workflow.test.ts on temporary roots.
 */
describe('served templates and notebooks', () => {
  it('FR-SUG-05: every released notebook file matches its SHA-256 and size, with a requirements file and a passed review', () => {
    for (const n of r.notebooks.filter((n) => n.released)) {
      expect(n.review.outcome, n.file).toBe('passed');
      expect(sha(`public${n.file}`), n.file).toBe(n.sha256);
      expect(statSync(`public${n.file}`).size).toBe(n.bytes);
      expect(existsSync(`public${n.requirementsFile}`), n.requirementsFile).toBe(true);
      expect(n.review.reviewer.length).toBeGreaterThan(0);
    }
  });

  it('FR-SUG-06: every template linked from a control has a passed review and exists with its size and SHA-256', () => {
    for (const t of r.templates.filter((t) => t.review.outcome === 'passed')) {
      expect(statSync(`public${t.file}`).size, t.file).toBe(t.bytes);
      expect(sha(`public${t.file}`), t.file).toBe(t.sha256);
    }
  });

  it('FR-SUG-06 FR-SUG-04: every file in the served folders is linked or absent', () => {
    const linked = new Set([
      ...r.templates.filter((t) => t.review.outcome === 'passed').map((t) => t.file),
      ...r.notebooks.filter((n) => n.released).flatMap((n) => [n.file, n.requirementsFile]),
    ]);
    for (const dir of ['templates', 'notebooks']) {
      for (const f of existsSync(`public/${dir}`) ? readdirSync(`public/${dir}`) : []) {
        expect(linked.has(`/${dir}/${f}`), `public/${dir}/${f} is served but not linked`).toBe(true);
      }
    }
  });
});
