import type { OrgRole } from '@prisma/client';
import type { CalendarDate, DecisionVersionRow, DocumentType, OutsideRole, ScopeAnswer, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, ErasedMark, EvidenceItemView, FindingEventView, FindingView, MitigationVersionView, UserRef,
} from '@/types/api';
import type { LoadedContent, LoadedQuestion } from '@/types/content';
import type { FieldMap, FieldMapEntry, FieldSource, RecordPart, SourceStage } from '@/types/documents';
import type { SealManifestV1, SealRef } from '@/types/seal';
import { loadContent, runningContent } from '@/lib/content/loader';
import { controlsForArea } from '@/lib/content/suggestions';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { isOverdue } from '@/lib/followup/overdue';
import { formatDay, formatDeclaredDate } from '@/lib/format/dates';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
import { formatFingerprint } from '@/lib/seal/format';
import {
  ETHICS_APPROVED, ETHICS_NOT_REQUIRED, ETHICS_SUBMITTED, FILE_NAME_ERASED, GATE_DERIVED_NA, assignedToLine, noDecisionLine, checkAgainLine, decidedByLine, decidedInLine, decisionSource,
  doneEvidenceLine, evidenceFileLine, fileErasedLine, findingStatusLine, formatUtcDay, fromQuestion, lastCheckNoteLine, outsideOtherBodyLine, outsideRoleLine, personalDataAnswerLine,
  reviewLineText, textErasedLine, utcSecond,
} from './copy';
import type { ResolvedField } from './render';

/**
 * Field resolution for the data card and the model card (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1). The copy below is
 * fixed by the SRS; the document tests import these constants rather than repeat the text.
 */

export {
  STATEMENT, SEALED_NOTE, NOT_RECORDED, NOT_RECORDED_AT_ISSUE, PROJECT_MARK, TYPED_MARK, NO_EVIDENCE, formatUtcDay, utcSecond,
} from './copy';
import {
  NOT_RECORDED, NOT_RECORDED_AT_ISSUE, PROJECT_MARK, TYPED_MARK, NO_EVIDENCE,
} from './copy';

/** One decision version of a seal's manifest with the people, evidence and erasure marks of its row (contract G068, exact text). */
export interface SealedDecision {
  row: DecisionVersionRow; content: ContentRef; enteredBy: UserRef; decidedBy: DeciderView | null;
  evidence: EvidenceItemView[]; reasonErased: ErasedMark | null;
}
export interface SealedFinding {
  finding: FindingView; mitigations: MitigationVersionView[]; acceptedRisk: AcceptedRiskView | null; events: FindingEventView[];
}
export interface SealedStage {
  stage: Stage;
  seal: SealRef & { fingerprint: string; sealedAt: UtcInstant; sealedBy: UserRef; sealedByRole: OrgRole; enteredByPeople: number };
  preparedFor: string | null;
  manifest: SealManifestV1;
  decisions: ReadonlyMap<string, SealedDecision>;   // question id -> the sealed current version (manifest entries carrying an id)
  /** Questions the seal records as not applicable because of the gate answer (manifest entries `derived: not_applicable_gate`): question id -> the gate's decision version id. */
  derived: ReadonlyMap<string, string>;
  findings: readonly SealedFinding[];               // every finding of the manifest, its current mitigation versions and accepted risk
}
export interface DocumentSnapshot {
  documentType: DocumentType;
  reviewStage: Stage;
  chosen: SealedStage;
  stages: Readonly<Record<Stage, SealedStage | null>>;   // stages[reviewStage] is chosen; null: that stage was never sealed (D3)
  contents: ReadonlyMap<string, LoadedContent>;         // by contentVersionId, every version a sealed decision was answered against
  project: { name: string; description: string | null; metadata: Readonly<Record<string, string | null>> };
  organisationName: string;
  today: CalendarDate;                                  // eatDate(now) at the read (MP-02, MP-03 "overdue", DOC-b)
  /** The tombstones of the rows the snapshot holds: table -> row id -> erased field (digest name) -> the UTC date of its erasure. */
  erasures: Readonly<Record<'evidence' | 'findings' | 'mitigation_versions' | 'accepted_risks' | 'stage_reviews', ReadonlyMap<string, ReadonlyMap<string, CalendarDate>>>>;
}

// ─── Field resolution (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1 D1 to D9) ─────────────────────────────────

/** The companion text field of each project value that can be "other" (as `components/dashboard/ProjectCard.tsx` shows it). */
export const OTHER_COMPANIONS: Readonly<Record<string, string>> = { aiSystemType: 'aiSystemTypeOther', deploymentSector: 'deploymentSectorOther', datasetType: 'datasetTypeOther' };

type RowRef = { sourceTable: string; sourceId: string; field: string | null };
export interface ResolvedPart { text: string | null; provenance: string; sources: RowRef[]; sealIds: string[]; /** Decision versions whose extract this part printed. */ decisionIds: string[] }
export type SourceResolver<K extends FieldSource['kind']> = (
  source: Extract<FieldSource, { kind: K }>, snap: DocumentSnapshot, typed: Readonly<Record<string, string>>, entry: FieldMapEntry, seen: Map<string, string>,
) => ResolvedPart;

const part = (p: Partial<ResolvedPart> = {}): ResolvedPart => ({ text: null, provenance: '', sources: [], sealIds: [], decisionIds: [], ...p });

const STATUS_WORD: Readonly<Record<string, string>> = { done: 'Done', partly: 'Partly', not_yet: 'Not yet', not_applicable: 'Not applicable' };
const SCOPE_WORD: Readonly<Record<ScopeAnswer, string>> = { yes: 'Yes', no: 'No', not_sure: 'Not sure' };
/** FR-DEC-01's outside roles (SRS line 737), first letter capitalised. */
export const ROLE_LABEL: Readonly<Record<OutsideRole, string>> = {
  principal_investigator: 'Principal investigator', supervisor: 'Supervisor', ethics_committee: 'Ethics committee',
  data_access_committee: 'Data-access committee', institutional_dpo: 'Institutional data-protection officer', funder: 'Funder', other: 'Other',
};
const FINDING_STATE_WORD: Readonly<Record<string, string>> = {
  open: 'Open', closed_mitigation: 'Closed by a mitigation', closed_accepted_risk: 'Closed by an accepted risk', withdrawn: 'Withdrawn',
};

