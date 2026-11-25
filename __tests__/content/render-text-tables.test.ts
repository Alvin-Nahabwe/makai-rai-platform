/**
 * `renderTextTables` shows what the owner signs: answerLabels, answerPrompts and practiceSameAs for the questions that
 * have them, and no blank "Reason prompt" row for a question without a reasonPrompt (the stage hash covers those fields).
 */
import { describe, expect, it, vi } from 'vitest';

import { loadContent } from '@/lib/content/loader';
import { renderTextTables } from '@/scripts/content/render-tables';
import type { LoadedContent, LoadedQuestion } from '@/types/content';

// The real bundle, not the fixture the setup file swaps in.
vi.unmock('@/lib/content/root');

const base = loadContent('5.1.0');
const labels = { done: 'Yes, we compared', partly: 'Some of them', not_yet: 'Not compared', not_applicable: 'No alternative' };
const prompts = { done: 'Name what you compared.', partly: 'Say what is left.', not_yet: 'Say why not yet.', not_applicable: 'Say why none applies.' };

function withNewFields(): LoadedContent {
  const questions = new Map<string, LoadedQuestion>(base.questions);
  const q = questions.get('Q-PP-01') as LoadedQuestion;
  const { reasonPrompt: _r, ...rest } = q;
  questions.set('Q-PP-01', { ...rest, answerLabels: labels, answerPrompts: prompts, practiceSameAs: ['5.1.0'] } as LoadedQuestion);
  return { ...base, questions };
}

const section = (md: string, id: string): string => md.split('\n## ').find((s) => s.startsWith(id)) ?? '';

describe('renderTextTables', () => {
  it('renders labels, prompts and practiceSameAs for a question that has them, and no Reason prompt row', () => {
    const md = renderTextTables(withNewFields(), '5.2.0')['pre-processing'];
    const s = section(md, 'Q-PP-01');
    for (const [k, v] of Object.entries({ ...labels })) expect(s).toContain(`| Answer label, ${k} | ${v} |`);
    for (const [k, v] of Object.entries(prompts)) expect(s).toContain(`| Answer prompt, ${k} | ${v} |`);
    expect(s).toContain('| Practice same as | 5.1.0 |');
    expect(s).not.toContain('Reason prompt');
  });
  it('keeps the Reason prompt row for a question that has one, and adds no new row to it', () => {
    const s = section(renderTextTables(withNewFields(), '5.2.0')['pre-processing'], 'Q-PP-02');
    expect(s).toContain('| Reason prompt | ');
    expect(s).not.toMatch(/Answer label|Answer prompt|Practice same as/);
  });
});
