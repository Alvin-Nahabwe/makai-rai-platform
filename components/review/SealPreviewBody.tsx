import type { ReactElement } from 'react';
import { Definition, Term } from '@/components/ui/Definition';
import { Table } from '@/components/ui/Table';
import { REVIEW_COPY } from '@/lib/review/copy';
import { STAGE_TERMS, STATUS_TERMS } from '@/lib/vocabulary/maps';
import { TERM_FINDING, TERM_MITIGATION, TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION, TERM_SEAL } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import type { Stage } from '@/types/record';
import { markTerms, usesTerm } from './markTerms';
import type { PreviewParts } from './reviewText';

/**
 * The terms S-17 defines under its heading (spec 6): "seal" and the stage, which the heading holds, then "finding" (the
 * statement's "open findings") and "mitigation" (the "Open mitigations" count), which the page uses before any other
 * place could define them. The four statuses are defined in their count table instead, beside each count (S7).
 */
export function sealPageTerms(stage: Stage): { titleTerms: DefinedEntry[]; moreTerms: DefinedEntry[] } {
  return { titleTerms: [TERM_SEAL, STAGE_TERMS[stage]], moreTerms: [TERM_FINDING, TERM_MITIGATION] };
}

const GATE_TERM = TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION;

/**
 * What the seal will include, on S-17 (W-7; UX-18; FR-REV-02): the statement, the content line when the questions
 * changed, then under its heading the decisions by status as a table, each status with its definition (S7, audit
 * C 182), Not applicable and Not yet by reason as a small table when any (C 183), and the other counts as a list,
 * the questions with no decision last, each a link to its question.
 */
export function SealPreviewBody({ parts, contentLine, noDecision }: {
  parts: PreviewParts; contentLine: string | null; noDecision: ReadonlyArray<{ id: string; href: string; text: string }>;
}): ReactElement {
  const P = REVIEW_COPY.sealPage;
  // The gate answer line (shown only when the stage's gate question has an answer) is the page's first use of "the
  // personal data question" (B4 I1): it is marked there and its definition sits in the same item.
  const gateLine = parts.lines.find((l) => usesTerm(l, GATE_TERM));
  return (
    <>
      <p>{parts.statement}</p>
      {contentLine !== null ? <p>{contentLine}</p> : null}
      <h2>{P.includesHeading}</h2>
      <Table
        caption={P.statusTable.caption} rowHeaderKey="status"
        columns={[{ key: 'status', label: P.statusTable.status }, { key: 'count', label: P.statusTable.count, align: 'end' }] as const}
        rows={parts.statuses.map(({ status, count }) => {
          const of = STATUS_TERMS[status];
          return { key: status, cells: { status: <><Term of={of} /><Definition of={of} as="p" /></>, count } };
        })}
      />
      {parts.reasons.length === 0 ? null : (
        <Table
          caption={P.reasonTable.caption} rowHeaderKey="reason"
          columns={[{ key: 'reason', label: P.reasonTable.reason }, { key: 'count', label: P.reasonTable.count, align: 'end' }] as const}
          rows={parts.reasons.map((r) => ({ key: r.code, cells: { reason: r.label, count: r.count } }))}
        />
      )}
      <ul>
        {parts.lines.map((l) => l === gateLine
          ? <li key={l}>{markTerms(l, [GATE_TERM])}<Definition of={GATE_TERM} as="p" /></li>
          : <li key={l}>{l}</li>)}
        <li>
          {P.noDecision(noDecision.length)}
          {noDecision.length > 0 ? ':' : ''}
          {noDecision.length > 0 ? (
            <ul className="review-questions">
              {noDecision.map((q) => <li key={q.id}><a href={q.href}>{q.text}</a></li>)}
            </ul>
          ) : null}
        </li>
      </ul>
    </>
  );
}