/** A table of words, read by key; a key with no word is a defect, not a blank (silent-failure review M3). */
function word<K extends string>(table: Readonly<Record<K, string>>, key: string, what: string): string {
  if (!Object.hasOwn(table, key)) throw new Error(`documents: no word for ${what} "${key}"`);
  return table[key as K];
}

/** The UTC date a field of a row was erased, or null when no tombstone names it. */
function erasedAt(snap: DocumentSnapshot, table: keyof DocumentSnapshot['erasures'], id: string, field: string): CalendarDate | null {
  return snap.erasures[table].get(id)?.get(field) ?? null;
}

/**
 * A text the row holds, else the SRS 7.5.6 line for erased text, else a thrown error: a null with no tombstone is a broken row, and
 * "erased" is never printed for a text that was not (silent-failure review H1, M8).
 */
function textOf(snap: DocumentSnapshot, table: keyof DocumentSnapshot['erasures'], id: string, field: string, value: string | null): string {
  if (value !== null) return value;
  const on = erasedAt(snap, table, id, field);
  if (on === null) throw new Error(`documents: ${table} ${id} has no ${field} and no tombstone for it`);
  return textErasedLine(on);
}
/** FR-DOC-02 / D7: the sentence that stops a team's entry reading as the outside body's own record. */
export const outsideRoleSentence = (member: string, role: OutsideRole): string =>
  role === 'other' ? outsideOtherBodyLine(member) : outsideRoleLine(member, ROLE_LABEL[role]);

const runningOf = new WeakMap<DocumentSnapshot, LoadedContent>();
/** The running content, read once per snapshot. */
function running(snap: DocumentSnapshot): LoadedContent {
  let c = runningOf.get(snap);
  if (c === undefined) { c = runningContent(); runningOf.set(snap, c); }
  return c;
}
/** The question in the running content, which says what stage it is in (a decision's own version says what it asked). */
function runningQuestion(snap: DocumentSnapshot, questionId: string): LoadedQuestion {
  const c = running(snap);
  const q = c.questions.get(questionId);
  // The map was checked against the running content when it was loaded (parseFieldMap), so this is a broken deployment.
  if (q === undefined) throw new Error(`documents: question ${questionId} is not in content ${c.semver}`);
  return q;
}

function stageSource(stage: SourceStage, snap: DocumentSnapshot): SealedStage | null {
  return snap.stages[stage === 'review' ? snap.reviewStage : stage];
}

/**
 * The source rows of printed evidence: one for the file's bytes (`field` null), and one for each text the extract prints, named as
 * erase_text_field keys them (`fileName`, `url`, `label`); the function nulls a document through a row whose field is the key or the column.
 */
function evidenceRows(items: readonly EvidenceItemView[]): RowRef[] {
  return items.flatMap((e): RowRef[] => [
    { sourceTable: 'evidence', sourceId: e.id, field: null },
    ...(e.kind === 'file' ? [{ sourceTable: 'evidence', sourceId: e.id, field: 'fileName' }] : [
      { sourceTable: 'evidence', sourceId: e.id, field: 'url' }, { sourceTable: 'evidence', sourceId: e.id, field: 'label' },
    ]),
  ]);
}

// A decision, as an extract ---------------------------------------------------------------------------------

type PartName = RecordPart;
const ALL_PARTS: ReadonlySet<PartName> = new Set<PartName>(['status', 'reason', 'options', 'evidence', 'scope']);

function declaredText(row: DecisionVersionRow): string | null {
  if (row.declaredOn === null || row.declaredPrecision === null) return null;
  const day = row.declaredOn.toISOString().slice(0, 10);
  return formatDeclaredDate(row.declaredPrecision === 'year' ? day.slice(0, 4) : row.declaredPrecision === 'month' ? day.slice(0, 7) : day);
}

function deciderText(d: SealedDecision): string | null {
  return d.decidedBy === null ? null : d.decidedBy.kind === 'member' ? d.decidedBy.user.name : ROLE_LABEL[d.decidedBy.role];
}

function provenanceOf(d: SealedDecision): string {
  const who = deciderText(d);
  const when = declaredText(d.row);
  if (who === null) return decisionSource(d.row.questionId, d.row.versionNumber);
  // A date known only to the month or the year is decided "in" it, a whole day "on" it (the precision is the row's, never read from the text).
  const decided = when !== null && (d.row.declaredPrecision === 'month' || d.row.declaredPrecision === 'year') ? decidedInLine(who, when) : decidedByLine(who, when);
  return `${decisionSource(d.row.questionId, d.row.versionNumber)} ${decided}`;
}

/** A link item's address as text. Read by key: the redirect-origin lint reads any `.url` as a request address, and this one is stored text. */
const linkOf = (e: EvidenceItemView): string | null => e['url'];

/**
 * One evidence item as a document prints it, with the SRS 7.5.6 lines for erasure (silent-failure review H6, H7): erased link text
 * reads "Text erased on <date> on the organisation's instruction.", an erased file name "File name erased", and a file whose bytes were
 * erased "<file name> . File erased on <date> on the organisation's instruction. Its fingerprint is kept, so seals that include it still check."
 * A text that is null with no tombstone is a broken row and throws.
 */
