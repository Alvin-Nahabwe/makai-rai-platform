/**
 * The copy the SRS fixes for documents, and the date helper (FR-DOC-02, FR-DOC-03, FR-DOC-05; 7.5.8). Imports only the pure date formatter: S-18's client
 * component imports these words, and `resolve.ts` (which reads content files) cannot go into a browser bundle. `resolve.ts`
 * re-exports them, so the tests and the renderers name them there.
 */

import { formatDay } from '@/lib/format/dates';

/** The owner's decision (C8 #21, audit C#270) over FR-DOC-02's SRS line 1025. */
export const STATEMENT = 'Made from this team\'s own records in the MAK-AI RAI Platform. It is not an ethics approval, audit, certification or compliance statement.';
/** The design spec's sentence (DESIGN-SPEC.md:424, the owner's decision of 14 November 2026) over 6.5, D8, R-56. */
export const SEALED_NOTE = 'The platform keeps this seal. No outside body has time-stamped it.';
export const NOT_RECORDED = 'Not recorded';                                           // FR-DOC-02, D1
export const NOT_RECORDED_AT_ISSUE = 'Not recorded: this stage had no seal when the document was issued'; // FR-DOC-05, D3; C#273
/** A question with no decision inside a field that has another value (the owner's decision of 14 November 2026, walk finding S1). */
export const noDecisionLine = (questionId: string): string => `No decision is recorded for question ${questionId}.`;
export const PROJECT_MARK = 'From the project details on the day of issue. Not part of the sealed record.'; // FR-DOC-02; C#274
export const TYPED_MARK = 'Typed for this document; not part of the sealed record';   // FR-DOC-03
export const NO_EVIDENCE = 'Evidence: none attached';                                 // FR-DOC-02, D9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 7.5.8 "2 Nov 2026" from the UTC date of `iso`. A fixed month list: `Intl` prints "Sept" for September on this Node. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError('formatUtcDay: not a date');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}


/** The names of the three documents (FR-DOC-01), in S-18's fixed order. */
export const DOCUMENT_TITLES = { data_card: 'Data card', model_card: 'Model card', mitigation_plan: 'Mitigation plan' } as const;

/** The values the data card's ethics review (DC-15, CG-10) takes, and the words S-18 shows for them. */
export const ETHICS_APPROVED = 'approved';
export const ETHICS_SUBMITTED = 'submitted';
export const ETHICS_NOT_REQUIRED = 'not_required';
export const ETHICS_STATES: ReadonlyArray<[value: string, word: string]> = [[ETHICS_APPROVED, 'Approval granted'], [ETHICS_SUBMITTED, 'Submitted, awaiting decision'], [ETHICS_NOT_REQUIRED, 'Not required']];

/** S-18's word for a seal whose stored bytes no longer match its fingerprint (NFR-INT-05, C#279); the seal cannot be chosen. */
export const SEAL_CHECK_FAILED = 'Cannot be used';

/** The `ProjectMetadata` columns a document can print, in schema order (ids and `updatedAt` are not fields). */
export const METADATA_KEYS = [
  'aiSystemType', 'aiSystemTypeOther', 'institution', 'department', 'country', 'developmentStage', 'deploymentSector', 'deploymentSectorOther',
  'targetPopulation', 'processesPersonalData', 'datasetSize', 'datasetType', 'datasetTypeOther', 'datasetDescription', 'teamSize',
  'fundingSource', 'regulatoryContext', 'projectStart', 'projectEnd',
] as const;
/** What a `project` source of a field map may name: the project's name and description, or a metadata column. */
export const PROJECT_FIELDS: readonly string[] = ['name', 'description', ...METADATA_KEYS];

// SRS 7.5.6, "Erased text field" and "Erased evidence file": the lines that stand in place of erased text.
export const FILE_NAME_ERASED = 'File name erased';
export const textErasedLine = (date: string): string => `Text erased on ${formatDay(date)} on the organisation's instruction.`;
export const fileErasedLine = (name: string, date: string): string =>
  `${name} . File erased on ${formatDay(date)} on the organisation's instruction. Its fingerprint is kept, so seals that include it still check.`;
/** The gate-derived line (SRS 7.5.6 "Gate-derived N/A", FR-CNT-04), as ruled in G-c3 (a). */
export const GATE_DERIVED_NA = 'Does not apply: the team answered No to the personal data question';

