import './ReferencesList.css';

interface Reference {
  citation: string;
  url?: string;
  doi?: string;
  relevance?: string;
}

interface ReferencesListProps {
  references?: readonly Reference[];
}

/**
 * Builds a clickable URL from a reference object.
 * Priority: explicit url > DOI link > null
 */
function getRefUrl(ref: Reference): string | null {
  if (ref.url) return ref.url;
  if (ref.doi && ref.doi.startsWith('10.')) return `https://doi.org/${ref.doi}`;
  return null;
}

/**
 * The research sources of a risk area (S-26). A native `<details>`: collapsed by default, opened by its summary with
 * the keyboard or a click and with no script, and every source is in the page's HTML before anything runs (UX-36).
 * A server component, so it ships no client code. Colours are theme tokens (ReferencesList.css), and no emoji is
 * drawn (SRS 7.5.1).
 */
export default function ReferencesList({ references }: ReferencesListProps) {
  if (!references || references.length === 0) return null;

  return (
    <details className="references-list">
      <summary className="references-list__toggle">{`Research sources (${references.length})`}</summary>
      <ul className="references-list__items">
        {references.map((ref, i) => {
          const url = getRefUrl(ref);
          const hasDoiId = ref.doi && ref.doi.startsWith('10.');

          return (
            <li key={i} className="references-list__item">
              {/* Full citation as the primary text */}
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="references-list__link">
                  {ref.citation}
                </a>
              ) : (
                <span className="references-list__link references-list__link--no-url">{ref.citation}</span>
              )}

              {/* Metadata line: DOI badge + relevance. data-source-note: a cited figure is not a percentage of the
                  team's items (SRS 7.5.3), so e2e/helpers/noScore.ts skips percentages here, and only percentages. */}
              <span className="references-list__meta">
                {hasDoiId && (
                  <a href={`https://doi.org/${ref.doi}`} target="_blank" rel="noopener noreferrer" className="references-list__doi-badge">
                    DOI
                  </a>
                )}
                {ref.doi && ref.doi.startsWith('arXiv') && <span className="references-list__doi-badge">arXiv</span>}
                {ref.doi && ref.doi.startsWith('ISBN') && <span className="references-list__doi-badge">Book</span>}
                {ref.relevance && <span className="references-list__relevance" data-source-note="">{ref.relevance}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
