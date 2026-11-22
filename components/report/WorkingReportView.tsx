import type { ReactElement } from 'react';
import { Definition, Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import '@/components/ui/buttonStyles';
import { draftSnapshot, type DraftRecord } from '@/lib/data/documents';
import { CONTROLS_AFTER_APPROVAL, DOCUMENT_TITLES, NO_RISK_AREA_GROUP, PART_MESSAGE, emptyFieldText, STAGE_TERMS, WORKING_REPORT_BUSY_MESSAGE, WORKING_REPORT_PAGE as W, WORKING_REPORT_RATE_LIMITED_MESSAGE, draftLine } from '@/lib/documents/copy';
import { Callout } from '@/components/ui/Callout';
import { API_COPY } from '@/lib/http/api/copy';
import type { ReportRefusal } from '@/lib/http/exportRefusal';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { resolveFields } from '@/lib/documents/resolve';
import { workingReportPages, type OpenItem, type ReportPageRef, type WorkingReportPart, type WorkingReportSummary } from '@/lib/documents/workingReport';
import { PROJECT_COPY } from '@/lib/project/copy';
import { TERM_CONTROL, TERM_RISK_AREA, TERM_WORKING_REPORT } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import type { Stage } from '@/types/record';
import './report.css';

const C = PROJECT_COPY.workingReport;

/** The (i) beside a term the page defines at its first use. */
const tip = (term: DefinedEntry): ReactElement => <TermTip of={term} label={PROJECT_COPY.whatMeans(term.term)} />;

type Refusal = { reason: ReportRefusal; reference: string | null };
type Props = { orgSlug: string; projectId: string; record: DraftRecord; summary: WorkingReportSummary; refusal?: Refusal | null };

/**
 * Why a download opened as a page came back here (fix wave item 8; the route's redirect, lib/http/exportRefusal.ts), in the route's
 * own words: the sentence its JSON answer would have carried. Nothing when the page was opened any other way.
 */
export function DownloadRefusal({ refusal }: { refusal: Refusal | null }): ReactElement | null {
  if (refusal === null) return null;
  const text = refusal.reason === 'report_busy' ? WORKING_REPORT_BUSY_MESSAGE
    : refusal.reason === 'rate_limited' ? WORKING_REPORT_RATE_LIMITED_MESSAGE
    : refusal.reason === 'part' ? PART_MESSAGE
    : refusal.reason === 'not_found' ? API_COPY.notFound
    : API_COPY.internalError(refusal.reference ?? '');
  return <Callout kind="caution"><p role="alert">{text}</p></Callout>;
}

const stageName = (st: Stage): string => STAGE_TERMS[st].term;
const downloadHref = (orgSlug: string, projectId: string, part: WorkingReportPart): string =>
  `/api/v1/orgs/${orgSlug}/projects/${projectId}/working-report?part=${encodeURIComponent(part)}`;

/** The part of the report a page of it is, for its download link and its section's address. The order is workingReportPages's, not this file's. */
function partOf(ref: ReportPageRef): WorkingReportPart {
  if (ref.kind === 'summary') return 'summary';
  return ref.documentType === 'mitigation_plan' ? `mitigation_plan:${ref.reviewStage}` : ref.documentType;
}
/** A document's name for an address: the type, and for a mitigation plan its stage too (one plan per stage). */
const docKey = (ref: Extract<ReportPageRef, { kind: 'document' }>): string => (ref.documentType === 'mitigation_plan' ? `${ref.documentType}-${ref.reviewStage}` : ref.documentType);
const sectionId = (ref: ReportPageRef): string => (ref.kind === 'summary' ? 'report-summary' : `report-${docKey(ref)}`);

/** Consecutive rows that share a key, in order, as [key, rows] runs. */
function groupRuns<T, K>(rows: readonly T[], keyOf: (row: T) => K): Array<[K, T[]]> {
  const out: Array<[K, T[]]> = [];
  for (const r of rows) {
    const key = keyOf(r);
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === key) last[1].push(r);
    else out.push([key, [r]]);
  }
  return out;
}
const titleOf = (ref: ReportPageRef): string => {
  if (ref.kind === 'summary') return W.title;
  const name = DOCUMENT_TITLES[ref.documentType];
  return ref.documentType === 'mitigation_plan' ? C.planTitle(name, stageName(ref.reviewStage)) : name;
};

