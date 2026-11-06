import type { ReactElement } from 'react';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DownloadLink } from '@/components/ui/DownloadLink';
import { formatDay } from '@/lib/format/dates';
import type { ContentArea, ContentControl, ResourceLink, ResourcesFile } from '@/types/content';
import type { Stage } from '@/types/record';
import './ControlCard.css';

const TYPE_WORDS: Record<string, string> = { technical: 'Technical', procedural: 'Procedural', informational: 'Informational' };
const STAGE_WORDS: Record<Stage, string> = {
  'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
};
const RESOURCE_TYPE_WORDS: Record<string, string> = { framework: 'Framework', tool: 'Tool', paper: 'Paper', guidance: 'Guidance' };
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
  const word = r.type === undefined ? undefined : RESOURCE_TYPE_WORDS[r.type];
  // The release check refuses any other type; a bare "Resource" would hide that the type is missing (UX-13 wants it in words).
  if (word === undefined) throw new RangeError(`resource ${r.title} has type ${String(r.type)}, which the card has no word for`);
  if (!isHttps(r.url)) return <li>{`${r.title} (${word})`}</li>;
  return (
    <li>
      <a href={r.url} rel="noopener noreferrer">{`${r.title} (${word}, opens another site)`}</a>
    </li>
  );
}

/** The control's type in words. A type with none is a content error (the release check refuses it), not text to print. */
function typeWord(control: ContentControl): string {
  const word = TYPE_WORDS[control.type];
  if (word === undefined) throw new RangeError(`control ${control.id} has type ${control.type}, which the card has no word for`);
  return word;
}

export type ControlCardProps = {
  control: ContentControl;
  resources: ResourcesFile;
  alsoAddresses?: readonly ContentArea[];
  usuallyAppliedIn?: Stage | null;
  headingLevel: 3 | 4;
};

/**
 * One control: what it is, which other areas it addresses, and only the reviewed template and the released notebook
 * that exist for it (FR-SUG-04 to 06, UX-13). A server component; nothing here needs script.
 */
export function ControlCard({ control, resources, alsoAddresses = [], usuallyAppliedIn = null, headingLevel }: ControlCardProps): ReactElement {
  const Heading = `h${headingLevel}` as 'h3' | 'h4';
  const template = resources.templates.find((t) => t.controlId === control.id && t.review.outcome === 'passed');
  const notebook = resources.notebooks.find((n) => n.controlId === control.id && n.released && n.review.outcome === 'passed');
  const free = control.resources ?? [];
  return (
    <article className="ctl-card" data-control={control.id}>
      <Heading className="ctl-card__title">{control.name}</Heading>
      <p className="ctl-card__type">{typeWord(control)}</p>
      <p className="ctl-card__desc">{control.description}</p>
      {alsoAddresses.length > 0 && (
        <p className="ctl-card__note">{`Also addresses: ${alsoAddresses.map((a) => `${a.id} ${a.name}`).join(', ')}`}</p>
      )}
      {usuallyAppliedIn && <p className="ctl-card__note">{`Usually applied in ${STAGE_WORDS[usuallyAppliedIn]}`}</p>}
      {template && (
        <p className="ctl-card__download">
          <DownloadLink href={template.file} label={`Template: ${control.name}`} kind={template.kind} bytes={template.bytes} />
        </p>
      )}
      {notebook && (
        <div className="ctl-card__notebook">
          <p className="ctl-card__notebook-title">Notebook: how to apply this with a free tool to your own data</p>
          <ul className="ctl-card__list">
            <li><DownloadLink href={notebook.file} label="Download notebook" kind=".ipynb" bytes={notebook.bytes} /></li>
            <li>
              <DownloadLink
                href={notebook.requirementsFile} label="Download requirements.txt" kind=".txt"
                bytes={sizeOfServedFile(notebook.requirementsFile)}
              />
            </li>
          </ul>
          <p className="ctl-card__note">Runs on your own computer or notebook service. The platform never runs it.</p>
          <p className="ctl-card__note">{`Reviewed by ${notebook.review.reviewer} on ${formatDay(notebook.review.date)}.`}</p>
        </div>
      )}
      {free.length > 0 && (
        <div className="ctl-card__resources">
          <p className="ctl-card__resources-title">{`Free resources (${free.length}):`}</p>
          <ul className="ctl-card__list">
            {free.map((r, i) => <Resource key={`${i}-${r.url}`} r={r} />)}
          </ul>
        </div>
      )}
    </article>
  );
}
