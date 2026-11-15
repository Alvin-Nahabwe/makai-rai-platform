import type { ReactElement } from 'react';
import { EvidenceItemText, evidenceDisplayName } from '@/components/evidence/EvidenceItemText';
import { Button } from '@/components/ui/Button';
import { FieldError, FieldLabel } from '@/components/ui/TextInput';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { stripBidiControls } from '@/lib/evidence/format';
import { LINK_LABEL_MAX } from '@/lib/evidence/link';
import { largeFileNote, notUploadedLine, statusLine, type NamedLine, type UploadItem } from '@/lib/evidence/uploadQueue';
import type { EvidenceItemView } from '@/types/api';
import './EvidenceBlock.css';
import '@/components/ui/formStyles';
import '@/components/ui/buttonStyles';

export interface EvidenceBlockViewProps {
  orgSlug: string;
  /** The platform's public origin (EvidenceBlock `ownOrigin`); absent or null: no link is the platform's own. */
  ownOrigin?: string | null;
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
  /** The parent form refused a save for the address in the box: said after the box's own line, never in its place. */
  linkRefused?: boolean;
  /** A link is being sent: its button is disabled, so a second press sends nothing. */
  linkPending?: boolean;
  /** The parent form's own save is out: "Add link" says to wait and does nothing, and the two boxes take no text. */
  held?: boolean;
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
  /** The decision card only (spec 9.3 item 5): the question's own examples of what to attach, as a list after the legend. */
  examples?: readonly string[];
  /** The decision card only: its one-line layout, "None yet." with nothing attached, and the closed "Accepted files". */
  decisionCard?: boolean;
  /** The decision card only: evidence the form holds that the block cannot name (a restored draft's), so not "None yet.". */
  keptCount?: number;
  /**
   * The decision form only (plan 1C C5): "Save without this file / these files" after the uploading files, its label and
   * its press the form's (its existing `save(true)`). Null or absent while a Save waits: the wait card then holds the one
   * such button (the protected e2e/decision-save.spec.ts UX-30 case finds it by its name).
   */
  saveWithout?: { label: string; onPress: () => void } | null;
}

/** A line with the file name in `<bdi>` (E14). */
function NamedText({ line }: { line: NamedLine }): ReactElement {
  return <>{line.before}{line.name === '' ? null : <bdi>{line.name}</bdi>}{line.after}</>;
}

/**
 * The kit's compact secondary button, worn by the native buttons that need an `aria-label` the kit's Button cannot
 * carry (Remove, Cancel upload, Retry upload), `aria-expanded` (Add a link) or `aria-disabled` (Add link). Button.css
 * is loaded by this file's own kit Button (Add a file), never imported here directly (ruling X-6).
 */
const NAMED_BUTTON = 'ui-button ui-button--secondary ui-button--compact';

/**
 * The evidence block of a decision form, hookless so a unit test can render it. A fieldset nested in the form, so every
 * button is `type="button"`. Progress is text, and an uploading file also has a native `<progress>` inside
 * `[data-upload-progress]`, named "Uploading {file}" (plan 1C C5; the no-score checks allow it there only, and no live
 * region: the line's text is not announced as it changes, interstitial progress is not). `disabled` is its only gate: it
 * renders items and no control (UX-31). Whether a person may add evidence is the server's answer, not this component's.
 */