// The lines a document prints around the record (C2; C8 #4; rulings G-c3 and G-c5 (a), which keep FR-DOC-02's four items).
/** A decision's source, first sentence of its provenance: "Source: question <Q-id>, version <n> of the decision." */
export const decisionSource = (questionId: string, version: number): string => `Source: question ${questionId}, version ${version} of the decision.`;
/** The second sentence of a decision's provenance, when it has a decider and its date is a whole day (or it has no date). */
export const decidedByLine = (who: string, on: string | null): string => `Decided by ${who}${on === null ? '' : ` on ${on}`}.`;
/** The same sentence for a decision dated only by month or by year (the coordinator's ruling, 14 Nov 2026 19:14): "in", not "on". */
export const decidedInLine = (who: string, period: string): string => `Decided by ${who} in ${period}.`;
/** The short source of a finding or of a gate-derived line: "From question <Q-id> (decision version <n>)". */
export const fromQuestion = (questionId: string, version?: number): string =>
  `From question ${questionId}${version === undefined ? '' : ` (decision version ${version})`}`;
/** A gate decision's answer (FR-DOC-02 B38). */
export const personalDataAnswerLine = (answer: string): string => `Answer to the personal data question: ${answer}`;
/** Who a mitigation is assigned to (C2 "Assigned to", over "Owner"). */
export const assignedToLine = (name: string): string => `Assigned to: ${name}`;
/** The evidence of a done mitigation (C2 "Evidence that it is done", over "Closure evidence"). */
export const doneEvidenceLine = (items: string): string => `Evidence that it is done: ${items}`;
/** FR-DOC-02 / D7 (C#328): the sentence that stops a team's entry reading as the outside body's own record. `role` is the role's label. */
export const outsideRoleLine = (member: string, role: string): string =>
  `Recorded by ${member} as a decision of the ${role.toLowerCase()}. The ${role.toLowerCase()} did not enter it in the platform.`;
/** The same sentence for the outside role `other` (the coordinator's ruling, 14 Nov 2026 19:14): it names no body. */
export const outsideOtherBodyLine = (member: string): string =>
  `Recorded by ${member} as a decision of another body. That body did not enter it in the platform.`;
/** An evidence file, with the short form of its fingerprint (C#331). */
export const evidenceFileLine = (name: string, fingerprint: string | null): string => `file ${name}${fingerprint === null ? '' : ` (fingerprint ${fingerprint})`}`;
/** A finding's state, in its block (C#347). */
export const findingStatusLine = (word: string): string => `Status: ${word}`;
/**
 * The status word of a finding closed with no real (kind action) mitigation done since its latest reopen: a decision closed it
 * (the coordinator's ruling, 14 Nov 2026 21:45). "Closed by a mitigation" stays for a finding a real one closed.
 */
export const FINDING_CLOSED = 'Closed';
/** Under a finding a decision closed: who entered the closing record and the UTC day it was received (the same ruling). */
export const closedByLine = (name: string, day: string): string => `Closed by ${name} on ${day}.`;
/** The cause under it when the record names the personal data question's version answering No (the same ruling). */
export const CLOSED_NO_LONGER_APPLIES = 'Closed because this question no longer applies: the team answered No to the personal data question.';
/** An accepted risk's check date and the note of its last check (C#359, C#360). */
export const checkAgainLine = (day: string): string => `To be checked again on: ${day}`;
export const lastCheckNoteLine = (note: string): string => `Notes from the last check: ${note}`;
/** MP-01 (C#362): the stage's name, the review's name, and its "Prepared for" note when there is one. */
export const reviewLineText = (stageName: string, reviewName: string, note: string | null): string =>
  `Stage: ${stageName}. Review: ${reviewName}.${note === null ? '' : ` Prepared for: ${note}`}`;

/**
 * The erasable text fields as erase_text_field names them: [table, key, column] (migration 20261030000500_v060_05_functions, the VALUES
 * list at the top of the function). A tombstone carries the key; the function nulls a document through a source row whose field is the
 * key or the column. `__tests__/unit/document-field-maps.test.ts` reads the migration and fails when this list and the SQL differ.
 */
export const ERASABLE_FIELDS: ReadonlyArray<readonly [table: string, key: string, column: string]> = [
  ['decision_versions', 'reason', 'reason'],
  ['evidence', 'fileName', 'filename'],
  ['evidence', 'url', 'url'],
  ['evidence', 'label', 'label'],
  ['findings', 'title', 'title'],
  ['findings', 'description', 'description'],
  ['finding_events', 'reason', 'reason'],
  ['mitigation_versions', 'what', 'what'],
  ['mitigation_versions', 'changeNote', 'changeNote'],
  ['mitigation_versions', 'closureNote', 'closureNote'],
  ['mitigation_versions', 'cancelReason', 'cancelReason'],
  ['accepted_risks', 'reason', 'reason'],
  ['accepted_risks', 'lookAgainNote', 'lookAgainNote'],
  ['stage_reviews', 'preparedFor', 'preparedFor'],
];

