/**
 * The state of a finding (SRS 5.3 item 11, line 1268), as a pure function of
 * the rows the seal manifest names. It is `.mjs` and imports nothing so the
 * seal check can run it outside Next.js and without TypeScript (gap G013);
 * `state.d.mts` types it and `state.ts` re-exports it for the application.
 *
 * Let R be the `findingSeq` of the latest reopen event, or 0 if there is none.
 * The state is the first of these that holds:
 *  1. withdrawn: a withdrawn event exists (only team findings have one);
 *  2. closed_accepted_risk: an accepted risk with `findingSeq` greater than R;
 *  3. closed_mitigation: no current mitigation is planned or in progress, and
 *     at least one current version is done with `findingSeq` greater than R;
 *  4. open.
 * The rules use no times and no source: a finding's `source` is part of the
 * input because the contract fixes the signature, and no rule reads it.
 *
 * `currentMitigations` holds one entry per mitigation: its current version.
 * Nothing here changes its input.
 *
 * @param {{
 *   source: 'shortfall' | 'team',
 *   events: ReadonlyArray<{ kind: 'reopened' | 'withdrawn', findingSeq: number }>,
 *   currentMitigations: ReadonlyArray<{ status: 'planned' | 'in_progress' | 'done' | 'cancelled', findingSeq: number }>,
 *   acceptedRisks: ReadonlyArray<{ findingSeq: number }>,
 * }} input
 * @returns {'open' | 'closed_mitigation' | 'closed_accepted_risk' | 'withdrawn'}
 */
export function deriveFindingState(input) {
  const { events, currentMitigations, acceptedRisks } = input;

  if (events.some((e) => e.kind === 'withdrawn')) return 'withdrawn';

  let reopenedAt = 0;
  for (const e of events) {
    if (e.kind === 'reopened' && e.findingSeq > reopenedAt) reopenedAt = e.findingSeq;
  }

  if (acceptedRisks.some((r) => r.findingSeq > reopenedAt)) return 'closed_accepted_risk';

  const stillWorking = currentMitigations.some((m) => m.status === 'planned' || m.status === 'in_progress');
  const doneSince = currentMitigations.some((m) => m.status === 'done' && m.findingSeq > reopenedAt);
  if (!stillWorking && doneSince) return 'closed_mitigation';

  return 'open';
}
