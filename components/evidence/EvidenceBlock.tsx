'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { EvidenceBlockView } from '@/components/evidence/EvidenceBlockView';
import {
  evidenceUploadUrl, failureOf, postEvidenceLink, requestIdForFile, uploadEvidenceFile, type UploadOutcome,
} from '@/lib/client/evidenceUpload';
import { requestIdFor, type RetryState } from '@/lib/client/retrySafeWrite';
import { LINK_LABEL_MAX, LINK_URL_MAX, isHttpUrl } from '@/lib/evidence/link';
import { attachedItems, uploadState, type UploadItem } from '@/lib/evidence/uploadQueue';
import type { EvidenceItemView } from '@/types/api';

export type EvidenceBlockProps = {
  orgSlug: string;
  projectId: string;
  initial: EvidenceItemView[];
  disabled: boolean;
  onChange: (evidenceIds: string[]) => void;
  onUploadState: (s: { uploading: string[]; failed: string[] }) => void;
  /** W-4's evidence names in "your answer". */
  onItemsChange?: (items: EvidenceItemView[]) => void;
  /** M-18: files still uploading when the page closed, kept by the parent's per-account draft. */
  notUploaded?: readonly string[];
  /** W-3's "from version N". */
  fromVersionNumber?: number | null;
};

/** The server's limit (lib/evidence/inspect.ts MAX_BYTES, which cannot load in a browser): a larger file is not sent. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const LINK_URL_MESSAGE = 'Enter a web address that starts with http:// or https://.';

/**
 * The evidence of a decision form: add a file or a link, with a status line per upload (UX-30, FR-EVD-01 to 03). A
 * slot of S-12 (nested in the answer form) and S-15. It keeps no storage of its own: the parent form keeps the draft.
 * Remove only drops an item from the answer; evidence is append-only on the server and nothing here deletes it.
 */
export function EvidenceBlock(props: EvidenceBlockProps): ReactElement {
  const idBase = `evidence-${useId().replace(/:/g, '')}`;
  const [carried, setCarried] = useState<EvidenceItemView[]>(props.initial);
  const [added, setAdded] = useState<EvidenceItemView[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkRetry = useRef<RetryState>({ requestId: null, sentBody: null });
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const addFileButton = useRef<HTMLButtonElement | null>(null);

  // The parent's callbacks change identity on every render; the latest ones are read, never depended on.
  const latest = useRef(props);
  const uploadsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    latest.current = props;
    uploadsRef.current = uploads;
  });

  useEffect(() => {
    const items = attachedItems([...carried, ...added], uploads);
    latest.current.onChange(items.map((i) => i.id));
    latest.current.onItemsChange?.(items);
  }, [carried, added, uploads]);
  useEffect(() => {
    latest.current.onUploadState(uploadState(uploads));
  }, [uploads]);
  // Uploads still moving when the block goes away are cancelled with it.
  useEffect(() => {
    const live = controllers.current;
    return () => { live.forEach((c) => c.abort()); };
  }, []);

  function patch(key: string, change: Partial<UploadItem>): void {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }

  function settle(key: string, outcome: UploadOutcome): void {
    if (outcome.kind === 'uploaded') { patch(key, { state: 'uploaded', item: outcome.item }); return; }
    if (outcome.kind === 'not_uploaded' && outcome.reason === 'aborted') {
      files.current.delete(key);
      setUploads((list) => list.filter((u) => u.key !== key));
      return;
    }
    patch(key, { state: 'failed', failure: failureOf(outcome) });
  }

  /** Sends the chosen file under its request id: the same one on every Retry upload of the same file. */
  async function start(key: string): Promise<void> {
    const file = files.current.get(key);
    if (file === undefined) return;
    const known = uploadsRef.current.find((u) => u.key === key)?.retry ?? { requestId: null, sentBody: null };
    const r = requestIdForFile(known, file);
    const controller = new AbortController();
    controllers.current.set(key, controller);
    patch(key, { retry: r.state, state: 'uploading', loaded: 0, failure: null });
    const outcome = await uploadEvidenceFile({
      url: evidenceUploadUrl(latest.current.orgSlug, latest.current.projectId), file, requestId: r.requestId,
      signal: controller.signal, onProgress: (loaded) => patch(key, { loaded }),
    });
    controllers.current.delete(key);
    settle(key, outcome);
  }

  function chooseFiles(list: FileList | null): void {
    if (list === null) return;
    for (const file of Array.from(list)) {
      const key = crypto.randomUUID();
      files.current.set(key, file);
      const item: UploadItem = {
        key, fileName: file.name, size: file.size, retry: { requestId: null, sentBody: null }, state: 'uploading', loaded: 0, failure: null, item: null,
      };
      if (file.size > MAX_FILE_BYTES) {
        // No request for a file the server would refuse (M-15).
        setUploads((l) => [...l, { ...item, state: 'failed', failure: 'too_large' }]);
        continue;
      }
      setUploads((l) => [...l, item]);
      queueMicrotask(() => { void start(key); });
    }
  }

  function removeUpload(key: string): void {
    files.current.delete(key);
    setUploads((l) => l.filter((u) => u.key !== key));
    addFileButton.current?.focus();
  }

  function removeItem(id: string): void {
    setCarried((l) => l.filter((i) => i.id !== id));
    setAdded((l) => l.filter((i) => i.id !== id));
    addFileButton.current?.focus();
  }

  async function addLink(): Promise<void> {
    const url = linkUrl.trim();
    const label = linkLabel.trim();
    if (url.length > LINK_URL_MAX || !isHttpUrl(url)) { setLinkError(LINK_URL_MESSAGE); return; }
    if (label.length > LINK_LABEL_MAX) { setLinkError(`Enter a label of ${LINK_LABEL_MAX} characters or fewer.`); return; }
    setLinkError(null);
    const body = { kind: 'link' as const, url, label: label === '' ? null : label };
    const r = requestIdFor(linkRetry.current, body);
    linkRetry.current = r.state;
    const outcome = await postEvidenceLink({
      url: evidenceUploadUrl(props.orgSlug, props.projectId), body: { requestId: r.requestId, ...body },
    });
    if (outcome.kind === 'uploaded') {
      setAdded((l) => [...l, outcome.item]);
      setLinkUrl(''); setLinkLabel(''); setLinkFormOpen(false);
      linkRetry.current = { requestId: null, sentBody: null };
      return;
    }
    setLinkError(outcome.kind === 'rejected' && outcome.status === 422 ? LINK_URL_MESSAGE : 'The link was not added: connection lost. Try again.');
  }

  return (
    <EvidenceBlockView
      orgSlug={props.orgSlug} idBase={idBase} items={carried} added={added} fromVersionNumber={props.fromVersionNumber}
      uploads={uploads} notUploaded={props.notUploaded ?? []} disabled={props.disabled}
      linkFormOpen={linkFormOpen} linkUrl={linkUrl} linkLabel={linkLabel} linkError={linkError}
      onChooseFiles={chooseFiles}
      onOpenFilePicker={() => { document.getElementById(`${idBase}-file`)?.click(); }}
      onOpenLink={() => setLinkFormOpen((o) => !o)}
      onLinkUrlChange={(v) => { setLinkUrl(v); setLinkError(null); }}
      onLinkLabelChange={setLinkLabel}
      onAddLink={() => { void addLink(); }}
      onRemoveItem={removeItem}
      onCancelUpload={(key) => controllers.current.get(key)?.abort()}
      onRetryUpload={(key) => { void start(key); }}
      onRemoveUpload={removeUpload}
      registerAddFileButton={(el) => { addFileButton.current = el; }}
    />
  );
}