function evidenceItem(e: EvidenceItemView, snap: DocumentSnapshot): string {
  if (e.kind === 'link') {
    const label = e.label !== null ? `'${e.label}'` : erasedAt(snap, 'evidence', e.id, 'label') !== null ? textErasedLine(erasedAt(snap, 'evidence', e.id, 'label') as string) : '';
    const url = linkOf(e) ?? textOf(snap, 'evidence', e.id, 'url', null);
    return `link ${label} ${url}`.replace(/ {2,}/g, ' ');
  }
  const name = e.fileName ?? (erasedAt(snap, 'evidence', e.id, 'fileName') !== null ? FILE_NAME_ERASED : textOf(snap, 'evidence', e.id, 'fileName', null));
  if (e.erased !== null) return fileErasedLine(name, e.erased.erasedOn);
  return evidenceFileLine(name, e.sha256 === null ? null : formatFingerprint(e.sha256, 'short'));
}

/** D2: "Not applicable (<the code's label>). Reason: '<reason>'", the reason read from the decision's own content; an erased reason prints the SRS 7.5.6 line without quotes. */
function notApplicableLine(d: SealedDecision, content: LoadedContent): string {
  const reasonText = d.reasonErased !== null ? textErasedLine(d.reasonErased.erasedOn) : d.row.reason ?? NOT_RECORDED;
  const code = content.reasonCodes.find((c) => c.code === d.row.reasonCode);
  if (code === undefined) throw new Error(`documents: reason code ${String(d.row.reasonCode)} of ${d.row.id} is not in content ${content.semver}`);
  return d.reasonErased !== null ? `Not applicable (${code.label}). Reason: ${reasonText}` : `Not applicable (${code.label}). Reason: '${reasonText}'`;
}

function evidenceLine(d: SealedDecision, snap: DocumentSnapshot): string {
  return d.evidence.length === 0 ? NO_EVIDENCE : `Evidence: ${d.evidence.map((e) => evidenceItem(e, snap)).join('; ')}`;
}

/**
 * The lines and source rows of one decision. `parts` are the record parts to print; `option` restricts the options part to one
 * checklist option (a `record_option` source). The question stem comes first, and the evidence line always comes last, the list
 * or `NO_EVIDENCE` (D9, R11-19, R12-11): every evidence file printed is a source row (D13).
 */
function extract(d: SealedDecision, snap: DocumentSnapshot, parts: ReadonlySet<PartName>, option?: string): ResolvedPart {
  const content = snap.contents.get(d.row.contentVersionId);
  if (content === undefined) throw new Error(`documents: content ${d.row.contentVersionId} is not in the snapshot`);
  const own = content.questions.get(d.row.questionId);
  if (own === undefined) throw new Error(`documents: question ${d.row.questionId} is not in its own content ${content.semver}`);
  const lines: string[] = [own.text];
  const sources: RowRef[] = [];
  const reasonText = d.reasonErased !== null ? textErasedLine(d.reasonErased.erasedOn) : d.row.reason ?? NOT_RECORDED;
  const wantsReason = parts.has('reason') || parts.has('status');
  if (d.row.status === 'not_applicable' && wantsReason) {
    lines.push(notApplicableLine(d, content));
    sources.push({ sourceTable: 'decision_versions', sourceId: d.row.id, field: 'reason' });
  } else {
    if (parts.has('status') && d.row.status !== null) {
      // SRS 7.5.6: a Not yet decision prints "Not yet (<label>)", the label read from the decision's own content.
      let status = word(STATUS_WORD, d.row.status, 'status');
      if (d.row.status === 'not_yet') {
        const code = content.reasonCodes.find((c) => c.code === d.row.reasonCode);
        if (code === undefined) throw new Error(`documents: reason code ${String(d.row.reasonCode)} of ${d.row.id} is not in content ${content.semver}`);
        status = `${status} (${code.label})`;
      }
      lines.push(`Status: ${status}`);
    }
    if (parts.has('reason')) {
      lines.push(`Reason: ${reasonText}`);
      sources.push({ sourceTable: 'decision_versions', sourceId: d.row.id, field: 'reason' });
    }
  }
  if (parts.has('scope') && d.row.scopeAnswer !== null) lines.push(personalDataAnswerLine(word(SCOPE_WORD, d.row.scopeAnswer, 'scope answer')));
  // A whole decision lists the options of a checklist question; any other question has none to list.
  if (parts.has('options') && (own.type === 'checklist' || option !== undefined)) {
    if (option === undefined && own.options === undefined) throw new Error(`documents: checklist ${d.row.questionId} has no options in content ${content.semver}`);
    for (const o of option === undefined ? [...(own.options as readonly string[])] : [option]) lines.push(`${o}: ${d.row.optionsInPlace.includes(o) ? 'Ticked' : 'Not ticked'}`);
  }
  lines.push(evidenceLine(d, snap));
  sources.push(...evidenceRows(d.evidence));
  if (d.decidedBy?.kind === 'outside_role') lines.push(outsideRoleSentence(d.enteredBy.name, d.decidedBy.role));
  return part({ text: lines.join('\n'), provenance: provenanceOf(d), sources, decisionIds: [d.row.id] });
}

/** D1, D3, D4 in that order, then the extract. */
function recordPart(questionId: string, parts: ReadonlySet<PartName>, option: string | undefined, snap: DocumentSnapshot, entry: FieldMapEntry, seen: Map<string, string>): ResolvedPart {
  const sealed = snap.stages[runningQuestion(snap, questionId).stage];
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });                         // D3
  const sealIds = [sealed.seal.sealId];
  const d = sealed.decisions.get(questionId);
  const first = seen.get(questionId);
  const gate = sealed.derived.get(questionId);
  if (d === undefined && gate !== undefined) {
    // The gate answered "no": the seal records this question as not applicable because of it (SRS 7.5.6, FR-CNT-04).
    if (first !== undefined && first !== entry.fieldId) return part({ text: `See ${first}`, sealIds });
    const from = [...sealed.decisions.values()].find((x) => x.row.id === gate);
    if (from === undefined) throw new Error(`documents: question ${questionId} is derived from decision version ${gate}, which the seal does not hold`);
    return part({ text: GATE_DERIVED_NA, provenance: `${fromQuestion(from.row.questionId, from.row.versionNumber)}.`, sealIds });
  }
  if (d === undefined || d.row.status === 'withdrawn') return part({ sealIds });              // D1
  if (first !== undefined && first !== entry.fieldId) return part({ text: `See ${first}`, sealIds });   // D4, later field
  const wholeDecision = first === entry.fieldId;                                              // D4, first field of several
  const e = extract(d, snap, wholeDecision ? ALL_PARTS : parts, wholeDecision ? undefined : option);
  return { ...e, sealIds };
}

