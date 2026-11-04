import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { ARCHIVED_TEXT, ROLE_CHANGED_TEXT, SIGNED_OUT_TEXT, UPLOAD_LIMIT_TEXT } from '@/lib/evidence/copy';
import type { UploadFailure } from '@/lib/evidence/uploadQueue';
import type { ApiErrorBody, CreateLinkEvidenceRequest, EvidenceItemView } from '@/types/api';

/**
 * The browser half of adding evidence (UX-30, FR-EVD-01). A file goes by XMLHttpRequest, because `fetch` reports no
 * upload progress; a link is a retry-safe JSON write. No React and no server code. Posts only to the url its caller
 * built with `evidenceUploadUrl`, and never sends a DELETE: Remove only drops an item from the answer.
 */

/** UX-30: an upload is failed when no bytes have moved for this long; the timer runs on until the reply. */
export const UPLOAD_STALL_MS = 30_000;

export type { UploadFailure };

export function evidenceUploadUrl(orgSlug: string, projectId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/evidence`;
}

export type UploadOutcome =
  | { kind: 'uploaded'; status: 200 | 201; item: EvidenceItemView }
  | { kind: 'rejected'; status: number; body: ApiErrorBody }
  | { kind: 'not_uploaded'; reason: 'network' | 'stalled' | 'aborted' };

type Refused = Exclude<UploadOutcome, { kind: 'uploaded' }>;

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null && typeof (v as ApiErrorBody).error === 'string' && typeof (v as ApiErrorBody).code === 'string';
}

/** What a finished request says: a stored item, the API's refusal, or nothing readable. */
function outcomeOf(status: number, text: string): UploadOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if ((status === 200 || status === 201) && typeof json === 'object' && json !== null) {
    return { kind: 'uploaded', status, item: json as EvidenceItemView };
  }
  // A 2xx we cannot read says nothing about what the server stored: the person may retry with the same id.
  if (status >= 200 && status < 300) return { kind: 'not_uploaded', reason: 'network' };
  // A refusal from a proxy (nginx's 413 page) carries no API body; its status still says what happened.
  return { kind: 'rejected', status, body: isApiErrorBody(json) ? json : { error: 'Unreadable reply', code: 'unreadable_reply' } };
}

/**
 * Uploads one file (multipart: the text field `requestId`, the file field `file`) and reports bytes as they move.
 * Resolves, never rejects: `not_uploaded` is "we do not know it was stored", and a retry with the same request id
 * stores nothing twice.
 */
export function uploadEvidenceFile(a: {
  url: string; file: File; requestId: string; onProgress: (loaded: number, total: number) => void;
  signal?: AbortSignal; stallMs?: number; xhrFactory?: () => XMLHttpRequest;
}): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve) => {
    const xhr = (a.xhrFactory ?? (() => new XMLHttpRequest()))();
    const stallMs = a.stallMs ?? UPLOAD_STALL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let lastLoaded = -1;
    const finish = (o: UploadOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.signal?.removeEventListener('abort', onAbort);
      resolve(o);
    };
    const armStall = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { finish({ kind: 'not_uploaded', reason: 'stalled' }); xhr.abort(); }, stallMs);
    };
    function onAbort(): void {
      finish({ kind: 'not_uploaded', reason: 'aborted' });
      xhr.abort();
    }

    xhr.upload.addEventListener('progress', (e: ProgressEvent) => {
      if (e.loaded > lastLoaded) {
        lastLoaded = e.loaded;
        a.onProgress(e.loaded, e.lengthComputable ? e.total : a.file.size);
        armStall();
      }
    });
    xhr.addEventListener('load', () => finish(outcomeOf(xhr.status, xhr.responseText)));
    xhr.addEventListener('error', () => finish({ kind: 'not_uploaded', reason: 'network' }));
    xhr.addEventListener('abort', () => finish({ kind: 'not_uploaded', reason: 'aborted' }));

    if (a.signal?.aborted) { finish({ kind: 'not_uploaded', reason: 'aborted' }); return; }
    a.signal?.addEventListener('abort', onAbort);
    const form = new FormData();
    form.set('requestId', a.requestId);
    form.set('file', a.file);
    xhr.open('POST', a.url);
    armStall();
    xhr.send(form);
  });
}

/** Adds a link: a retry-safe JSON write to the url its caller built. */
export async function postEvidenceLink(a: { url: string; body: CreateLinkEvidenceRequest; fetchImpl?: typeof fetch }): Promise<UploadOutcome> {
  const out = await sendWrite<EvidenceItemView>(a.url, 'POST', { ...a.body }, { onSlow: () => {}, fetchImpl: a.fetchImpl });
  if (out.kind === 'saved') return { kind: 'uploaded', status: out.status === 200 ? 200 : 201, item: out.body };
  if (out.kind === 'rejected') return out;
  return { kind: 'not_uploaded', reason: out.reason === 'timeout' ? 'stalled' : 'network' };
}

/** The same chosen file keeps its request id across Retry upload; choosing a file again starts a new item. */
export function requestIdForFile(
  state: RetryState, file: { name: string; size: number; lastModified: number },
): { requestId: string; state: RetryState } {
  return requestIdFor(state, { kind: 'file', name: file.name, size: file.size, lastModified: file.lastModified });
}

/** Which failure line an unsuccessful outcome gets. */
export function failureOf(o: Refused): UploadFailure {
  if (o.kind === 'not_uploaded') return 'cut_off';
  const { status, body } = o;
  if (status === 413) return body.code === 'storage_full' ? 'storage_full' : 'too_large';
  if (status === 400 && body.code === 'unsupported_file_type') return 'wrong_type';
  if (status === 429) return 'rate_limited';
  if (status === 409 && body.code === 'project_archived') return 'archived';
  if (status === 403) return 'role_changed';
  if (status === 401) return 'signed_out';
  return 'cut_off';
}

const LINK_ADDRESS_TEXT = 'Enter a web address that starts with http:// or https://.';
const LINK_LOST_TEXT = 'The link was not added: connection lost. Try again.';

/**
 * The line for a link that was not added. Each refusal shows its own message, as a file does: only a lost connection,
 * a server error and the unexpected say "connection lost", because only then is trying again true.
 */
export function linkFailureText(o: Refused): string {
  if (o.kind === 'rejected' && o.status === 422) return LINK_ADDRESS_TEXT;
  switch (failureOf(o)) {
    case 'archived': return ARCHIVED_TEXT;
    case 'rate_limited': return UPLOAD_LIMIT_TEXT;
    case 'signed_out': return SIGNED_OUT_TEXT;
    case 'role_changed': return ROLE_CHANGED_TEXT;
    default: return LINK_LOST_TEXT;
  }
}