export function EvidenceBlockView(p: EvidenceBlockViewProps): ReactElement {
  const helpId = `${p.idBase}-help`;
  const typesId = `${p.idBase}-types`;
  const fileInputId = `${p.idBase}-file`;
  const urlId = `${p.idBase}-link-url`;
  const labelId = `${p.idBase}-link-label`;
  const errorId = `${p.idBase}-link-error`;
  const heldId = `${p.idBase}-link-held`;
  const refusedId = `${p.idBase}-link-refused`;
  const held = p.held === true;
  const refused = p.linkRefused === true;
  /** The ids a link box is described by: the help, then what applies now. */
  const describedBy = (...ids: Array<string | false>): string => [helpId, ...ids.filter((id) => id !== false)].join(' ');
  // A field is marked invalid only by its own message; a refusal (signed out, archived, the limiter, a lost connection)
  // is about the request, not a field, and marks neither.
  const urlInvalid = p.linkError === EVIDENCE_COPY.link.address || refused;
  const nameInvalid = p.linkError === EVIDENCE_COPY.link.nameTooLong(LINK_LABEL_MAX);
  const removable = (item: EvidenceItemView, carried: boolean): ReactElement => (
    <li key={item.id} className="evidence-block__item">
      <span className="evidence-block__name">
        <EvidenceItemText orgSlug={p.orgSlug} item={item} ownOrigin={p.ownOrigin ?? null} />
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

  // The decision card (lead's ruling D4, 15 Nov 2026): one line, the legend, "None yet." (or the items under it) and the two
  // add buttons; the link form under them; the question's own examples, visible; the private-data line; the accepted types
  // and the stored sentence in a closed "Accepted files". "None yet." is false while the form holds evidence the block
  // cannot name (keptCount, the kept-evidence box under the block), so it is not said then (review round 1, A-I2).
  const card = p.decisionCard === true;
  // Review round 2, A N-1: in the card the types line sits in a closed disclosure, and a description computed from the help
  // skips a hidden descendant; a hidden element named directly is read. So the add controls name the types line itself.
  const addDescribedBy = card ? `${helpId} ${typesId}` : helpId;
  const noneYet = card && p.notUploaded.length + p.items.length + p.added.length + p.uploads.length + (p.keptCount ?? 0) === 0;
  const examples = p.disabled || p.examples === undefined || p.examples.length === 0 ? null : (
    <div className="evidence-block__examples">
      <p>{EVIDENCE_COPY.examples}</p>
      <ul>{p.examples.map((e) => <li key={e}>{e}</li>)}</ul>
    </div>
  );
  const help = p.disabled ? null : (
    <div id={helpId} className="evidence-block__help">
      <p>{EVIDENCE_COPY.help.keep}</p>
      {card ? (
        <details className="evidence-block__more">
          <summary>{EVIDENCE_COPY.acceptedFiles}</summary>
          <p id={typesId} className="evidence-block__types">{EVIDENCE_COPY.help.types}</p>
          <p className="evidence-block__types">{EVIDENCE_COPY.stored}</p>
        </details>
      ) : <p className="evidence-block__types">{EVIDENCE_COPY.help.types}</p>}
    </div>
  );
  const lists = (
    <>
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
                  {u.state === 'uploading' ? (
                    <span data-upload-progress className="evidence-block__progress">
                      <progress value={Math.min(u.loaded, u.size)} max={Math.max(u.size, 1)} aria-label={EVIDENCE_COPY.uploadingNamed(name)} />
                    </span>
                  ) : null}
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
      {/* C5: one "Save without" for the block, after the files still uploading, while no Save waits. */}
      {!p.disabled && p.saveWithout != null && p.uploads.some((u) => u.state === 'uploading') ? (
        <div className="evidence-block__save-without">
          <Button variant="secondary" size="compact" onClick={p.saveWithout.onPress}>{p.saveWithout.label}</Button>
        </div>
      ) : null}
    </>
  );
  const addBlock = p.disabled ? null : (
    <div className="evidence-block__add">
      {noneYet ? <p className="evidence-block__none">{EVIDENCE_COPY.noneYet}</p> : null}
          <label htmlFor={fileInputId} className="visually-hidden">{EVIDENCE_COPY.chooseFiles}</label>
          <input id={fileInputId} type="file" multiple tabIndex={-1} ref={(el) => p.registerFileInput?.(el)} aria-describedby={addDescribedBy} className="visually-hidden"
            onChange={(e) => { p.onChooseFiles?.(e.target.files); e.target.value = ''; }} />
          <div className="evidence-block__actions">
            <Button variant="secondary" ref={(el) => p.registerAddFileButton?.(el)} aria-describedby={addDescribedBy} onClick={() => p.onOpenFilePicker?.()}>{EVIDENCE_COPY.addFile}</Button>
            <button type="button" className="ui-button ui-button--secondary" aria-describedby={addDescribedBy} aria-expanded={p.linkFormOpen} onClick={() => p.onOpenLink?.()}>{EVIDENCE_COPY.addLinkToggle}</button>
          </div>
          {p.linkFormOpen ? (
            <div className="evidence-block__link">
              <div className="ui-field">
                <FieldLabel htmlFor={urlId} label={EVIDENCE_COPY.webAddress} />
                <input id={urlId} type="text" inputMode="url" autoComplete="off" value={p.linkUrl}
                  className={urlInvalid ? 'ui-input ui-input--invalid' : 'ui-input'}
                  aria-describedby={describedBy(p.linkError !== null && errorId, refused && refusedId, held && heldId)} aria-invalid={urlInvalid ? true : undefined}
                  readOnly={held ? true : undefined} onChange={(e) => p.onLinkUrlChange?.(e.target.value)} onKeyDown={onEnter} />
              </div>
              <div className="ui-field">
                <FieldLabel htmlFor={labelId} label={EVIDENCE_COPY.linkName} />
                <input id={labelId} type="text" autoComplete="off" value={p.linkLabel} className={nameInvalid ? 'ui-input ui-input--invalid' : 'ui-input'}
                  aria-describedby={describedBy(nameInvalid && errorId, held && heldId)} aria-invalid={nameInvalid ? true : undefined}
                  readOnly={held ? true : undefined} onChange={(e) => p.onLinkLabelChange?.(e.target.value)} onKeyDown={onEnter} />
              </div>
              {/* Held is aria-disabled, never disabled: the button keeps its focus and says why it does nothing. The block does not add while held. */}
              <button type="button" className="ui-button ui-button--secondary" disabled={p.linkPending === true}
                aria-disabled={held ? true : undefined} aria-describedby={held ? heldId : undefined} onClick={() => p.onAddLink?.()}>{EVIDENCE_COPY.addLink}</button>
              {/* In the markup from the moment the link form opens and empty until a link is sent, so its words are announced. */}
              <p role="status" data-link-adding className="evidence-block__adding">{p.linkPending === true ? EVIDENCE_COPY.link.adding : ''}</p>
              {held ? <p id={heldId} className="evidence-block__adding">{EVIDENCE_COPY.link.waitForSave}</p> : null}
              {/* Where the line was before the kit: after the button, so a refusal that is not about the address still reads in order. */}
              {p.linkError === null && !refused ? null : (
                <div className="evidence-block__error" role="alert">
                  {p.linkError === null ? null : <FieldError id={errorId} message={p.linkError} />}
                  {refused ? <FieldError id={refusedId} message={EVIDENCE_COPY.link.typedNotAdded} /> : null}
                </div>
              )}
            </div>
          ) : null}
    </div>
  );

  return card ? (
    <fieldset className="evidence-block evidence-block--card">
      <legend>{EVIDENCE_COPY.legend}</legend>
      {addBlock}
      {lists}
      {examples}
      {help}
    </fieldset>
  ) : (
    <fieldset className="evidence-block">
      <legend>{EVIDENCE_COPY.legend}</legend>
      {help}
      {lists}
      {addBlock}
    </fieldset>
  );
}