// Project, typed and structured fields ----------------------------------------------------------------------

function projectValue(snap: DocumentSnapshot, field: string): string | null {
  if (field === 'name') return snap.project.name;
  if (field === 'description') return snap.project.description;
  const v = snap.project.metadata[field] ?? null;
  if (v === null || v.trim() === '') return null;
  if (Object.hasOwn(OTHER_COMPANIONS, field) && v === 'other') {
    const companion = snap.project.metadata[OTHER_COMPANIONS[field]] ?? null;
    return companion === null || companion.trim() === '' ? 'Other' : companion;
  }
  if (field === 'datasetSize' && Object.hasOwn(DATASET_SIZE_WORDS, v)) return DATASET_SIZE_WORDS[v as keyof typeof DATASET_SIZE_WORDS];
  if (field === 'processesPersonalData' && Object.hasOwn(PERSONAL_DATA_WORDS, v)) return PERSONAL_DATA_WORDS[v as 'true' | 'false'];
  // The AI system type is stored as the form's option value; print the option's words as the form shows them (walk S1).
  if (field === 'aiSystemType') {
    const option = PROJECT_FORM_COPY.aiSystemTypes.find((o) => o.value === v);
    if (option !== undefined) return option.label;
  }
  return v;
}

const ETHICS_SUB = ['state', 'committee', 'reference', 'date', 'why', 'decidedBy'] as const;
/** The typed entries of a map, in map order: the fields a person types into (a typed source, or a typed addition beside a record or project one). */
export function typedEntries(map: FieldMap): Array<{ fieldId: string; label: string; structured?: 'ethics_approval' }> {
  return map.fields.flatMap((e) => {
    const ethics = e.sources.some((x) => x.kind === 'typed' && x.structured === 'ethics_approval');
    if (ethics) return [{ fieldId: e.fieldId, label: e.label, structured: 'ethics_approval' as const }];
    return e.typedAddition || e.sources.some((x) => x.kind === 'typed') ? [{ fieldId: e.fieldId, label: e.label }] : [];
  });
}

/** The sub-field ids of DC-15 (CG-10): `DC-15:state` and the rest. */
export const ethicsFieldIds = (fieldId: string): string[] => ETHICS_SUB.map((s) => `${fieldId}:${s}`);

function ethicsText(fieldId: string, typed: Readonly<Record<string, string>>): string | null {
  const get = (s: (typeof ETHICS_SUB)[number]) => (typed[`${fieldId}:${s}`] ?? '').trim() || NOT_RECORDED;
  const state = (typed[`${fieldId}:state`] ?? '').trim();
  if (state === ETHICS_APPROVED) return `Approved (committee: ${get('committee')}; reference: ${get('reference')}; date: ${get('date')})`;
  if (state === ETHICS_SUBMITTED) return 'Submitted, awaiting decision';
  if (state === ETHICS_NOT_REQUIRED) return `Not required (why: ${get('why')}; decided by: ${get('decidedBy')})`;
  return null;
}

function typedPart(entry: FieldMapEntry, structured: 'ethics_approval' | undefined, typed: Readonly<Record<string, string>>): ResolvedPart {
  const value = structured === 'ethics_approval' ? ethicsText(entry.fieldId, typed) : (typed[entry.fieldId] ?? '').trim() === '' ? null : typed[entry.fieldId];
  return value === null ? part() : part({ text: `${value}\n${TYPED_MARK}` });
}

// Findings, mitigations, accepted risks ---------------------------------------------------------------------

const NONE = 'None';

function areaText(snap: DocumentSnapshot, id: string | null): string {
  if (id === null) return 'none';
  const name = running(snap).areas.get(id)?.name;
  return name === undefined ? id : `${id} ${name}`;
}

/** A finding's title: a shortfall finding is raised with none (its question is its subject); a null on any other is an erasure. */
function findingTitle(f: FindingView, snap: DocumentSnapshot): string {
  const shortfall = f.source === 'shortfall' && f.questionId !== null;
  return f.title ?? (shortfall ? `Finding on ${f.questionId}` : textOf(snap, 'findings', f.id, 'title', null));
}

function findingCounts(sealed: SealedStage): ResolvedPart {
  const n = (state: FindingView['state']) => sealed.findings.filter(({ finding }) => finding.state === state).length;
  return part({
    text: `Open findings: ${n('open')}. Closed by a mitigation: ${n('closed_mitigation')}. Closed by an accepted risk: ${n('closed_accepted_risk')}.`,
    sealIds: [sealed.seal.sealId],
  });
}

