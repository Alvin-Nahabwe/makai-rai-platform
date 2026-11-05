import type { OrgRole } from '@prisma/client';
import type { CalendarDate, DecisionVersionRow, DocumentType, OutsideRole, ScopeAnswer, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, ErasedMark, EvidenceItemView, FindingEventView, FindingView, MitigationVersionView, UserRef,
} from '@/types/api';
import type { LoadedContent, LoadedQuestion } from '@/types/content';
import type { FieldMap, FieldMapEntry, FieldSource, RecordPart, SourceStage } from '@/types/documents';
import type { SealManifestV1, SealRef } from '@/types/seal';
import { runningContent } from '@/lib/content/loader';
import { NotImplementedError } from '@/lib/http/errors';
import { formatDay, formatDeclaredDate } from '@/lib/format/dates';
import { DATASET_SIZE_WORDS, PERSONAL_DATA_WORDS } from '@/lib/project/labels';
import { formatFingerprint } from '@/lib/seal/format';
import type { ResolvedField } from './render';

/**
 * Field resolution for the data card and the model card (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1). The copy below is
 * fixed by the SRS; the document tests import these constants rather than repeat the text.
 */

export const STATEMENT = 'Generated from this team\'s own records in the MAK-AI RAI Platform. Not an ethics approval, audit, certification or compliance statement.'; // FR-DOC-02, SRS line 1025
export const SEALED_NOTE = 'Sealed by the platform; not independently time-stamped.';   // 6.5, D8, R-56
export const NOT_RECORDED = 'Not recorded';                                           // FR-DOC-02, D1
export const NOT_RECORDED_AT_ISSUE = 'Not recorded at the time of issue';             // FR-DOC-05, D3
export const PROJECT_MARK = 'From the project description when this document was issued; not part of the sealed record'; // FR-DOC-02
export const TYPED_MARK = 'Typed for this document; not part of the sealed record';   // FR-DOC-03
export const NO_EVIDENCE = 'Evidence: none attached';                                 // FR-DOC-02, D9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 7.5.8 "2 Nov 2026" from the UTC date of `iso`. A fixed month list: `Intl` prints "Sept" for September on this Node. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError('formatUtcDay: not a date');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

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
}

// ─── Field resolution (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1 D1 to D9) ─────────────────────────────────

/** The companion text field of each project value that can be "other" (as `components/dashboard/ProjectCard.tsx` shows it). */
export const OTHER_COMPANIONS: Readonly<Record<string, string>> = { aiSystemType: 'aiSystemTypeOther', deploymentSector: 'deploymentSectorOther', datasetType: 'datasetTypeOther' };

type RowRef = { sourceTable: string; sourceId: string; field: string | null };
export interface ResolvedPart { text: string | null; provenance: string; sources: RowRef[]; sealIds: string[] }
export type SourceResolver<K extends FieldSource['kind']> = (
  source: Extract<FieldSource, { kind: K }>, snap: DocumentSnapshot, typed: Readonly<Record<string, string>>, entry: FieldMapEntry, seen: Map<string, string>,
) => ResolvedPart;

const part = (p: Partial<ResolvedPart> = {}): ResolvedPart => ({ text: null, provenance: '', sources: [], sealIds: [], ...p });

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

const ERASED = 'Erased';
const erasedOn = (date: CalendarDate) => `Erased on ${formatDay(date)}`;
/** FR-DOC-02 / D7: the sentence that stops a team's entry reading as the outside body's own record. */
export const outsideRoleSentence = (member: string, role: OutsideRole): string =>
  `Recorded by ${member} as decided by ${ROLE_LABEL[role]}. The ${ROLE_LABEL[role]} did not record this in the platform.`;

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
 * The source rows of printed evidence: one for the file's bytes (`field` null), and one for each text the extract prints, named as the
 * column (`filename`, `url`, `label`), because `erase_text_field` nulls a document only through a row whose field matches the erased column.
 */
