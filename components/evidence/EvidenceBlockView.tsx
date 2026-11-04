import type { ReactElement } from 'react';
import { EvidenceItemText, evidenceDisplayName } from '@/components/evidence/VersionEvidenceList';
import { stripBidiControls } from '@/lib/evidence/format';
import { largeFileNote, notUploadedLine, statusLine, type NamedLine, type UploadItem } from '@/lib/evidence/uploadQueue';
import type { EvidenceItemView } from '@/types/api';

/** W-3's help line (SRS lines 1895-1896). */
export const EVIDENCE_HELP =
  'PDF, PNG, JPEG, Office documents or ZIP, up to 10 MB each. Do not upload datasets or files about the people your system affects. Add a link to where they are kept instead.';

export interface EvidenceBlockViewProps {
  orgSlug: string;
  /** Prefix of the ids the labels and descriptions point at. */
  idBase: string;
  /** Items carried from the version being edited, not removed. */
  items: readonly EvidenceItemView[];
  /** Links added in this session. */
  added: readonly EvidenceItemView[];
  fromVersionNumber?: number | null;
  uploads: readonly UploadItem[];
  notUploaded: readonly string[];
  disabled: boolean;
  linkFormOpen: boolean;
  linkUrl: string;
  linkLabel: string;
  linkError: string | null;
  /** A link is being sent: its button is disabled, so a second press sends nothing. */
  linkPending?: boolean;
  onChooseFiles?: (files: FileList | null) => void;
  onOpenFilePicker?: () => void;
  onOpenLink?: () => void;
  onLinkUrlChange?: (v: string) => void;
  onLinkLabelChange?: (v: string) => void;
  onAddLink?: () => void;
  onRemoveItem?: (id: string) => void;
  onCancelUpload?: (key: string) => void;
  onRetryUpload?: (key: string) => void;
  onRemoveUpload?: (key: string) => void;
  registerAddFileButton?: (el: HTMLButtonElement | null) => void;
}

/** A line with the file name in `<bdi>` (E14). */
function NamedText({ line }: { line: NamedLine }): ReactElement {
  return <>{line.before}{line.name === '' ? null : <bdi>{line.name}</bdi>}{line.after}</>;
}

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const;

/**
 * The evidence block of a decision form, hookless so a unit test can render it. A fieldset nested in the form, so every
 * button is `type="button"`. Progress is text, never a progress element (UX-30). `disabled` is its only gate: it
 * renders items and no control (UX-31). Whether a person may add evidence is the server's answer, not this component's.
 */
export function EvidenceBlockView(p: EvidenceBlockViewProps): ReactElement {
  const helpId = `${p.idBase}-help`;
  const fileInputId = `${p.idBase}-file`;
  const urlId = `${p.idBase}-link-url`;
  const labelId = `${p.idBase}-link-label`;
  const errorId = `${p.idBase}-link-error`;
  const removable = (item: EvidenceItemView, carried: boolean): ReactElement => (
    <li key={item.id}>
      <EvidenceItemText orgSlug={p.orgSlug} item={item} />
      {carried && p.fromVersionNumber != null ? <span className="text-muted">{` from version ${p.fromVersionNumber}`}</span> : null}
      {p.disabled ? null : (
        <button type="button" className="btn btn--secondary btn--small" aria-label={`Remove ${evidenceDisplayName(item)}`} onClick={() => p.onRemoveItem?.(item.id)}>Remove</button>
      )}
    </li>
  );

  return (
    <fieldset>
      <legend>Evidence</legend>
      {p.disabled ? null : <p id={helpId} className="text-muted">{EVIDENCE_HELP}</p>}

      {p.notUploaded.length > 0 ? (
        <ul>{p.notUploaded.map((name) => <li key={name}><NamedText line={notUploadedLine(name)} /></li>)}</ul>
      ) : null}

      {p.items.length + p.added.length > 0 ? (
        <ul>{[...p.items.map((i) => removable(i, true)), ...p.added.map((i) => removable(i, false))]}</ul>
      ) : null}

      {p.uploads.length > 0 ? (
        <ul>
          {p.uploads.map((u) => {
            const line = statusLine(u);
            const name = stripBidiControls(u.fileName);
            const note = u.state === 'uploading' ? largeFileNote(u.size) : null;
            const role = u.state === 'failed' ? 'alert' : u.state === 'uploaded' ? 'status' : undefined;
            return (
              <li key={u.key}>
                <span role={role}><NamedText line={line} /></span>
                {note === null ? null : <span className="text-muted">{` ${note}`}</span>}
                {p.disabled ? null : (
                  <>
                    {u.state === 'uploading' ? (
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Cancel upload ${name}`} onClick={() => p.onCancelUpload?.(u.key)}>Cancel upload</button>
                    ) : null}
                    {u.state === 'failed' && line.retry ? (
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Retry upload ${name}`} onClick={() => p.onRetryUpload?.(u.key)}>Retry upload</button>
                    ) : null}
                    {u.state !== 'uploading' ? (
                      <button type="button" className="btn btn--secondary btn--small" aria-label={`Remove ${name}`} onClick={() => p.onRemoveUpload?.(u.key)}>Remove</button>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {p.disabled ? null : (
        <div>
          <label htmlFor={fileInputId} style={VISUALLY_HIDDEN}>Choose files to add as evidence</label>
          <input id={fileInputId} type="file" multiple tabIndex={-1} aria-describedby={helpId} style={VISUALLY_HIDDEN}
            onChange={(e) => { p.onChooseFiles?.(e.target.files); e.target.value = ''; }} />
          <button type="button" className="btn btn--secondary" ref={(el) => p.registerAddFileButton?.(el)} aria-describedby={helpId} onClick={() => p.onOpenFilePicker?.()}>Add a file</button>
          <button type="button" className="btn btn--secondary" aria-describedby={helpId} aria-expanded={p.linkFormOpen} onClick={() => p.onOpenLink?.()}>Add a link</button>
          {p.linkFormOpen ? (
            <div>
              <label htmlFor={urlId}>Web address</label>
              <input id={urlId} type="text" inputMode="url" autoComplete="off" value={p.linkUrl}
                aria-describedby={p.linkError === null ? helpId : `${helpId} ${errorId}`} aria-invalid={p.linkError === null ? undefined : true}
                onChange={(e) => p.onLinkUrlChange?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); p.onAddLink?.(); } }} />
              <label htmlFor={labelId}>Label (optional)</label>
              <input id={labelId} type="text" autoComplete="off" value={p.linkLabel} aria-describedby={helpId}
                onChange={(e) => p.onLinkLabelChange?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); p.onAddLink?.(); } }} />
              <button type="button" className="btn btn--secondary" disabled={p.linkPending === true} onClick={() => p.onAddLink?.()}>Add link</button>
              {p.linkError === null ? null : <p id={errorId} className="form-error" role="alert">{p.linkError}</p>}
            </div>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}
