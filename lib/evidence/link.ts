import { ValidationFailed } from '@/lib/http/errors';
import type { CreateLinkEvidenceRequest } from '@/types/api';

export const LINK_URL_MAX = 2048;
export const LINK_LABEL_MAX = 200;

const URL_MESSAGE = 'Enter a web address that starts with http:// or https://.';

/** True when `s` parses as a URL whose scheme is http or https. The only links the platform stores or renders as anchors. */
export function isHttpUrl(s: string): boolean {
  try {
    const p = new URL(s).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** Shape-checks the JSON body of a link evidence request. Throws ValidationFailed naming `url` or `label`. */
export function parseLinkEvidenceBody(body: unknown): CreateLinkEvidenceRequest {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.requestId !== 'string' || b.requestId.length === 0) {
    throw new ValidationFailed([{ field: 'requestId', message: 'A request id is required.' }]);
  }
  if (b.kind !== 'link') throw new ValidationFailed([{ field: 'kind', message: 'Choose a file or a link.' }]);
  if (typeof b.url !== 'string' || b.url.length > LINK_URL_MAX || !isHttpUrl(b.url)) {
    throw new ValidationFailed([{ field: 'url', message: URL_MESSAGE }]);
  }
  let label: string | null = null;
  if (b.label !== null && b.label !== undefined) {
    if (typeof b.label !== 'string') throw new ValidationFailed([{ field: 'label', message: 'Enter a label of 200 characters or fewer.' }]);
    const t = b.label.trim();
    if (t.length > LINK_LABEL_MAX) throw new ValidationFailed([{ field: 'label', message: 'Enter a label of 200 characters or fewer.' }]);
    label = t === '' ? null : t;
  }
  return { requestId: b.requestId, kind: 'link', url: b.url, label };
}