/** The words of the S-18 failure lines (queued for the owner; used as written until the owner rules). Free of any claim about the device. */
export const MSG_PREVIEW_SERVER = 'Preview not shown. The server had a problem. Try again.';
export const MSG_ISSUE_NO_REPLY = 'Not issued yet: no reply from the server. It may have arrived. Retry is safe: it will not issue twice.';
export const MSG_ROLE_CHANGED = 'Preview not shown. Your role in this organisation no longer allows this. Ask an Owner or Admin.';
export const MSG_SEAL_CHECK_FAILED = 'This seal cannot be used because it no longer matches the record. Contact MAK-AI through Help and contact.';

/** One "<day> hh:mm:ss UTC" for an instant (FR-DOC-02: UTC, to the second). */
export function utcSecond(iso: string): string {
  return `${formatUtcDay(iso)} ${new Date(iso).toISOString().slice(11, 19)} UTC`;
}

/** The two phases of S-18 a failure can happen in: making the preview, or issuing. */
export type DocumentPhase = 'generating' | 'issuing';
/** A failure's first words: "Preview not shown." before anything is issued, "Not issued." while issuing (the lead's ruling, part 18c (c)). */
const failed = (phase: DocumentPhase): string => (phase === 'issuing' ? 'Not issued.' : 'Preview not shown.');

/**
 * The words of S-18 and of its S-16 slot (plan 1A Task 18c (c)): the copy audit's RULED TEXT (task-18-map-copy.md, 18c table) with the
 * lead's rulings ("Generate" is retired on this screen; S-Q2: a full stop then a capital; "Owner or Admin"). Page titles first.
 */