/** `defineControls`: this item holds the page's first "Suggested controls", the first use of the term when page 1 shows controls. */
function Item({ item, defineControls }: { item: OpenItem; defineControls: boolean }): ReactElement {
  return (
    <li className="report-item" data-open-item>
      <p className="report-item__title">{item.title}</p>
      {item.questionText !== null && !item.title.includes(item.questionText) ? <p className="report-item__fact">{W.question}: {item.questionText}</p> : null}
      {item.answer !== null ? <p className="report-item__fact">{W.answer}: {item.answer}</p> : null}
      {item.alsoAreas.length > 0 ? <p className="report-item__fact">{W.alsoTouches}: {item.alsoAreas.join(', ')}</p> : null}
      {item.controls.length > 0 ? (
        <div className="report-item__controls">
          <p className="report-item__fact">{defineControls ? <><Term of={TERM_CONTROL}>{W.controls}</Term>{tip(TERM_CONTROL)}</> : W.controls}</p>
          <ul>
            {item.controls.map((c) => (
              <li key={c.id} data-control>
                {c.notebookHref === null ? `${c.name} (${c.id})` : <><a href={c.notebookHref}>{`${c.name} (${c.id})`}</a> <span className="report-muted">{W.hasNotebook}</span></>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="report-item__place">{C.placeOf(stageName(item.stage), item.questionId)}</p>
    </li>
  );
}

/** Page 1 on screen: the same blocks, in the same order, as the PDF's page 1 (lib/documents/render/summaryPage.tsx). */
export function Summary({ summary: s, headingId }: { summary: WorkingReportSummary; headingId: string }): ReactElement {
  const byStage = <T extends { stage: Stage }>(rows: readonly T[]) => groupRuns(rows, (r) => r.stage);
  const firstControls = s.controlsShown ? s.nextSteps.flatMap((g) => g.items).find((i) => i.controls.length > 0)?.findingId ?? null : null;
  return (
    <section id="report-summary" className="report-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{W.title}</h2>
      {s.omittedAnswers > 0 ? <p className="report-note">{W.omitted(s.omittedAnswers)}</p> : null}

      <h3>{W.nextSteps}</h3>
      {s.nextSteps.length === 0 ? <p>{W.nothingOpen}</p> : !s.controlsShown ? <p className="report-muted"><Term of={TERM_CONTROL}>{CONTROLS_AFTER_APPROVAL}</Term>{tip(TERM_CONTROL)}</p> : null}
      {s.nextSteps.map((g) => (
        <div key={g.areaId ?? g.areaName} className="report-group">
          <h4>{g.areaName === NO_RISK_AREA_GROUP ? <><Term of={TERM_RISK_AREA}>{g.areaName}</Term>{tip(TERM_RISK_AREA)}</> : g.areaName}</h4>
          <ul className="report-items">{g.items.map((i) => <Item key={i.findingId} item={i} defineControls={i.findingId === firstControls} />)}</ul>
        </div>
      ))}

      {s.riskAccepted.length > 0 ? (
        <>
          <h3>{W.riskAccepted}</h3>
          <ul className="report-items">
            {s.riskAccepted.map((a) => (
              <li key={a.findingId} className="report-item">
                <p className="report-item__title">{a.title}</p>
                <p className="report-item__fact">{W.reason}: {a.reason}</p>
                {a.areaName !== null ? <p className="report-item__place">{a.areaName}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>{W.inPlace}</h3>
      {s.inPlace.length === 0 ? <p>{W.nothingInPlace}</p> : null}
      {byStage(s.inPlace).map(([stage, rows]) => (
        <div key={stage} className="report-group">
          <h4>{stageName(stage)}</h4>
          <ul className="report-items">
            {rows.map((q) => <li key={q.questionId} className="report-entry"><span className="report-code">{q.questionId}</span> {q.questionText}</li>)}
          </ul>
        </div>
      ))}

      <h3>{W.doesNotApply}</h3>
      {s.doesNotApply.length === 0 ? <p>{W.nothingNotApplicable}</p> : null}
      {byStage(s.doesNotApply).map(([stage, rows]) => (
        <div key={stage} className="report-group">
          <h4>{stageName(stage)}</h4>
          <ul className="report-items">
            {rows.map((q) => (
              <li key={q.questionId} className="report-item">
                <p className="report-item__title"><span className="report-code">{q.questionId}</span> {q.questionText}</p>
                <p className="report-item__fact">{q.why}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** One draft document on screen: its fields in map order under the map's section headings, resolved as the PDF resolves them. */
function DraftDocument({ record, ref_, headingId }: { record: DraftRecord; ref_: Extract<ReportPageRef, { kind: 'document' }>; headingId: string }): ReactElement {
  const map = loadFieldMap(ref_.documentType);
  const { fields } = resolveFields(map, draftSnapshot(record, ref_.documentType, ref_.reviewStage), {});
  const idOf = (fieldId: string): string => `field-${docKey(ref_)}-${fieldId}`;
  const groups = groupRuns(fields, (f) => f.section).map(([section, rows]) => ({ section, rows }));
  return (
    <section id={sectionId(ref_)} className="report-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{titleOf(ref_)}</h2>
      {groups.map((g) => (
        <div key={g.section} className="report-group">
          <h3>{g.section}</h3>
          <dl className="report-fields">
            {g.rows.map((f) => (
              <div key={f.fieldId} id={idOf(f.fieldId)} className="report-field">
                <dt><span className="report-code">{f.fieldId}</span> {f.label}</dt>
                <dd>
                  <p className="report-field__text">{f.text ?? emptyFieldText('draft')}</p>
                  {f.provenance === '' ? null : <p className="report-field__provenance">{f.provenance}</p>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

/**
 * The working report on screen (path to outputs, Task 10; design G1): the draft line, a download for the whole report and for each part,
 * page 1, then each draft document. The parts and their order are `workingReportPages`'s (Task 8), the one definition the PDF uses too.
 * It renders no PDF and imports no renderer (design §5; __tests__/unit/working-report-imports.test.ts). It holds links only, no button
 * and no field: everything on it is readable and downloadable by every role that can read the record (anti-goal 4).
 */
export function WorkingReportView({ orgSlug, projectId, record, summary, refusal = null }: Props): ReactElement {
  const pages = workingReportPages(record, 'all');
  return (
    <div className="page-content report">
      {/* The draft line, sticky on screen and repeated on every printed page (report.css): a screenshot or a printout never reads as sealed (anti-goal 1). */}
      <p className="report-draft" data-report-draft>{draftLine(record.takenAt)}</p>
      {/*
        * A frame around the report's content, for printing only: on screen every part of it is a block and the table's semantics are
        * removed. In print its header group is an empty spacer, which the browser repeats on every page, so the text of each page starts
        * below the fixed draft line instead of under it (report.css).
        */}
      <table className="report-frame" role="presentation">
        <thead className="report-frame__space" aria-hidden="true"><tr><td /></tr></thead>
        <tbody><tr><td>
      <header className="report-head">
        <h1><Term of={TERM_WORKING_REPORT}>{PROJECT_COPY.titles.workingReport}</Term></h1>
        <p className="report-lead"><Definition of={TERM_WORKING_REPORT} /></p>
      </header>
      <section className="report-downloads" aria-labelledby="report-downloads">
        <h2 id="report-downloads">{C.downloadHeading}</h2>
        <DownloadRefusal refusal={refusal} />
        <p><a className="ui-button ui-button--primary" href={downloadHref(orgSlug, projectId, 'all')}>{C.downloadAll}</a></p>
        <p id="report-parts" className="report-muted">{C.partsHeading}</p>
        <ul aria-labelledby="report-parts" className="report-parts">
          {pages.map((ref) => (
            <li key={partOf(ref)}><a href={downloadHref(orgSlug, projectId, partOf(ref))}>{C.partLink(titleOf(ref))}</a></li>
          ))}
        </ul>
      </section>
      {pages.map((ref) => {
        const headingId = `${sectionId(ref)}-heading`;
        return ref.kind === 'summary'
          ? <Summary key="summary" summary={summary} headingId={headingId} />
          : <DraftDocument key={partOf(ref)} record={record} ref_={ref} headingId={headingId} />;
      })}
        </td></tr></tbody>
      </table>
    </div>
  );
}