function evidenceRows(items: readonly EvidenceItemView[]): RowRef[] {
  return items.flatMap((e): RowRef[] => [
    { sourceTable: 'evidence', sourceId: e.id, field: null },
    ...(e.kind === 'file' ? [{ sourceTable: 'evidence', sourceId: e.id, field: 'filename' }] : [
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
  const decided = who === null ? '' : ` Decided by ${who}${when === null ? '' : `; declared ${when}`}.`;
  return `From ${d.row.questionId} v${d.row.versionNumber} (content ${d.content.semver}).${decided}`;
}

function evidenceLine(d: SealedDecision): string {
  if (d.evidence.length === 0) return NO_EVIDENCE;
  const items = d.evidence.map((e) => {
    if (e.kind === 'link') return `link ${e.label === null ? '' : `'${e.label}' `}${e.url ?? ''}`.trim();
    const sha = e.sha256 === null ? '' : ` (SHA-256 ${formatFingerprint(e.sha256, 'short')})`;
    return e.erased !== null ? `file erased on ${formatDay(e.erased.erasedOn)}` : `file ${e.fileName ?? ''}${sha}`.trim();
  });
  return `Evidence: ${items.join('; ')}`;
}

/**
 * The lines and source rows of one decision. `parts` are the record parts to print; `option` restricts the options part to one
 * checklist option (a `record_option` source). The question stem comes first, and the evidence line always comes last, the list
 * or `NO_EVIDENCE` (D9, R11-19, R12-11): every evidence file printed is a source row (D13).
 */
function extract(d: SealedDecision, snap: DocumentSnapshot, parts: ReadonlySet<PartName>, option?: string): ResolvedPart {
  const own = (snap.contents.get(d.row.contentVersionId) ?? running(snap)).questions.get(d.row.questionId);
  const lines: string[] = [own?.text ?? d.row.questionId];
  const sources: RowRef[] = [];
  const reasonText = d.reasonErased !== null ? erasedOn(d.reasonErased.erasedOn) : d.row.reason ?? NOT_RECORDED;
  const wantsReason = parts.has('reason') || parts.has('status');
  if (d.row.status === 'not_applicable' && wantsReason) {
    // D2: the code's label, then the reason.
    const label = (snap.contents.get(d.row.contentVersionId)?.reasonCodes ?? []).find((c) => c.code === d.row.reasonCode)?.label ?? d.row.reasonCode ?? NOT_RECORDED;
    lines.push(`Not applicable (${label}). Reason: '${reasonText}'`);
    sources.push({ sourceTable: 'decision_versions', sourceId: d.row.id, field: 'reason' });
  } else {
    if (parts.has('status') && d.row.status !== null && STATUS_WORD[d.row.status] !== undefined) lines.push(`Status: ${STATUS_WORD[d.row.status]}`);
    if (parts.has('reason')) {
      lines.push(`Reason: ${reasonText}`);
      sources.push({ sourceTable: 'decision_versions', sourceId: d.row.id, field: 'reason' });
    }
  }
  if (parts.has('scope') && d.row.scopeAnswer !== null) lines.push(`Scope answer: ${SCOPE_WORD[d.row.scopeAnswer]}`);
  if (parts.has('options')) {
    for (const o of option === undefined ? [...(own?.options ?? [])] : [option]) lines.push(`${o}: ${d.row.optionsInPlace.includes(o) ? 'Ticked' : 'Not ticked'}`);
  }
  lines.push(evidenceLine(d));
  sources.push(...evidenceRows(d.evidence));
  if (d.decidedBy?.kind === 'outside_role') lines.push(outsideRoleSentence(d.enteredBy.name, d.decidedBy.role));
  return part({ text: lines.join('\n'), provenance: provenanceOf(d), sources });
}

/** D1, D3, D4 in that order, then the extract. */
function recordPart(questionId: string, parts: ReadonlySet<PartName>, option: string | undefined, snap: DocumentSnapshot, entry: FieldMapEntry, seen: Map<string, string>): ResolvedPart {
  const sealed = snap.stages[runningQuestion(snap, questionId).stage];
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });                         // D3
  const sealIds = [sealed.seal.sealId];
  const d = sealed.decisions.get(questionId);
  if (d === undefined || d.row.status === 'withdrawn') return part({ sealIds });              // D1
  const first = seen.get(questionId);
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
  return v;
}

const ETHICS_SUB = ['state', 'committee', 'reference', 'date', 'why', 'decidedBy'] as const;
/** The sub-field ids of DC-15 (CG-10): `DC-15:state` and the rest. */
export const ethicsFieldIds = (fieldId: string): string[] => ETHICS_SUB.map((s) => `${fieldId}:${s}`);

function ethicsText(fieldId: string, typed: Readonly<Record<string, string>>): string | null {
  const get = (s: (typeof ETHICS_SUB)[number]) => (typed[`${fieldId}:${s}`] ?? '').trim() || NOT_RECORDED;
  const state = (typed[`${fieldId}:state`] ?? '').trim();
  if (state === 'approved') return `Approved (committee: ${get('committee')}; reference: ${get('reference')}; date: ${get('date')})`;
  if (state === 'submitted') return 'Submitted, awaiting decision';
  if (state === 'not_required') return `Not required (why: ${get('why')}; decided by: ${get('decidedBy')})`;
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

function resolveFindings(source: Extract<FieldSource, { kind: 'findings' }>, snap: DocumentSnapshot): ResolvedPart {
  if (source.filter !== 'all' && source.filter !== 'open_and_closed') throw new NotImplementedError('DOC-b');
  const sealed = stageSource(source.stage, snap);
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });
  const versions = new Map([...sealed.decisions.values()].map((d) => [d.row.id, d.row.versionNumber]));
  const items = sealed.findings.filter(({ finding: f }) =>
    (source.filter === 'all' || f.state !== 'withdrawn') && (source.areas === undefined || (f.riskArea !== null && source.areas.includes(f.riskArea))));
  const sources: RowRef[] = [];
  const text = items.length === 0 ? NONE : items.map(({ finding: f }, i) => {
    const version = f.decisionVersionId === null ? undefined : versions.get(f.decisionVersionId);
    const origin = f.source === 'team' || f.questionId === null ? 'Raised by the team' : `From ${f.questionId}${version === undefined ? '' : ` v${version}`}`;
    sources.push({ sourceTable: 'findings', sourceId: f.id, field: 'title' }, { sourceTable: 'findings', sourceId: f.id, field: 'description' });
    // A shortfall finding is raised with no title or description (the question is its subject); a null on any other is an erasure.
    const shortfall = f.source === 'shortfall' && f.questionId !== null;
    const title = f.title ?? (shortfall ? `Finding on ${f.questionId}` : ERASED);
    return [`${i + 1}. ${title}`, `Source: ${origin}`, `Risk area: ${areaText(snap, f.riskArea)}`,
      ...(f.description === null && shortfall ? [] : [`Description: ${f.description ?? ERASED}`]), `State: ${FINDING_STATE_WORD[f.state]}`].join('\n');
  }).join('\n\n');
  return part({ text, sources, sealIds: [sealed.seal.sealId] });
}

function resolveMitigations(source: Extract<FieldSource, { kind: 'mitigations' }>, snap: DocumentSnapshot): ResolvedPart {
  if (source.filter !== 'done') throw new NotImplementedError('DOC-b');
  const sealed = stageSource(source.stage, snap);
  if (sealed === null) return part({ text: NOT_RECORDED_AT_ISSUE });
  const done = sealed.findings.flatMap((f) => f.mitigations).filter((m) => m.status === 'done');
  const sources: RowRef[] = [];
  const text = done.length === 0 ? NONE : done.map((m, i) => {
    const lines = [`${i + 1}. ${m.erasedFields.includes('what') || m.what === null ? ERASED : m.what}`, `Owner: ${m.owner.name}`, `Due: ${formatDay(m.dueDate)}`];
    sources.push({ sourceTable: 'mitigation_versions', sourceId: m.id, field: 'what' });
    if (m.followsControl !== null) {
      const control = running(snap).controls.get(m.followsControl);
      lines.push(`Control followed: ${m.followsControl}${control === undefined ? '' : ` ${control.name}`}`);
    }
    if (m.closureNote !== null || m.erasedFields.includes('closureNote')) {
      lines.push(`Closure note: ${m.closureNote ?? ERASED}`);
      sources.push({ sourceTable: 'mitigation_versions', sourceId: m.id, field: 'closureNote' });
    }
    if (m.evidence.length > 0) {
      lines.push(`Closure evidence: ${m.evidence.map((e) => (e.kind === 'link' ? `link ${e.label ?? ''} ${e.url ?? ''}`.trim() : `file ${e.fileName ?? ''}`.trim())).join('; ')}`);
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
    const lines = [`${i + 1}. ${finding.title ?? (finding.questionId !== null ? `Finding on ${finding.questionId}` : ERASED)}`, `Accepted by: ${who}`];
    if (r.acceptedBy.kind === 'outside_role') lines.push(outsideRoleSentence(r.enteredBy.name, r.acceptedBy.role));
    lines.push(`Reason: ${r.reason ?? ERASED}`);
    sources.push({ sourceTable: 'accepted_risks', sourceId: r.id, field: 'reason' });
    if (r.lookAgainOn !== null) lines.push(`Look again on: ${formatDay(r.lookAgainOn)}`);
    if (r.lookAgainNote !== null) {
      lines.push(`Note: ${r.lookAgainNote}`);
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
  const at = `${formatUtcDay(s.seal.sealedAt)} ${new Date(s.seal.sealedAt).toISOString().slice(11, 19)} UTC`;
  const n = s.seal.enteredByPeople;
  return `Seal ${s.seal.sealNumber} of ${s.seal.reviewName}: sealed ${at} by ${s.seal.sealedBy.name} (${s.seal.sealedByRole}); decisions entered by ${n} ${n === 1 ? 'person' : 'people'}. Fingerprint ${formatFingerprint(s.seal.fingerprint, 'full')}`;
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
  throw new NotImplementedError('DOC-b');
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
  mapping: () => { throw new NotImplementedError('DOC-b'); },
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
  const printed = new Set(parts.flat().flatMap((p) => (p?.sources ?? []).filter((r) => r.sourceTable === 'decision_versions').map((r) => r.sourceId)));
  const narrow = narrowed(snap, usedSeals, printed);
  map.fields.forEach((e, i) => e.sources.forEach((s, j) => {
    if (isDeferred(s)) parts[i][j] = SOURCE_RESOLVERS.meta(s as Extract<FieldSource, { kind: 'meta' }>, narrow, typed, e, seen);
  }));

  const sources = new Map<string, RowRef>();
  const fields: ResolvedField[] = map.fields.map((e, i) => {
    const all = [...(parts[i] as ResolvedPart[]), ...(typedAdditions[i] === null ? [] : [typedAdditions[i] as ResolvedPart])];
    let atIssue = false;
    const texts = all.flatMap((p) => {
      if (p.text === null) return [];
      if (p.text === NOT_RECORDED_AT_ISSUE) { if (atIssue) return []; atIssue = true; }
      return [p.text];
    });
    for (const p of all) for (const r of p.sources) sources.set(rowKey(r), r);
    return {
      fieldId: e.fieldId, label: e.label, section: e.section, text: texts.length === 0 ? null : texts.join('\n'),
      provenance: all.map((p) => p.provenance).filter((p) => p !== '').join('\n'),
    };
  });

  const sealIds = sealsOf(narrow).map((s) => s.seal.sealId);
  return {
    fields,
    notRecordedFields: fields.filter((f) => f.text === null || f.text === NOT_RECORDED_AT_ISSUE).map((f) => f.fieldId),
    typedFieldIds: map.fields.filter((e) => e.typedAddition || e.sources.some((s) => s.kind === 'typed')).map((e) => e.fieldId),
    sources: [...sources.values()], sealIds,
  };
}
