'use client';

import { useState } from 'react';
import './ReferencesList.css';

interface Reference {
  citation: string;
  url?: string;
  doi?: string;
  relevance?: string;
}

interface ReferencesListProps {
  references?: Reference[];
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

export default function ReferencesList({ references }: ReferencesListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!references || references.length === 0) return null;

  return (
    <div className="references-list">
      <button
        className="references-list__toggle"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? 'Hide research sources' : 'Show research sources'}
      >
        <span className={`references-list__toggle-icon ${isExpanded ? 'references-list__toggle-icon--open' : ''}`}>
          ▼
        </span>
        {isExpanded ? 'Hide sources' : 'Research sources'}
        <span>({references.length})</span>
      </button>
      {isExpanded && (
        <ul className="references-list__items">
          {references.map((ref, i) => {
            const url = getRefUrl(ref);
            const hasDoiId = ref.doi && ref.doi.startsWith('10.');

            return (
              <li key={i} className="references-list__item">
                <span className="references-list__icon">📄</span>
                <div className="references-list__content">
                  {/* Full citation as the primary text */}
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="references-list__link"
                    >
                      {ref.citation}
                    </a>
                  ) : (
                    <span className="references-list__link references-list__link--no-url">
                      {ref.citation}
                    </span>
                  )}

                  {/* Metadata line: DOI badge + relevance */}
                  <span className="references-list__meta">
                    {hasDoiId && (
                      <a
                        href={`https://doi.org/${ref.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="references-list__doi-badge"
                      >
                        DOI
                      </a>
                    )}
                    {ref.doi && ref.doi.startsWith('arXiv') && (
                      <span className="references-list__doi-badge references-list__doi-badge--arxiv">
                        arXiv
                      </span>
                    )}
                    {ref.doi && ref.doi.startsWith('ISBN') && (
                      <span className="references-list__doi-badge references-list__doi-badge--book">
                        Book
                      </span>
                    )}
                    {ref.relevance && (
                      <span className="references-list__relevance">{ref.relevance}</span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
