'use client';

import { useState } from 'react';
import './ControlResourcesList.css';

const typeIcons: Record<string, string> = {
  framework: 'F',
  tool: 'T',
  paper: 'P',
};

const typeLabels: Record<string, string> = {
  framework: 'Framework',
  tool: 'Tool',
  paper: 'Paper',
};

interface Resource {
  type: string;
  url: string;
  title: string;
}

interface ControlResourcesListProps {
  resources?: Resource[];
  template?: string;
}

export default function ControlResourcesList({ resources, template }: ControlResourcesListProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const hasResources = resources && resources.length > 0;
  const hasTemplate = !!template;

  if (!hasResources && !hasTemplate) return null;

  return (
    <div className="ctrl-resources">
      {/* Template action — always visible */}
      {hasTemplate && (
        <a
          href={template}
          target="_blank"
          rel="noopener noreferrer"
          className="ctrl-resources__template-btn"
        >
          <span className="ctrl-resources__template-icon" aria-hidden="true">&#9998;</span>
          Template
        </a>
      )}

      {/* Resources toggle — only show when control does NOT have a template.
         For controls with templates, resources are covered in the template's
         grounding section, so we don't duplicate them here. */}
      {hasResources && !hasTemplate && (
        <>
          <button
            className="ctrl-resources__toggle"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Hide resources' : 'Show resources'}
          >
            <span className={`ctrl-resources__chevron ${isExpanded ? 'ctrl-resources__chevron--open' : ''}`}>
              ▼
            </span>
            {isExpanded ? 'Hide' : 'View'} resources
            <span className="ctrl-resources__count">({resources!.length})</span>
          </button>

          {isExpanded && (
            <ul className="ctrl-resources__list">
              {resources!.map((res, i) => (
                <li key={i} className="ctrl-resources__item">
                  <span className={`ctrl-resources__item-icon ctrl-resources__item-icon--${res.type}`} aria-hidden="true">
                    {typeIcons[res.type] || 'R'}
                  </span>
                  <div className="ctrl-resources__item-content">
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ctrl-resources__item-link"
                    >
                      {res.title}
                    </a>
                    <span className={`ctrl-resources__type-badge ctrl-resources__type-badge--${res.type}`}>
                      {typeLabels[res.type] || res.type}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
