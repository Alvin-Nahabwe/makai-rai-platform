import type { ReactElement } from 'react';
import { EvidenceItemText, evidenceDisplayName } from '@/components/evidence/VersionEvidenceList';
import { Button } from '@/components/ui/Button';
import { FieldError, FieldLabel } from '@/components/ui/TextInput';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { stripBidiControls } from '@/lib/evidence/format';
import { largeFileNote, notUploadedLine, statusLine, type NamedLine, type UploadItem } from '@/lib/evidence/uploadQueue';
import type { EvidenceItemView } from '@/types/api';
import './EvidenceBlock.css';

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
  registerFileInput?: (el: HTMLInputElement | null) => void;
}

/** A line with the file name in `<bdi>` (E14). */
function NamedText({ line }: { line: NamedLine }): ReactElement {
  return <>{line.before}{line.name === '' ? null : <bdi>{line.name}</bdi>}{line.after}</>;
}

/**
 * The kit's compact secondary button, worn by the native buttons that need an `aria-label` the kit's Button cannot
 * carry (Remove, Cancel upload, Retry upload) or `aria-expanded` (Add a link). Button.css is loaded by this file's
 * own kit Buttons (Add a file, Add link), never imported here directly (ruling X-6).
 */
const NAMED_BUTTON = 'ui-button ui-button--secondary ui-button--compact';

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
    <li key={item.id} className="evidence-block__item">
      <span className="evidence-block__name">
        <EvidenceItemText orgSlug={p.orgSlug} item={item} />
        {carried && p.fromVersionNumber != null ? <>{' '}<span className="evidence-block__from">{EVIDENCE_COPY.fromCurrent}</span></> : null}
      </span>
      {p.disabled ? null : (
        <button type="button" className={NAMED_BUTTON} aria-label={EVIDENCE_COPY.removeNamed(evidenceDisplayName(item))} onClick={() => p.onRemoveItem?.(item.id)}>{EVIDENCE_COPY.remove}</button>
      )}
    </li>
  );
  const onEnter = (e: { key: string; preventDefault: () => void }): void => {
    if (e.key === 'Enter') { e.preventDefault(); p.onAddLink?.(); }
  };

  return (
    <fieldset className="evidence-block">
      <legend>{EVIDENCE_COPY.legend}</legend>
      {p.disabled ? null : (
        <div id={helpId} className="evidence-block__help">
          <p>{EVIDENCE_COPY.help.keep}</p>
          <p className="evidence-block__types">{EVIDENCE_COPY.help.types}</p>
        </div>
      )}

      {p.notUploaded.length > 0 ? (
        <ul className="evidence-block__list">{p.notUploaded.map((name) => <li key={name} className="evidence-block__item"><span className="evidence-block__name"><NamedText line={notUploadedLine(name)} /></span></li>)}</ul>
      ) : null}

      {p.items.length + p.added.length > 0 ? (
        <ul className="evidence-block__list">{[...p.items.map((i) => removable(i, true)), ...p.added.map((i) => removable(i, false))]}</ul>
      ) : null}

      {p.uploads.length > 0 ? (
        <ul className="evidence-block__list">
          {p.uploads.map((u) => {
            const line = statusLine(u);
            const name = stripBidiControls(u.fileName);
            const note = u.state === 'uploading' ? largeFileNote(u.size) : null;
            const role = u.state === 'failed' ? 'alert' : u.state === 'uploaded' ? 'status' : undefined;
            return (
              <li key={u.key} className="evidence-block__item">
                <span className="evidence-block__name">
                  <span role={role}><NamedText line={line} /></span>
                  {/* The space sits outside the note, so the note's own text is the ruled sentence alone (NFR-PERF-06). */}
                  {note === null ? null : <>{' '}<span className="evidence-block__note">{note}</span></>}
                </span>
                {p.disabled ? null : (
                  <>
                    {u.state === 'uploading' ? (
                      <button type="button" className={NAMED_BUTTON} aria-label={EVIDENCE_COPY.cancelUploadNamed(name)} onClick={() => p.onCancelUpload?.(u.key)}>{EVIDENCE_COPY.cancelUpload}</button>
                    ) : null}
                    {u.state === 'failed' && line.retry ? (
                      <button type="button" className={NAMED_BUTTON} aria-label={EVIDENCE_COPY.retryUploadNamed(name)} onClick={() => p.onRetryUpload?.(u.key)}>{EVIDENCE_COPY.retryUpload}</button>
                    ) : null}
                    {u.state !== 'uploading' ? (
                      <button type="button" className={NAMED_BUTTON} aria-label={EVIDENCE_COPY.removeNamed(name)} onClick={() => p.onRemoveUpload?.(u.key)}>{EVIDENCE_COPY.remove}</button>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {p.disabled ? null : (
        <div className="evidence-block__add">
          <label htmlFor={fileInputId} className="visually-hidden">{EVIDENCE_COPY.chooseFiles}</label>
          <input id={fileInputId} type="file" multiple tabIndex={-1} ref={(el) => p.registerFileInput?.(el)} aria-describedby={helpId} className="visually-hidden"
            onChange={(e) => { p.onChooseFiles?.(e.target.files); e.target.value = ''; }} />
          <div className="evidence-block__actions">
            <Button variant="secondary" ref={(el) => p.registerAddFileButton?.(el)} aria-describedby={helpId} onClick={() => p.onOpenFilePicker?.()}>{EVIDENCE_COPY.addFile}</Button>
            <button type="button" className="ui-button ui-button--secondary" aria-describedby={helpId} aria-expanded={p.linkFormOpen} onClick={() => p.onOpenLink?.()}>{EVIDENCE_COPY.addLinkToggle}</button>
          </div>
          {p.linkFormOpen ? (
            <div className="evidence-block__link">
              <div className="ui-field">
                <FieldLabel htmlFor={urlId} label={EVIDENCE_COPY.webAddress} />
                <input id={urlId} type="text" inputMode="url" autoComplete="off" value={p.linkUrl}
                  className={p.linkError === null ? 'ui-input' : 'ui-input ui-input--invalid'}
                  aria-describedby={p.linkError === null ? helpId : `${helpId} ${errorId}`} aria-invalid={p.linkError === null ? undefined : true}
                  onChange={(e) => p.onLinkUrlChange?.(e.target.value)} onKeyDown={onEnter} />
              </div>
              <div className="ui-field">
                <FieldLabel htmlFor={labelId} label={EVIDENCE_COPY.linkName} />
                <input id={labelId} type="text" autoComplete="off" value={p.linkLabel} className="ui-input" aria-describedby={helpId}
                  onChange={(e) => p.onLinkLabelChange?.(e.target.value)} onKeyDown={onEnter} />
              </div>
              <Button variant="secondary" disabled={p.linkPending === true} onClick={() => p.onAddLink?.()}>{EVIDENCE_COPY.addLink}</Button>
              {/* Where the line was before the kit: after the button, so a refusal that is not about the address still reads in order. */}
              {p.linkError === null ? null : <div className="evidence-block__error" role="alert"><FieldError id={errorId} message={p.linkError} /></div>}
            </div>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}
