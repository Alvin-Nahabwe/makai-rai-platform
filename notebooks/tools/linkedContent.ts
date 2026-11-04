import type { AreasFile, ContentQuestion, QuestionBankFile } from '@/types/content';

/** The area ids one question reaches under the FULL reading: its `gaps` plus every area in `optionGapMap`. */
function areasOf(q: ContentQuestion): Set<string> {
  const ids = new Set<string>(q.gaps);
  for (const mapped of Object.values(q.optionGapMap ?? {})) {
    for (const entry of mapped) ids.add(typeof entry === 'string' ? entry : entry.area);
  }
  return ids;
}

/**
 * The markdown of a notebook's `linked-content` cell: the risk areas whose `controls` include the control
 * (id and name) and the ids of the questions that reach those areas, both in content order.
 * Pure: it reads nothing and names no id of its own, so it follows whatever content it is given.
 */
export function linkedContentMarkdown(controlId: string, bank: QuestionBankFile, areas: AreasFile): string {
  const linked = areas.areas.filter((a) => (a.controls ?? []).includes(controlId));
  const linkedIds = new Set(linked.map((a) => a.id));
  const questions: string[] = [];
  for (const stage of Object.values(bank.stages)) {
    for (const module of stage.modules) {
      for (const q of module.questions) {
        if ([...areasOf(q)].some((id) => linkedIds.has(id))) questions.push(q.id);
      }
    }
  }
  const lines = [
    '## Linked risk areas and questions',
    '',
    `Generated from content ${areas.meta.version}. Do not edit by hand.`,
    '',
  ];
  if (linked.length === 0) {
    lines.push('No risk area lists this control.');
  } else {
    lines.push(`Risk areas: ${linked.length}`, '');
    for (const a of linked) lines.push(`- ${a.id}: ${a.name}`);
  }
  lines.push('', `Questions: ${questions.length}${questions.length > 0 ? `: ${questions.join(', ')}` : ''}`);
  return lines.join('\n');
}