function resolveFindings(source: Extract<FieldSource, { kind: 'findings' }>, snap: DocumentSnapshot): ResolvedPart {
  const sealed = stageSource(source.stage, snap);
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });
  if (source.filter === 'counts') return findingCounts(sealed);
  const versions = new Map([...sealed.decisions.values()].map((d) => [d.row.id, d.row.versionNumber]));
  const wanted = (state: FindingView['state']): boolean => {
    if (source.filter === 'open') return state === 'open';
    if (source.filter === 'closed_by_mitigation') return state === 'closed_mitigation';
    return source.filter === 'all' || state !== 'withdrawn';
  };
  const items = sealed.findings.filter(({ finding: f }) =>
    wanted(f.state) && (source.areas === undefined || (f.riskArea !== null && source.areas.includes(f.riskArea))));
  const sources: RowRef[] = [];
  const text = items.length === 0 ? NONE : items.map(({ finding: f }, i) => {
    const version = f.decisionVersionId === null ? undefined : versions.get(f.decisionVersionId);
    const origin = f.source === 'team' || f.questionId === null ? 'Raised by the team' : fromQuestion(f.questionId, version);
    sources.push({ sourceTable: 'findings', sourceId: f.id, field: 'title' }, { sourceTable: 'findings', sourceId: f.id, field: 'description' });
    const shortfall = f.source === 'shortfall' && f.questionId !== null;
    return [`${i + 1}. ${findingTitle(f, snap)}`, `Source: ${origin}`, `Risk area: ${areaText(snap, f.riskArea)}`,
      ...(f.description === null && shortfall ? [] : [`Description: ${textOf(snap, 'findings', f.id, 'description', f.description)}`]),
      ...(source.filter === 'open' ? [`Raised on: ${formatUtcDay(f.raisedAt)}`] : []),
      findingStatusLine(word(FINDING_STATE_WORD, f.state, 'finding state'))].join('\n');
  }).join('\n\n');
  return part({ text, sources, sealIds: [sealed.seal.sealId] });
}

const MITIGATION_STATUS_WORD: Readonly<Record<string, string>> = { planned: 'Planned', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };

/** The owner's sentence for a done mitigation that closed its finding because of a decision (register row D-408). */
const CLOSED_BY_DECISION: Readonly<Record<string, string>> = {
  decision_changed: FINDINGS_COPY.mitigation.closedBecauseDecisionChanged,
  decision_withdrawn: FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn,
};

/**
 * What a mitigation did, as a document prints it. A done mitigation of a decision kind that never had text and was never erased
 * (`closeByDecision` writes it so) prints the owner's sentence (D-408); every other row goes through `textOf`, so any other null
 * with no tombstone still throws.
 */
function mitigationWhat(m: MitigationVersionView, snap: DocumentSnapshot): string {
  const sentence = Object.hasOwn(CLOSED_BY_DECISION, m.kind) ? CLOSED_BY_DECISION[m.kind] : undefined;
  if (m.what === null && m.status === 'done' && sentence !== undefined && erasedAt(snap, 'mitigation_versions', m.id, 'what') === null) return sentence;
  return textOf(snap, 'mitigation_versions', m.id, 'what', m.what);
}

/** One mitigation as a document prints it: what, owner, due date, then the control it follows. `sources` takes the rows the text came from. */
function mitigationLines(m: MitigationVersionView, snap: DocumentSnapshot, sources: RowRef[]): string[] {
  sources.push({ sourceTable: 'mitigation_versions', sourceId: m.id, field: 'what' });
  const lines = [mitigationWhat(m, snap), assignedToLine(m.owner.name), `Due: ${formatDay(m.dueDate)}`];
  if (m.followsControl !== null) {
    const control = running(snap).controls.get(m.followsControl);
    lines.push(`Control followed: ${m.followsControl}${control === undefined ? '' : ` ${control.name}`}`);
  }
  return lines;
}

/** The current mitigation versions of the sealed stage, counted by status; those of withdrawn findings are not counted. */
function mitigationCounts(sealed: SealedStage, snap: DocumentSnapshot): ResolvedPart {
  const counted = sealed.findings.filter(({ finding }) => finding.state !== 'withdrawn');
  const all = counted.flatMap(({ finding, mitigations }) => mitigations.map((m) => ({ m, state: finding.state })));
  const n = (status: string) => all.filter(({ m }) => m.status === status).length;
  const overdue = all.filter(({ m, state }) => isOverdue({ status: m.status, dueDate: m.dueDate }, state, snap.today)).length;
  return part({
    text: `Mitigations planned: ${n('planned')}, in progress: ${n('in_progress')}, done: ${n('done')}, cancelled: ${n('cancelled')}, overdue: ${overdue}.`,
    sealIds: [sealed.seal.sealId],
  });
}

/** MP-03: each open finding's mitigations, from the sealed manifest's versions (NFR-INT-10); nothing when no finding is open. */
function currentMitigations(sealed: SealedStage, snap: DocumentSnapshot): ResolvedPart {
  const open = sealed.findings.filter(({ finding }) => finding.state === 'open');
  if (open.length === 0) return part({ sealIds: [sealed.seal.sealId] });
  const sources: RowRef[] = [];
  const text = open.map(({ finding, mitigations }, i) => {
    sources.push({ sourceTable: 'findings', sourceId: finding.id, field: 'title' });
    const blocks = mitigations.map((m, j) => {
      const status = word(MITIGATION_STATUS_WORD, m.status, 'mitigation status');
      const late = isOverdue({ status: m.status, dueDate: m.dueDate }, finding.state, snap.today) ? ' (overdue)' : '';
      const [what, ...rest] = mitigationLines(m, snap, sources);
      return [`Mitigation ${j + 1}: ${what}`, ...rest, `Status: ${status}${late}`].join('\n');
    });
    return [`${i + 1}. ${findingTitle(finding, snap)}`, ...(blocks.length === 0 ? ['Mitigations: None'] : blocks)].join('\n');
  }).join('\n\n');
  return part({ text, sources, sealIds: [sealed.seal.sealId] });
}

