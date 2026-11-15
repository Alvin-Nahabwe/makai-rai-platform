import type { ReactElement } from 'react';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DownloadLink } from '@/components/ui/DownloadLink';
import { Definition } from '@/components/ui/Definition';
import { markTerms, usesTerm } from '@/components/review/markTerms';
import { formatDay } from '@/lib/format/dates';
import { SUGGESTIONS_COPY } from '@/lib/suggestions/copy';
import type { ContentArea, ContentControl, ResourceLink, ResourcesFile } from '@/types/content';
import type { Stage } from '@/types/record';
import { TERM_MODEL_CARD } from '@/lib/vocabulary/terms';
import './ControlCard.css';

const WORDS = SUGGESTIONS_COPY.card;
/** A resource is a link only when its address is https (G1); anything else, or an address that does not parse, is text. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Sizes of served files by URL path: the files ship with the release and do not change under a running server. A missing file still throws. */
const servedSizes = new Map<string, number>();
function sizeOfServedFile(urlPath: string): number {
  let size = servedSizes.get(urlPath);
  if (size === undefined) {
    size = statSync(join(process.cwd(), 'public', urlPath)).size;
    servedSizes.set(urlPath, size);
  }
  return size;
}

function Resource({ r }: { r: ResourceLink }): ReactElement {
  const word = r.type === undefined ? undefined : WORDS.resourceTypeWords[r.type];
  // The release check refuses any other type; a bare "Resource" would hide that the type is missing (UX-13 wants it in words).
  if (word === undefined) throw new RangeError(`resource ${r.title} has type ${String(r.type)}, which the card has no word for`);
  if (!isHttps(r.url)) return <li>{WORDS.resource(r.title, word)}</li>;
  return (
    <li>
      <a href={r.url} rel="noopener noreferrer">{WORDS.resourceElsewhere(r.title, word)}</a>
    </li>
  );
}

/** The control's type in words. A type with none is a content error (the release check refuses it), not text to print. */
function typeWord(control: ContentControl): string {
  const word = WORDS.typeWords[control.type];
  if (word === undefined) throw new RangeError(`control ${control.id} has type ${control.type}, which the card has no word for`);
  return word;
}

export type ControlCardProps = {
  control: ContentControl;
  resources: ResourcesFile;
  alsoAddresses?: readonly ContentArea[];
  usuallyAppliedIn?: Stage | null;
  headingLevel: 3 | 4;
  /**
   * Lane 6, FX2 (ruling X-5): the card repeats on a page, so it defines nothing unless the page asks. When true and the
   * description uses "model card", that use is marked as the term and its definition follows the description. The
   * controls page sets it on the first card whose description holds the page's first use (spec 6); S-12 and S-15 leave it off.
   */
  defineModelCard?: boolean;
};

/**
 * One control: what it is, which other areas it addresses, and only the reviewed template and the released notebook
 * that exist for it (FR-SUG-04 to 06, UX-13). A server component; nothing here needs script.
 */
export function ControlCard({ control, resources, alsoAddresses = [], usuallyAppliedIn = null, headingLevel, defineModelCard = false }: ControlCardProps): ReactElement {
  const Heading = `h${headingLevel}` as 'h3' | 'h4';
  const template = resources.templates.find((t) => t.controlId === control.id && t.review.outcome === 'passed');
  const notebook = resources.notebooks.find((n) => n.controlId === control.id && n.released && n.review.outcome === 'passed');
  const free = control.resources ?? [];
  const defineHere = defineModelCard && usesTerm(control.description, TERM_MODEL_CARD);
  return (
    <article className="ctl-card" data-control={control.id}>
      <Heading className="ctl-card__title">{control.name}</Heading>
      <p className="ctl-card__type">{WORDS.type(typeWord(control))}</p>
      <p className="ctl-card__desc">{defineHere ? markTerms(control.description, [TERM_MODEL_CARD]) : control.description}</p>
      {defineHere ? <Definition of={TERM_MODEL_CARD} as="p" /> : null}
      {alsoAddresses.length > 0 && (
        <p className="ctl-card__note">{WORDS.alsoHelps(alsoAddresses.map((a) => a.name))}</p>
      )}
      {usuallyAppliedIn && <p className="ctl-card__note">{WORDS.usuallyApplied(usuallyAppliedIn)}</p>}
      {template && (
        <p className="ctl-card__download">
          <DownloadLink href={template.file} label={WORDS.template(control.name)} kind={template.kind} bytes={template.bytes} />
        </p>
      )}
      {notebook && (
        <div className="ctl-card__notebook">
          <p className="ctl-card__notebook-title">{WORDS.notebookTitle}</p>
          <ul className="ctl-card__list">
            <li><DownloadLink href={notebook.file} label={WORDS.downloadNotebook} kind=".ipynb" bytes={notebook.bytes} /></li>
            <li>
              <DownloadLink
                href={notebook.requirementsFile} label={WORDS.downloadRequirements} kind=".txt"
                bytes={sizeOfServedFile(notebook.requirementsFile)}
              />
            </li>
          </ul>
          <p className="ctl-card__note">{WORDS.runsOn}</p>
          <p className="ctl-card__note">{WORDS.reviewed(notebook.review.reviewer, formatDay(notebook.review.date))}</p>
        </div>
      )}
      {free.length > 0 && (
        <div className="ctl-card__resources">
          <p className="ctl-card__resources-title">{WORDS.freeResources}</p>
          <ul className="ctl-card__list">
            {free.map((r, i) => <Resource key={`${i}-${r.url}`} r={r} />)}
          </ul>
        </div>
      )}
    </article>
  );
}
