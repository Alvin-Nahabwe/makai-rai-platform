'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { EvidenceBlockView } from '@/components/evidence/EvidenceBlockView';
import {
  evidenceUploadUrl, failureOf, postEvidenceLink, requestIdForFile, uploadEvidenceFile, type UploadOutcome,
} from '@/lib/client/evidenceUpload';
import { createLinkAdder } from '@/lib/client/evidenceLink';
import { appendOnce, attachedItems, failedChange, uploadState, type UploadItem } from '@/lib/evidence/uploadQueue';
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
  const [linkPending, setLinkPending] = useState(false);
  // The parent's callbacks change identity on every render; the latest ones are read, never depended on.
  const latest = useRef(props);
  const uploadsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    latest.current = props;
    uploadsRef.current = uploads;
  });

  // One adder for the life of the block: it holds the in-flight guard and the request id of an unchanged link. Made in an
  // effect, so the callbacks read the latest props and no ref is touched while rendering.
  const addLinkRef = useRef<ReturnType<typeof createLinkAdder> | null>(null);
  useEffect(() => {
    addLinkRef.current = createLinkAdder({
      send: (body) => postEvidenceLink({ url: evidenceUploadUrl(latest.current.orgSlug, latest.current.projectId), body }),
      onPending: setLinkPending,
      onAdded: (item) => setAdded((l) => appendOnce(l, item)),
      onError: setLinkError,
      onDone: () => { setLinkUrl(''); setLinkLabel(''); setLinkFormOpen(false); },
    });
  }, []);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const addFileButton = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);


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
    patch(key, failedChange(failureOf(outcome)));
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
        setUploads((l) => [...l, { ...item, ...failedChange('too_large') }]);
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

  return (
    <EvidenceBlockView
      orgSlug={props.orgSlug} idBase={idBase} items={carried} added={added} fromVersionNumber={props.fromVersionNumber}
      uploads={uploads} notUploaded={props.notUploaded ?? []} disabled={props.disabled}
      linkFormOpen={linkFormOpen} linkUrl={linkUrl} linkLabel={linkLabel} linkError={linkError} linkPending={linkPending}
      onChooseFiles={chooseFiles}
      onOpenFilePicker={() => { fileInput.current?.click(); }}
      onOpenLink={() => setLinkFormOpen((o) => !o)}
      onLinkUrlChange={(v) => { setLinkUrl(v); setLinkError(null); }}
      onLinkLabelChange={setLinkLabel}
      onAddLink={() => { void addLinkRef.current?.({ address: linkUrl, label: linkLabel }); }}
      onRemoveItem={removeItem}
      onCancelUpload={(key) => controllers.current.get(key)?.abort()}
      onRetryUpload={(key) => { void start(key); }}
      onRemoveUpload={removeUpload}
      registerAddFileButton={(el) => { addFileButton.current = el; }}
      registerFileInput={(el) => { fileInput.current = el; }}
    />
  );
}