function resolveMitigations(source: Extract<FieldSource, { kind: 'mitigations' }>, snap: DocumentSnapshot): ResolvedPart {
  const sealed = stageSource(source.stage, snap);
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });
  if (source.filter === 'counts') return mitigationCounts(sealed, snap);
  if (source.filter === 'current') return currentMitigations(sealed, snap);
  // A mitigation plan lists the done mitigations of the findings it calls closed by a mitigation, each with its finding; the cards list every done one.
  const plan = snap.documentType === 'mitigation_plan';
  const done = sealed.findings
    .filter(({ finding }) => !plan || finding.state === 'closed_mitigation')
    .flatMap(({ finding, mitigations }) => mitigations.filter((m) => m.status === 'done').map((m) => ({ finding, m })));
  // The plan's findings list above already says None; a second None under the same field would only repeat it.
  if (done.length === 0 && plan) return part({ sealIds: [sealed.seal.sealId] });
  const sources: RowRef[] = [];
  const text = done.length === 0 ? NONE : done.map(({ finding, m }, i) => {
    const [what, ...rest] = mitigationLines(m, snap, sources);
    const lines = [`${i + 1}. ${what}`, ...(plan ? [`Finding: ${findingTitle(finding, snap)}`] : []), ...rest];
    if (plan && finding.title !== null) sources.push({ sourceTable: 'findings', sourceId: finding.id, field: 'title' });
    if (m.closureNote !== null || erasedAt(snap, 'mitigation_versions', m.id, 'closureNote') !== null) {
      lines.push(`Closure note: ${textOf(snap, 'mitigation_versions', m.id, 'closureNote', m.closureNote)}`);
      sources.push({ sourceTable: 'mitigation_versions', sourceId: m.id, field: 'closureNote' });
    }
    if (m.evidence.length > 0) {
      lines.push(doneEvidenceLine(m.evidence.map((e) => evidenceItem(e, snap)).join('; ')));
      sources.push(...evidenceRows(m.evidence));
    }
    return lines.join('\n');
  }).join('\n\n');
  return part({ text, sources, sealIds: [sealed.seal.sealId] });
}

function resolveAcceptedRisks(source: Extract<FieldSource, { kind: 'accepted_risks' }>, snap: DocumentSnapshot): ResolvedPart {
  const sealed = stageSource(source.stage, snap);
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });
  const risks = sealed.findings.filter((f) => f.acceptedRisk !== null);
  const sources: RowRef[] = [];
  const text = risks.length === 0 ? NONE : risks.map(({ finding, acceptedRisk }, i) => {
    const r = acceptedRisk as NonNullable<typeof acceptedRisk>;
    const who = r.acceptedBy.kind === 'member' ? r.acceptedBy.user.name : ROLE_LABEL[r.acceptedBy.role];
    const labelled = finding.title === null && finding.source === 'shortfall' && finding.questionId !== null;
    const lines = [`${i + 1}. ${labelled ? `Finding on ${finding.questionId}` : textOf(snap, 'findings', finding.id, 'title', finding.title)}`, `Accepted by: ${who}`];
    // The title is printed here whether or not MC-23 lists this finding, so erasing it must reach this document too (D13).
    if (!labelled) sources.push({ sourceTable: 'findings', sourceId: finding.id, field: 'title' });
    if (r.acceptedBy.kind === 'outside_role') lines.push(outsideRoleSentence(r.enteredBy.name, r.acceptedBy.role));
    lines.push(`Reason: ${textOf(snap, 'accepted_risks', r.id, 'reason', r.reason)}`);
    sources.push({ sourceTable: 'accepted_risks', sourceId: r.id, field: 'reason' });
    if (r.lookAgainOn !== null) lines.push(checkAgainLine(formatDay(r.lookAgainOn)));
    if (r.lookAgainNote !== null || erasedAt(snap, 'accepted_risks', r.id, 'lookAgainNote') !== null) {
      lines.push(lastCheckNoteLine(textOf(snap, 'accepted_risks', r.id, 'lookAgainNote', r.lookAgainNote)));
      sources.push({ sourceTable: 'accepted_risks', sourceId: r.id, field: 'lookAgainNote' });
    }
    return lines.join('\n');
  }).join('\n\n');
  return part({ text, sources, sealIds: [sealed.seal.sealId] });
}

// Meta -------------------------------------------------------------------------------------------------------

/** The chosen seal first, then the other sealed stages in STAGES order (G069). */
function sealsOf(snap: DocumentSnapshot): SealedStage[] {
  return [snap.chosen, ...STAGES.filter((s) => s !== snap.reviewStage).flatMap((s) => (snap.stages[s] === null ? [] : [snap.stages[s] as SealedStage]))];
}

function sealLine(s: SealedStage): string {
  const at = utcSecond(s.seal.sealedAt);
  const n = s.seal.enteredByPeople;
  return `Seal ${s.seal.sealNumber} of ${s.seal.reviewName}: sealed ${at} by ${s.seal.sealedBy.name} (${word(REVIEW_COPY.roleWords, s.seal.sealedByRole, 'role')}); decisions entered by ${n} ${n === 1 ? 'person' : 'people'}. Fingerprint ${formatFingerprint(s.seal.fingerprint, 'full')}`;
}

function resolveMeta(source: Extract<FieldSource, { kind: 'meta' }>, snap: DocumentSnapshot): ResolvedPart {
  if (source.item === 'seals') {
    const seals = sealsOf(snap);
    return part({ text: seals.map(sealLine).join('\n'), sealIds: seals.map((s) => s.seal.sealId) });
  }
  if (source.item === 'deciders') {
    const names = new Set<string>();
    for (const s of sealsOf(snap)) for (const d of s.decisions.values()) { const who = deciderText(d); if (who !== null) names.add(who); }
    return names.size === 0 ? part() : part({ text: [...names].join('; ') });
  }
  if (source.item === 'review') return reviewLine(snap.chosen, snap);
  if (source.item === 'no_decision') return noDecisionList(snap);
  return notApplicableList(snap);
}

/**
 * MP-01: the stage, the review's name and its "Prepared for" note, which is omitted when empty (SRS 10.3.4). A note the operator erased
 * prints the SRS 7.5.6 erasure line in its place (the snapshot holds it as null with a tombstone on the review).
 */
