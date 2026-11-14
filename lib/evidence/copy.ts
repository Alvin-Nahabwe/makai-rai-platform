/**
 * The words of evidence: the evidence block, its upload and link lines, the refusals, and the list of a version's
 * evidence (copy audit B rows 252 to 263, 275 to 278, 376 to 392; plan 1A Task 17 and the coordinator's answers Q2, Q8,
 * Q9, Q15 and Q16). Pure strings: the browser modules import this file (the evidence block on the question page and on
 * the finding page), so it imports nothing, server code least of all.
 *
 * The six `*_TEXT` constants are the refusals of a FILE ("Not uploaded."); the server's 413 message is
 * `STORAGE_FULL_TEXT` too (the storage cap re-exports it). A LINK has its own set, `LINK_REFUSAL_COPY` ("Not added.").
 */

/** NFR-REL-09: the organisation's or the account's storage cap refused the file. */
export const STORAGE_FULL_TEXT = "Your organisation's storage is full. Add a link instead.";
/** M-08: the session ended before the upload. */
export const SIGNED_OUT_TEXT = 'Not uploaded. You have been signed out. Sign in again, then add the file again.';
/** M-09: the role changed before the upload. */
export const ROLE_CHANGED_TEXT = 'Not uploaded. Your role no longer allows this. Ask an Owner or Admin.';
/** M-12: the project is archived. */
export const ARCHIVED_TEXT = 'Not uploaded. This project is archived. An Owner or Admin can unarchive it.';
/** M-19: the upload limiter refused. */
export const UPLOAD_LIMIT_TEXT = 'Not uploaded. You can upload 10 files a minute. Wait a minute, then retry.';
/** M-17: the connection dropped; the line's button is Retry upload. */
export const CONNECTION_LOST_TEXT = 'Not uploaded. The connection was lost. Select Retry upload.';

/**
 * The refusals of a LINK. The limiter counts files and links together: one key for every POST to a project's evidence
 * route, bucketed per account (lib/rate-limit.ts, the key 'POST:/api/v1/orgs/*\/projects/*\/evidence' and `storeKey`),
 * and a link is posted to the same route as a file (components/evidence/EvidenceBlock.tsx, `evidenceUploadUrl`).
 */
export const LINK_REFUSAL_COPY = Object.freeze({
  signedOut: 'Not added. You have been signed out. Sign in again, then add the link again.',
  roleChanged: 'Not added. Your role no longer allows this. Ask an Owner or Admin.',
  archived: 'Not added. This project is archived. An Owner or Admin can unarchive it.',
  rateLimited: 'Not added. You can add 10 files or links a minute. Wait a minute, then try again.',
  connectionLost: 'Not added. The connection was lost. Try again.',
});

export const EVIDENCE_COPY = Object.freeze({
  legend: 'Evidence',
  /** One help element of two lines; four controls name it in `aria-describedby`. */
  help: Object.freeze({
    keep: 'Do not upload datasets or files about the people your system affects. Add a link to where they are kept instead.',
    types: 'PDF, PNG, JPEG, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or ZIP. Up to 10 MB each.',
  }),
  /** Beside an item carried from the decision being edited. */
  fromCurrent: '(from the current decision)',
  remove: 'Remove',
  removeNamed: (name: string): string => `Remove ${name}`,
  cancelUpload: 'Cancel upload',
  cancelUploadNamed: (name: string): string => `Cancel upload ${name}`,
  retryUpload: 'Retry upload',
  retryUploadNamed: (name: string): string => `Retry upload ${name}`,
  chooseFiles: 'Choose files to add as evidence',
  addFile: 'Add a file',
  addLinkToggle: 'Add a link',
  webAddress: 'Web address',
  linkName: 'Name for the link (optional)',
  addLink: 'Add link',
  /** M-13 to M-18: each line's words around the file's name, which the view puts in `<bdi>`. */
  lines: Object.freeze({
    uploadingBefore: 'Uploading ',
    uploadingAfter: (x: string, y: string): string => `: ${x} of ${y} MB.`,
    uploadedBefore: 'Uploaded ',
    uploadedAfter: (size: string): string => ` (${size}).`,
    notUploadedBefore: 'Not uploaded. ',
    tooLargeAfter: ' is larger than 10 MB. Add a link to where it is kept instead.',
    wrongTypeAfter: ' is not a PDF, PNG, JPEG, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or ZIP file.',
    closedAfter: ' was not uploaded before the page closed. Choose the file again.',
    /** NFR-PERF-06, for a file over 2 MB. */
    largeFile: (megabytes: string): string => `This file is large (${megabytes} MB) and may upload slowly. You can add a link to it instead.`,
  }),
  /** The link's field messages: the server's (lib/evidence/link.ts) and the browser's (lib/client/evidenceLink.ts). */
  link: Object.freeze({
    address: 'Enter a web address that starts with http:// or https://.',
    nameTooLong: (max: number): string => `Use ${max} characters or fewer for the name.`,
    requestIdMissing: 'Something went wrong. Reload the page and try again.',
    chooseKind: 'Choose a file or a link.',
    /** Under "Add link" while the link's request is out (walk finding B3). */
    adding: 'Adding the link...',
  }),
  /** A version's evidence (components/evidence/VersionEvidenceList.tsx). */
  list: Object.freeze({
    fallbackName: 'Evidence',
    linkAddressErased: 'Link address erased',
    fileNameErased: 'File name erased',
    /** Follows the file's name (or "File name erased"): a full stop, a space, then the sentence. */
    fileErased: (date: string): string => `. File erased on ${date} at your organisation's request.`,
  }),
  /** The kind of a stored file, by its type (lib/evidence/format.ts `evidenceKind`). */
  kinds: Object.freeze({
    pdf: 'PDF',
    png: 'PNG',
    jpeg: 'JPEG',
    zip: 'ZIP',
    office: 'Office document',
  }),
});
