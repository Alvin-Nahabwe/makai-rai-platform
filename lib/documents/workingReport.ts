import type { LoadedContent, LoadedQuestion } from '@/types/content';
import type { Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { DraftRecord } from '@/lib/data/documents';
import { loadResources } from '@/lib/content/resources';
import {
  controlSuggestionsOn, controlsForArea, controlsForQuestion, questionAreaIds, type ControlGroup,
} from '@/lib/content/suggestions';
import { GATE_DERIVED_NA, NO_RISK_AREA_GROUP, REMOVED_QUESTION_GROUP, wordsThenCode } from '@/lib/documents/copy';
import {
  STATUS_WORD, findingTitle, notApplicableLine, textOf, type DocumentSnapshot, type SealedDecision, type SealedFinding,
} from '@/lib/documents/resolve';

/**
 * Page 1 of the working report, "Where this project stands" (path to outputs, Task 7; design G1 and §7). A pure function of a draft
 * record and the running content: no I/O but the release resources file, no clock. It builds the summary; Task 8 renders it.
 *
 * The source is open findings, not answers, so page 1 and the draft mitigation plans list the same open items. Controls are
 * suggested only when the running content's mapping is approved (anti-goal 3), and each item lists only its heading area's controls.
 */

export type ReportControl = { id: string; name: string; notebookHref: string | null };
export type OpenItem = {
  findingId: string; stage: Stage; questionId: string | null; questionText: string | null; answer: string | null; title: string;
  /** The item's other risk areas, as "words (code)". The item is listed once, under its heading area. */
  alsoAreas: string[];
  controls: ReportControl[];
};
export type AreaGroup = { areaId: string | null; areaName: string; items: OpenItem[] };
export type WorkingReportSummary = {
  takenAt: UtcInstant;
  controlsShown: boolean;
  /** Current answers left out because the running content no longer holds their question; page 1 says so when this is above 0. */
  omittedAnswers: number;
  nextSteps: AreaGroup[];
  riskAccepted: Array<{ findingId: string; title: string; reason: string; areaName: string | null }>;
  inPlace: Array<{ stage: Stage; questionId: string; questionText: string }>;
  doesNotApply: Array<{ stage: Stage; questionId: string; questionText: string; why: string }>;
};

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

/** The question's heading area and the other areas it still touches (calls 6; conflict 19a). A checklist counts its unticked options' areas first. */
function whereOfQuestion(content: LoadedContent, questionId: string, ticked: readonly string[]): { heading: string | null; others: string[] } {
  const all = questionAreaIds(content, questionId);
  const q = content.questions.get(questionId);
  let candidates = all;
  if (q?.type === 'checklist') {
    const map = q.optionGapMap ?? {};
    const open = unique((q.options ?? []).filter((o) => !ticked.includes(o)).flatMap((o) => (map[o] ?? []).map((e) => (typeof e === 'string' ? e : e.area))));
    // Every option ticked yet the finding is still open: no unticked area, so the question's first area leads.
    if (open.length > 0) candidates = open;
  }
  const heading = candidates[0] ?? null;
  return { heading, others: candidates.filter((a) => a !== heading) };
}

export function buildWorkingReportSummary(r: DraftRecord, content: LoadedContent): WorkingReportSummary {
  const controlsShown = controlSuggestionsOn(content);
  const resources = controlsShown ? loadResources() : null;
  const areaWords = (id: string): string => {
    const name = content.areas.get(id)?.name;
    return name === undefined ? id : wordsThenCode(name, id);
  };
  const reportControls = (g: ControlGroup | undefined): ReportControl[] =>
    resources === null || g === undefined ? [] : g.controls.map(({ control }) => ({
      id: control.id, name: control.name,
      notebookHref: resources.notebooks.find((n) => n.controlId === control.id && n.released && n.review.outcome === 'passed')?.file ?? null,
    }));

  /** The snapshot the draft mitigation plan of a stage reads, so a title and a reason come from the very functions MP-03 and MP-0x use. */
  const snapOf = (st: Stage): DocumentSnapshot => ({
    provenance: { kind: 'draft', takenAt: r.takenAt, omittedAnswers: r.omittedAnswers, recordedQuestionWords: r.recordedQuestionWords },
    documentType: 'mitigation_plan', reviewStage: st, chosen: r.stages[st], stages: r.stages, contents: r.contents, project: r.project,
    organisationName: r.organisationName, today: r.today, erasures: r.erasures,
  });
  const questionTextOf = (f: SealedFinding['finding']): string | null =>
    f.questionId === null ? null : content.questions.get(f.questionId)?.text ?? r.recordedQuestionWords.get(f.id) ?? null;

  type Placed = { item: OpenItem; areaId: string | null; order: [number, number, string, string] };
  const open: Placed[] = [];
  const accepted: Array<{ order: [number, number, string, string]; row: WorkingReportSummary['riskAccepted'][number] }> = [];

  for (const [si, st] of STAGES.entries()) {
    const stage = r.stages[st];
    for (const sf of stage.findings) {
      const f = sf.finding;
      if (f.state !== 'open' && f.state !== 'closed_accepted_risk') continue;
      const decision = f.questionId === null ? undefined : stage.decisions.get(f.questionId);
      const known = f.questionId !== null && content.questions.has(f.questionId);
      const ticked = decision?.row.optionsInPlace ?? [];
      const q = known ? whereOfQuestion(content, f.questionId as string, ticked) : { heading: null, others: [] };
      const areaId = f.riskArea ?? q.heading;
      const alsoAreaIds = f.riskArea !== null ? [] : q.others;
      const words = questionTextOf(f);
      const title = findingTitle(f, stage, snapOf(st));
      const questionOrder = known ? (content.questions.get(f.questionId as string) as LoadedQuestion).order : Number.MAX_SAFE_INTEGER;
      const order: [number, number, string, string] = [si, questionOrder, f.raisedAt, f.id];
      if (f.state === 'closed_accepted_risk') {
        const risk = sf.acceptedRisk;
        if (risk === null) throw new Error(`workingReport: finding ${f.id} is closed by an accepted risk but has no accepted risk row`);
        const reason = textOf(snapOf(st), 'accepted_risks', risk.id, 'reason', risk.reason);
        accepted.push({ order, row: { findingId: f.id, title, reason, areaName: areaId === null ? null : areaWords(areaId) } });
        continue;
      }
      let controls: ReportControl[] = [];
      if (controlsShown && areaId !== null) {
        if (f.riskArea !== null) controls = reportControls(controlsForArea(content, f.riskArea)[0]);
        else {
          const { first, rest } = controlsForQuestion(content, f.questionId as string, ticked);
          controls = reportControls([...first, ...rest].find((g) => g.area.id === areaId));
        }
      }
      const answerStatus = decision?.row.status ?? null;
      const item: OpenItem = {
        findingId: f.id, stage: st, questionId: f.questionId, questionText: words,
        answer: answerStatus === null ? null : STATUS_WORD[answerStatus] ?? null, title, alsoAreas: alsoAreaIds.map(areaWords), controls,
      };
      open.push({ item, areaId, order });
    }
  }
  const byOrder = (a: { order: [number, number, string, string] }, b: { order: [number, number, string, string] }): number =>
    a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]) || a.order[3].localeCompare(b.order[3]);
  open.sort(byOrder);
  accepted.sort(byOrder);

  // Groups: one per heading area, plus two with no area (a team finding with none; a finding on a question the framework no longer has).
  const groups = new Map<string, AreaGroup>();
  for (const { item, areaId } of open) {
    const removed = areaId === null && item.questionId !== null;
    const key = areaId ?? (removed ? '\0removed' : '\0none');
    let g = groups.get(key);
    if (g === undefined) {
      g = { areaId, areaName: areaId !== null ? areaWords(areaId) : removed ? REMOVED_QUESTION_GROUP : NO_RISK_AREA_GROUP, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  const areaOrder = [...content.areas.keys()];
  const rank = (g: AreaGroup): number => (g.areaId === null ? Number.MAX_SAFE_INTEGER : areaOrder.includes(g.areaId) ? areaOrder.indexOf(g.areaId) : areaOrder.length);
  const nextSteps = [...groups.values()].sort((a, b) => {
    if ((a.areaId === null) !== (b.areaId === null)) return a.areaId === null ? 1 : -1;
    if (a.areaId === null) return a.areaName === NO_RISK_AREA_GROUP ? -1 : 1;
    return b.items.length - a.items.length || rank(a) - rank(b);
  });

  const inPlace: WorkingReportSummary['inPlace'] = [];
  const doesNotApply: WorkingReportSummary['doesNotApply'] = [];
  for (const st of STAGES) {
    const stage = r.stages[st];
    const decisions = [...stage.decisions.values()].sort((a, b) => (content.questions.get(a.row.questionId)?.order ?? 1e9) - (content.questions.get(b.row.questionId)?.order ?? 1e9));
    for (const d of decisions) {
      const own = r.contents.get(d.row.contentVersionId) ?? content;
      const q = own.questions.get(d.row.questionId) ?? content.questions.get(d.row.questionId);
      if (q === undefined || q.type === 'gate') continue;
      if (d.row.status === 'done') inPlace.push({ stage: st, questionId: d.row.questionId, questionText: q.text });
      else if (d.row.status === 'not_applicable') doesNotApply.push({ stage: st, questionId: d.row.questionId, questionText: q.text, why: notApplicableLine(d, own) });
    }
    for (const questionId of stage.derived.keys()) {
      const q = content.questions.get(questionId);
      if (q !== undefined && q.type !== 'gate') doesNotApply.push({ stage: st, questionId, questionText: q.text, why: GATE_DERIVED_NA });
    }
  }

  return { takenAt: r.takenAt, controlsShown, omittedAnswers: r.omittedAnswers, nextSteps, riskAccepted: accepted.map((a) => a.row), inPlace, doesNotApply };
}