function reviewLine(s: SealedStage, snap: DocumentSnapshot): ResolvedPart {
  const erasedOn = erasedAt(snap, 'stage_reviews', s.seal.reviewId, 'preparedFor');
  const note = s.preparedFor !== null && s.preparedFor.trim() !== '' ? s.preparedFor : erasedOn !== null ? textErasedLine(erasedOn) : null;
  // The note is team text that an operator may erase, so its row is a source of this document (D13).
  const sources: RowRef[] = note === null ? [] : [{ sourceTable: 'stage_reviews', sourceId: s.seal.reviewId, field: 'preparedFor' }];
  return part({ text: reviewLineText(FINDINGS_COPY.stages[s.stage], s.seal.reviewName, note), sources, sealIds: [s.seal.sealId] });
}

/** MP-07: the chosen seal's questions that hold no decision, each with its stem from the content the seal was made on (as MP-04 reads it). */
function noDecisionList(snap: DocumentSnapshot): ResolvedPart {
  const s = snap.chosen;
  const ids = s.manifest.decisions.flatMap((d) => ('none' in d ? [d.question] : []));
  const content = ids.length === 0 ? null : loadContent(s.manifest.content.semver);
  const stem = (q: string): string => {
    const text = (content as LoadedContent).questions.get(q)?.text;
    if (text === undefined) throw new Error(`documents: question ${q} is not in content ${s.manifest.content.semver}`);
    return text;
  };
  return part({ text: ids.length === 0 ? NONE : ids.map((q) => `${q}: ${stem(q)}`).join('\n'), sealIds: [s.seal.sealId] });
}

/** MP-08: the chosen seal's not applicable questions with the code's label and the reason, then those the scope answer made not applicable (SRS 7.5.6). */
function notApplicableList(snap: DocumentSnapshot): ResolvedPart {
  const s = snap.chosen;
  const sources: RowRef[] = [];
  const provenance: string[] = [];
  const lines: string[] = [];
  const decided = [...s.decisions.values()].filter((d) => d.row.status === 'not_applicable');
  for (const d of decided) {
    const content = snap.contents.get(d.row.contentVersionId);
    if (content === undefined) throw new Error(`documents: content ${d.row.contentVersionId} is not in the snapshot`);
    lines.push(`${d.row.questionId}: ${notApplicableLine(d, content)}`);
    provenance.push(provenanceOf(d));
    sources.push({ sourceTable: 'decision_versions', sourceId: d.row.id, field: 'reason' });
  }
  for (const [question, gate] of s.derived) {
    const from = [...s.decisions.values()].find((x) => x.row.id === gate);
    if (from === undefined) throw new Error(`documents: question ${question} is derived from decision version ${gate}, which the seal does not hold`);
    lines.push(`${question}: ${GATE_DERIVED_NA}`);
    provenance.push(`${fromQuestion(from.row.questionId, from.row.versionNumber)}.`);
  }
  return part({
    text: lines.length === 0 ? NONE : lines.join('\n'), provenance: provenance.join('\n'), sources, sealIds: [s.seal.sealId],
    decisionIds: decided.map((d) => d.row.id),
  });
}

/** MP-04: the controls the framework suggests for the risk area of each open finding, read from the content the seal was made on. */
function mappedControls(snap: DocumentSnapshot): ResolvedPart {
  const s = snap.chosen;
  const c = loadContent(s.manifest.content.semver);
  const sources: RowRef[] = [];
  const blocks = s.findings.filter(({ finding }) => finding.state === 'open' && finding.riskArea !== null).map(({ finding }) => {
    sources.push({ sourceTable: 'findings', sourceId: finding.id, field: 'title' });
    const controls = controlsForArea(c, finding.riskArea as string).flatMap((g) => g.controls.map((x) => `${x.control.id} ${x.control.name}`));
    return [findingTitle(finding, snap), `Risk area: ${areaText(snap, finding.riskArea)}`, `Controls: ${controls.length === 0 ? NONE : controls.join('; ')}`];
  });
  const text = blocks.length === 0 ? NONE : blocks.map((b, i) => [`${i + 1}. ${b[0]}`, ...b.slice(1)].join('\n')).join('\n\n');
  return part({ text, sources, sealIds: [s.seal.sealId] });
}

export const SOURCE_RESOLVERS: { [K in FieldSource['kind']]: SourceResolver<K> } = {
  record: (s, snap, _typed, entry, seen) => recordPart(s.questionId, new Set(s.parts), undefined, snap, entry, seen),
  record_option: (s, snap, _typed, entry, seen) => recordPart(s.questionId, new Set<PartName>(['reason', 'options']), s.option, snap, entry, seen),
  project: (s, snap) => {
    const v = projectValue(snap, s.field);
    return v === null || v.trim() === '' ? part() : part({ text: `${v}\n${PROJECT_MARK}` });
  },
  typed: (s, _snap, typed, entry) => typedPart(entry, s.structured, typed),
  findings: (s, snap) => resolveFindings(s, snap),
  mitigations: (s, snap) => resolveMitigations(s, snap),
  accepted_risks: (s, snap) => resolveAcceptedRisks(s, snap),
  meta: (s, snap) => resolveMeta(s, snap),
  mapping: (_s, snap) => mappedControls(snap),
};

// resolveFields ------------------------------------------------------------------------------------------------

const rowKey = (r: RowRef) => `${r.sourceTable}|${r.sourceId}|${r.field ?? ''}`;
const isDeferred = (s: FieldSource) => s.kind === 'meta' && (s.item === 'seals' || s.item === 'deciders');

/** The snapshot as the seals and deciders fields see it: only the seals the other fields read, and only the decisions they printed. */
function narrowed(snap: DocumentSnapshot, usedSeals: ReadonlySet<string>, printed: ReadonlySet<string>): DocumentSnapshot {
  const keep = (s: SealedStage | null): SealedStage | null => {
    if (s === null || (s.seal.sealId !== snap.chosen.seal.sealId && !usedSeals.has(s.seal.sealId))) return null;
    return { ...s, decisions: new Map([...s.decisions].filter(([, d]) => printed.has(d.row.id))) };
  };
  const stages = Object.fromEntries(STAGES.map((s) => [s, keep(snap.stages[s])])) as DocumentSnapshot['stages'];
  return { ...snap, stages, chosen: stages[snap.reviewStage] as SealedStage };
}

