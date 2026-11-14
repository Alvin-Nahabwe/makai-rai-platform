/**
 * Rule C2 (plan 1B, spec 9.1), pure: the next question with no decision after the last-saved one, in question order,
 * wrapping round; the last-saved question itself when the stage has none open; the first open question for a person
 * who never saved. `null` when nothing qualifies. Only ids of `questions` are ever returned.
 */
export function nextStep(input: { questions: ReadonlyArray<{ id: string; text: string }>; open: ReadonlySet<string>; after: string | null }):
  { questionId: string; rule: 'next-open' | 'last-saved' | 'first-open' } | null {
  const { questions, open, after } = input;
  const at = after === null ? -1 : questions.findIndex((q) => q.id === after);
  if (at >= 0) {
    // Scan the questions after the last-saved one, wrapping round to it.
    for (let i = 1; i <= questions.length; i += 1) {
      const q = questions[(at + i) % questions.length];
      if (open.has(q.id)) return { questionId: q.id, rule: 'next-open' };
    }
    return { questionId: questions[at].id, rule: 'last-saved' };
  }
  const first = questions.find((q) => open.has(q.id));
  if (first === undefined) return null;
  return { questionId: first.id, rule: after === null ? 'first-open' : 'next-open' };
}
