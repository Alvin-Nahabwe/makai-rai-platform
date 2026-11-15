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
  /**
   * The files still moving or failed, and the link: `linkAdding` while its request is out, `linkNotAdded` once it has
   * ended without the link (until the next one is sent), `linkTyped` while the link box holds an address that is not in
   * the answer, whether the link form is open or folded. A parent that holds its Save for uploads holds it for a link too.
   */
  onUploadState: (s: { uploading: string[]; failed: string[]; linkAdding: boolean; linkNotAdded: boolean; linkTyped: boolean }) => void;
  /** W-4's evidence names in "your answer". */
  onItemsChange?: (items: EvidenceItemView[]) => void;
  /** M-18: files still uploading when the page closed, kept by the parent's per-account draft. */
  notUploaded?: readonly string[];
  /** W-3's "from version N". */
  fromVersionNumber?: number | null;
  /** The parent's own save is out: no link is added until it is back (the save may replace this block, and the link with it). */
  saveOut?: boolean;
  /** How many times the parent refused a save because `linkTyped` was true. Each new refusal opens the link form and is said at the address box. */
  unaddedLinkRefusals?: number;
  /** The link boxes of the block this one replaces (the parent took a new version): what was typed and not added is kept. */
  initialLink?: { url: string; label: string };
  /** Each change of the two link boxes, so a parent that replaces the block can hand them to the next one. */
  onLinkInput?: (link: { url: string; label: string }) => void;
  /** The decision card only: the question's own examples of what to attach (EvidenceBlockView). */
  examples?: readonly string[];
  /** The decision card only: its one-line layout, "None yet." and the closed "Accepted files" (EvidenceBlockView). */
  decisionCard?: boolean;
  /** The decision card only: evidence the form holds that the block cannot name (EvidenceBlockView). */
  keptCount?: number;
  /** The decision form only: "Save without" beside the uploading files while no Save waits (plan 1C C5; EvidenceBlockView). */
  saveWithout?: { label: string; onPress: () => void } | null;
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
  const [linkUrl, setLinkUrl] = useState(props.initialLink?.url ?? '');
  const [linkLabel, setLinkLabel] = useState(props.initialLink?.label ?? '');
  const [linkFormOpen, setLinkFormOpen] = useState(linkUrl !== '' || linkLabel !== '');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPending, setLinkPending] = useState(false);
  // The last link request ended without adding the link (a refusal, a lost connection, no reply in time).
  const [linkNotAdded, setLinkNotAdded] = useState(false);
  const linkAddedByRequest = useRef(false);
  // Folded or open: "Add a link" folds the form and keeps the address, and a save must not discard it without a word.
  const linkTyped = linkUrl.trim() !== '';
  // The parent refused a save for the address in the box: the link form opens, so the box is on screen, and the sentence
  // shows there after the box's own line, if any, until the box is edited or Add link is pressed. Compared while rendering,
  // as a changed prop is (no effect, no extra paint).
  const refusals = props.unaddedLinkRefusals ?? 0;
  const [seenRefusals, setSeenRefusals] = useState(refusals);
  const [linkRefused, setLinkRefused] = useState(false);
  if (refusals !== seenRefusals) {
    setSeenRefusals(refusals);
    setLinkRefused(true);
    setLinkFormOpen(true);
  }
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
      // The adder calls onAdded before it ends a request that stored the link, and never for one that did not.
      onPending: (pending) => {
        if (pending) {
          linkAddedByRequest.current = false;
          // Said to the parent in the press itself, with the uploads as it last heard them, and again by the effect below
          // after the render: a Save pressed straight after "Add link" finds the request out, whenever React renders.
          latest.current.onUploadState({ ...uploadState(uploadsRef.current), linkAdding: true, linkNotAdded: false, linkTyped: true });
        }
        setLinkNotAdded(!pending && !linkAddedByRequest.current);
        setLinkPending(pending);
      },
      onAdded: (item) => { linkAddedByRequest.current = true; setAdded((l) => appendOnce(l, item)); },
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
  // After the effect above, in the same flush: when a link's request ends, the parent has the link's id before it hears
  // that the request is over, so a Save it held for the link is sent with it.
  useEffect(() => {
    latest.current.onUploadState({ ...uploadState(uploads), linkAdding: linkPending, linkNotAdded, linkTyped });
  }, [uploads, linkPending, linkNotAdded, linkTyped]);
  useEffect(() => {
    latest.current.onLinkInput?.({ url: linkUrl, label: linkLabel });
  }, [linkUrl, linkLabel]);
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
      linkFormOpen={linkFormOpen} linkUrl={linkUrl} linkLabel={linkLabel} linkError={linkError} linkRefused={linkRefused} linkPending={linkPending}
      held={props.saveOut === true} examples={props.examples} decisionCard={props.decisionCard} keptCount={props.keptCount}
      saveWithout={props.saveWithout}
      onChooseFiles={chooseFiles}
      onOpenFilePicker={() => { fileInput.current?.click(); }}
      onOpenLink={() => setLinkFormOpen((o) => !o)}
      onLinkUrlChange={(v) => { setLinkUrl(v); setLinkError(null); setLinkRefused(false); }}
      onLinkLabelChange={setLinkLabel}
      onAddLink={() => { if (props.saveOut !== true) { setLinkRefused(false); void addLinkRef.current?.({ address: linkUrl, label: linkLabel }); } }}
      onRemoveItem={removeItem}
      onCancelUpload={(key) => controllers.current.get(key)?.abort()}
      onRetryUpload={(key) => { void start(key); }}
      onRemoveUpload={removeUpload}
      registerAddFileButton={(el) => { addFileButton.current = el; }}
      registerFileInput={(el) => { fileInput.current = el; }}
    />
  );
}
