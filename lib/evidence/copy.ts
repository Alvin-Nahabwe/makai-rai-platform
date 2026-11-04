/**
 * Texts of the evidence messages that more than one module shows. Pure strings: the browser modules import this
 * file, so it imports nothing, server code least of all. Exact copy of the SRS (7.5; NFR-REL-09).
 */

/** NFR-REL-09. */
export const STORAGE_FULL_TEXT = "This organisation's storage is full. Attach a link instead.";
/** M-08, verbatim (the contract's 13 messages): the session ended before the write. */
export const SIGNED_OUT_TEXT = 'Not saved: you have been signed out. Your answer is kept on this device. Sign in again to save it.';
/** M-09, verbatim: the role changed before the write. */
export const ROLE_CHANGED_TEXT = 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.';
/** M-12, verbatim: the project is archived. */
export const ARCHIVED_TEXT = 'Not saved: this project is archived. Owners and admins can unarchive it.';
/** M-19, verbatim: the upload limiter refused. */
export const UPLOAD_LIMIT_TEXT = 'Not uploaded: you can upload 10 files a minute. Wait a minute, then retry.';
/** M-17's sentence without its button: the connection dropped. */
export const CONNECTION_LOST_TEXT = 'Not uploaded: connection lost.';