/**
 * Fills a field map from a snapshot and the team's typed values (FR-DOC-02). The `seen` map is filled once, before any resolver
 * runs: a question that more than one entry of the map names is printed whole in the first of them in map order and as
 * `See <that id>` in the rest (D4). The seals and deciders fields run last, over the seals the other fields read and the decisions
 * they printed, because they list what the document used. `sealIds` is the chosen seal first, then the others in STAGES order.
 */
export function resolveFields(map: FieldMap, snap: DocumentSnapshot, typed: Readonly<Record<string, string>>): {
  fields: ResolvedField[]; notRecordedFields: string[]; typedFieldIds: string[];
  sources: Array<{ sourceTable: string; sourceId: string; field: string | null }>; sealIds: string[];
} {
  const named = new Map<string, string[]>();
  for (const e of map.fields) {
    for (const q of new Set(e.sources.flatMap((s) => (s.kind === 'record' || s.kind === 'record_option' ? [s.questionId] : [])))) named.set(q, [...(named.get(q) ?? []), e.fieldId]);
  }
  const seen = new Map<string, string>([...named].filter(([, ids]) => ids.length > 1).map(([q, ids]) => [q, ids[0]]));

  const parts = map.fields.map((e) => e.sources.map((s) => (isDeferred(s) ? null : SOURCE_RESOLVERS[s.kind as 'record'](s as never, snap, typed, e, seen))));
  const typedAdditions = map.fields.map((e) => (e.typedAddition ? typedPart(e, undefined, typed) : null));

  const usedSeals = new Set(parts.flat().flatMap((p) => p?.sealIds ?? []));
  const printed = new Set(parts.flat().flatMap((p) => p?.decisionIds ?? []));
  const narrow = narrowed(snap, usedSeals, printed);
  map.fields.forEach((e, i) => e.sources.forEach((s, j) => {
    if (isDeferred(s)) parts[i][j] = SOURCE_RESOLVERS.meta(s as Extract<FieldSource, { kind: 'meta' }>, narrow, typed, e, seen);
  }));

  const sources = new Map<string, RowRef>();
  const incomplete = new Set<string>();   // fields with a gap the preview marks (FR-DOC-08): see the rules below
  const fields: ResolvedField[] = map.fields.map((e, i) => {
    const own = parts[i] as ResolvedPart[];
    const addition = typedAdditions[i];
    const all = [...own, ...(addition === null ? [] : [addition])];
    // Each part with the source it came from; the typed addition is a typed part after the map's sources.
    const slots: Array<{ p: ResolvedPart; source: FieldSource | { kind: 'typed' } }> = [
      ...own.map((p, j) => ({ p, source: e.sources[j] })), ...(addition === null ? [] : [{ p: addition, source: { kind: 'typed' as const } }]),
    ];
    // A "place" part stands for one thing of the record or the project; the others (findings, mitigations, meta, mapping) print as they are.
    const isPlace = (s: { kind: string }) => s.kind === 'record' || s.kind === 'record_option' || s.kind === 'project' || s.kind === 'typed';
    const isValue = (p: ResolvedPart) => p.text !== null && p.text !== NOT_RECORDED_AT_ISSUE;
    const places = slots.filter((s) => isPlace(s.source));
    // The owner's decision of 14 November 2026 (walk finding S1), for a field with several parts: beside a value, an empty typed or
    // project part prints nothing and a question with no decision prints the sentence naming it; with no value in any place part,
    // the place parts print "Not recorded" once (or the never-sealed line once, in its stead). A single part is printed as it is.
    const several = all.length > 1;
    const hasValue = places.some((s) => isValue(s.p));
    const firstPlace = places.length === 0 ? null : places[0];
    const placeGap = places.some((s) => s.p.text === NOT_RECORDED_AT_ISSUE) ? NOT_RECORDED_AT_ISSUE : NOT_RECORDED;
    if (places.length > 0 && !hasValue) incomplete.add(e.fieldId);
    let atIssue = false;
    // The never-sealed line prints once in a field, whichever part brings it.
    const once = (t: string): string[] => {
      if (t !== NOT_RECORDED_AT_ISSUE) return [t];
      if (atIssue) return [];
      atIssue = true;
      return [t];
    };
    const texts = slots.flatMap((slot): string[] => {
      const { p, source } = slot;
      if (several && isPlace(source) && !hasValue) return slot === firstPlace ? once(placeGap) : [];
      if (p.text === null) {
        if (!several || !isPlace(source)) return [];
        if (source.kind === 'record' || source.kind === 'record_option') { incomplete.add(e.fieldId); return [noDecisionLine(source.questionId)]; }
        return [];   // an empty typed box or project value beside a value
      }
      return once(p.text);
    });
    if (texts.includes(NOT_RECORDED_AT_ISSUE)) incomplete.add(e.fieldId);
    for (const p of all) for (const r of p.sources) sources.set(rowKey(r), r);
    return {
      fieldId: e.fieldId, label: e.label, section: e.section, text: texts.length === 0 ? null : texts.join('\n'),
      provenance: all.map((p) => p.provenance).filter((p) => p !== '').join('\n'),
    };
  });

  const sealIds = sealsOf(narrow).map((s) => s.seal.sealId);
  return {
    fields,
    notRecordedFields: fields.filter((f) => f.text === null || f.text === NOT_RECORDED_AT_ISSUE || incomplete.has(f.fieldId)).map((f) => f.fieldId),
    typedFieldIds: typedEntries(map).map((e) => e.fieldId),
    sources: [...sources.values()], sealIds,
  };
}