export const DOCUMENTS_COPY = Object.freeze({
  titles: Object.freeze({
    documentsOf: (reviewName: string): string => `Documents of ${reviewName}`,
  }),
  page: Object.freeze({
    heading: 'Create a document',
    chooseHeading: 'Choose a document',
    issuedHeading: 'Issued documents',
  }),
  form: Object.freeze({
    neverSealed: 'Seal this review first. Documents are made from a sealed review.',
    sealThisReview: 'Seal this review',
    legend: 'Choose a document',
    /** The stages are display names ("In-processing"); one stage keeps the singular sentence. */
    neverSealedStages: (names: readonly string[]): string => (names.length === 1
      ? `Part of this document comes from the ${names[0]} stage, which has not been sealed. Those fields will read "${NOT_RECORDED_AT_ISSUE}".`
      : `Part of this document comes from the ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} stages, which have not been sealed. Those fields will read "${NOT_RECORDED_AT_ISSUE}".`),
    sealLabel: 'Make it from seal',
    sealOption: (n: number, day: string, latest: boolean): string => `Seal ${n}, ${day}${latest ? ' (latest)' : ''}`,
    sealOptionUnusable: (n: number, day: string): string => `Seal ${n}, ${day}: ${SEAL_CHECK_FAILED.toLowerCase()}`,
    olderSeal: (chosen: number, latest: number): string => `Seal ${latest} is newer. This document will list seal ${chosen} as its source.`,
    typedHeading: (title: string): string => `${title}: fields to type in`,
    typedNote: `Type these for this document only. They are not part of the sealed record. The platform keeps what you type for next time. Leave a field empty to print "${NOT_RECORDED}".`,
    printNotRecorded: `Print "${NOT_RECORDED}"`,
    committee: 'Committee',
    reference: 'Reference',
    approvalDate: 'Date of approval',
    whyNotRequired: 'Why approval is not required',
    whoDecided: 'Who decided it is not required',
    /** C#268, kept in 1A with the singular at one. */
    fromRecord: (r: { fields: number; questions: number; notRecorded: number }): string => {
      const fields = (n: number) => `${n} ${n === 1 ? 'field' : 'fields'}`;
      const from = r.questions === 0 ? fields(r.fields) : `${fields(r.fields)} from ${r.questions} ${r.questions === 1 ? 'question' : 'questions'}`;
      return `${from}\u00a0· ${fields(r.notRecorded)} will read "${NOT_RECORDED}"`;
    },
    previewButton: 'Preview document',
    retry: 'Retry',
  }),
  preview: Object.freeze({
    heading: (title: string): string => `Preview: ${title}`,
    nothingSaved: 'Nothing is saved until you select Issue this document.',
    notRecordedCount: (n: number): string => `${n} ${n === 1 ? 'field reads' : 'fields read'} "${NOT_RECORDED}" or "${NOT_RECORDED_AT_ISSUE}".`,
    issue: 'Issue this document',
    back: 'Back to edit',
  }),
  issued: Object.freeze({
    /** M-35 with "Fingerprint" for "SHA-256" (C#250). */
    status: (short: string): string => `Issued. Fingerprint ${short}.`,
    download: (size: string): string => `Download PDF (${size})`,
    another: 'Create another document',
  }),
  status: Object.freeze({
    making: 'Making the preview...',
    issuing: 'Issuing the document...',
    stillMaking: 'Still making the preview.',
    stillIssuing: 'Still issuing the document.',
  }),
  refusal: Object.freeze({
    lost: 'Preview not shown. Connection lost. Nothing was issued.',
    archived: (phase: DocumentPhase): string => `${failed(phase)} This project is archived. Owners and Admins can unarchive it.`,
    role: (phase: DocumentPhase): string => `${failed(phase)} Your role in this organisation no longer allows this. Ask an Owner or Admin.`,
    signedOut: (phase: DocumentPhase): string => `${failed(phase)} You are signed out. Sign in again, then come back. Nothing was issued.`,
    other: (phase: DocumentPhase): string => `${failed(phase)} Something went wrong. Nothing was issued. Please try again.`,
    tooMany: (phase: DocumentPhase, minutes: number): string => `${failed(phase)} Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    /** A server field message the screen knows, after the phase's first words. */
    field: (phase: DocumentPhase, message: string): string => `${failed(phase)} ${message}`,
    /** A server field message the screen does not know: never shown (the lead's ruling, G-c4). */
    unknownField: (phase: DocumentPhase): string => `${failed(phase)} Reload the page and try again.`,
  }),
  list: Object.freeze({
    empty: 'No documents issued from this review yet.',
    line: (title: string, sealNumber: number, day: string, by: string, short: string): string => `${title}\u00a0· seal ${sealNumber}\u00a0· ${day}\u00a0· by ${by}\u00a0· Fingerprint ${short}`,
    olderSeal: 'Made from an older seal. A newer seal exists.',
    withdrawn: (day: string, reason: string): string => `Withdrawn on ${day}: ${reason}`,
    erased: (day: string): string => `File erased on ${day}`,
    issuedWord: 'Issued ',
    reviewLine: (title: string, sealNumber: number, day: string, short: string, withdrawn: boolean): string =>
      `${title}\u00a0· from seal ${sealNumber}\u00a0· issued ${day}\u00a0· Fingerprint ${short}\u00a0· ${withdrawn ? 'Withdrawn' : 'Issued'}`,
  }),
  actions: Object.freeze({
    copy: 'Copy as text',
    copied: 'Copied.',
    copyLost: 'Not copied. Connection lost.',
    copySignedOut: 'Not copied. You are signed out. Sign in again, then come back.',
    copyErased: "Not copied. This document's text was erased.",
    copyTooMany: 'Not copied. Too many requests. Wait a minute, then try again.',
    copyOther: 'Not copied. Reload the page and try again.',
    selectAll: 'Select all and copy',
    withdraw: 'Withdraw document',
    reasonLabel: 'Reason (required)',
    objectName: (title: string, day: string): string => `${title} issued ${day}`,
    /** M-36 as C#311 rules it; `document` is the lower-case name ("data card"). */
    withdrawConsequence: (document: string): string => `Withdraw this ${document}? It will be marked Withdrawn in the list, with your reason. The PDF is kept and can still be downloaded.`,
    withdrawn: 'Withdrawn.',
    withdrawTaken: 'Not withdrawn by you. Someone else withdrew it first. Their reason is shown.',
    withdrawLost: 'Not withdrawn yet: no reply from the server. It may have arrived. Retry is safe: it will not withdraw twice.',
    withdrawOther: 'Not withdrawn. Reload the page and try again.',
    withdrawSignedOut: 'Not withdrawn. You are signed out. Sign in again, then come back.',
    withdrawEarlier: 'Withdrawn. Your earlier request may have done it. The reason shown is the one recorded.',
    withdrawUnconfirmed: 'Not confirmed. It may already have been withdrawn. Reload the page to see.',
    withdrawForbidden: 'Not withdrawn. Your role in this organisation no longer allows this. Ask an Owner or Admin.',
    withdrawArchived: 'Not withdrawn. This project is archived. Owners and Admins can unarchive it.',
    retry: 'Retry',
  }),
  /** The server's field messages for a document request (lib/data/documents.ts), one copy each, so S-18 can tell a known one. */
  fieldMessages: Object.freeze({
    sealNotOfReview: 'This seal is not from this review.',
    chooseSeal: 'Choose a seal.',
    notTypeable: 'This is not a field you can type into for this document.',
    mustBeText: 'This must be text.',
    tooLong: (max: number): string => `Use at most ${max} characters.`,
    chooseEthics: 'Choose Approval granted, Submitted or Not required.',
    notOfState: 'This does not belong to the state you chose.',
    chooseDocument: 'Choose a data card, a model card or a mitigation plan.',
  }),
});
