import { requestIdFor, type RetryState } from '@/lib/client/retrySafeWrite';
import { linkFailureText, type UploadOutcome } from '@/lib/client/evidenceUpload';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { LINK_LABEL_MAX, LINK_URL_MAX, LINK_URL_MESSAGE, isHttpUrl } from '@/lib/evidence/link';
import type { CreateLinkEvidenceRequest, EvidenceItemView } from '@/types/api';

/**
 * The state machine behind "Add link" (FR-EVD-01, FR-DEC-07), apart from React so a node test can drive it. One press
 * at a time: while a post is in flight another press returns at once and sends nothing (a second post of the same
 * request id would come back 200 and list the item twice). An unchanged link keeps its request id across Retry, a
 * changed or stored one gets a new id. A refusal reaches `onError` as its own message (`linkFailureText`).
 */
export function createLinkAdder(a: {
  send: (body: CreateLinkEvidenceRequest) => Promise<UploadOutcome>;
  onPending: (pending: boolean) => void;
  onAdded: (item: EvidenceItemView) => void;
  onError: (text: string | null) => void;
  /** The link was stored: the form may close and clear. */
  onDone: () => void;
}): (input: { address: string; label: string }) => Promise<void> {
  let inFlight = false;
  let retry: RetryState = { requestId: null, sentBody: null };
  return async (input) => {
    if (inFlight) return;
    const address = input.address.trim();
    const text = input.label.trim();
    if (address.length > LINK_URL_MAX || !isHttpUrl(address)) { a.onError(LINK_URL_MESSAGE); return; }
    if (text.length > LINK_LABEL_MAX) { a.onError(EVIDENCE_COPY.link.nameTooLong(LINK_LABEL_MAX)); return; }
    a.onError(null);
    inFlight = true;
    a.onPending(true);
    try {
      const body = { kind: 'link' as const, url: address, label: text === '' ? null : text };
      const r = requestIdFor(retry, body);
      retry = r.state;
      const outcome = await a.send({ requestId: r.requestId, ...body });
      if (outcome.kind === 'uploaded') {
        a.onAdded(outcome.item);
        retry = { requestId: null, sentBody: null };
        a.onDone();
        return;
      }
      a.onError(linkFailureText(outcome));
    } finally {
      inFlight = false;
      a.onPending(false);
    }
  };
}
