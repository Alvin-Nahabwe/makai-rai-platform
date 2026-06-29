'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import assessmentAreas from '@/data/assessmentAreas.json';
import ControlResourcesList from '@/components/report/ControlResourcesList';
import './ControlsLibraryPage.css';

const NOTEBOOK_BASE_URL = 'https://github.com/Alvin-Nahabwe/mak-responsible-ai-toolkit/blob/master';

interface TypeConfigEntry {
  label: string;
  color: string;
}

const typeConfig: Record<string, TypeConfigEntry> = {
  technical: { label: 'Technical', color: '#C06014' },
  procedural: { label: 'Procedural', color: '#8B4513' },
  informational: { label: 'Informational', color: '#A0522D' },
};

export default function ControlsLibraryPage() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const controls = assessmentAreas.controls;
  const areas = assessmentAreas.areas;

  // Auto-expand and scroll to control from URL hash (e.g. /controls#C-01)
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && controls.find((c) => c.id === hash)) {
        setExpandedIds(prev => new Set(prev).add(hash));
        setTimeout(() => {
          const el = cardRefs.current[hash];
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    };

    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [pathname, searchParams, controls]);

  // Build reverse map: control → areas that reference it
  const controlToAreas: Record<string, typeof areas> = {};
  controls.forEach((c) => { controlToAreas[c.id] = []; });
  areas.forEach((area) => {
    (area.controls || []).forEach((cId: string) => {
      if (controlToAreas[cId]) controlToAreas[cId].push(area);
    });
  });

  const filtered = activeFilter === 'all'
    ? controls
    : controls.filter((c) => c.type === activeFilter);

  const typeCounts: Record<string, number> = { all: controls.length };
  controls.forEach((c) => { typeCounts[c.type] = (typeCounts[c.type] || 0) + 1; });

  return (
    <div className="controls-library" id="controls-library-page">
      {/* Hero */}
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">Recommended controls</span>
          <h1>Controls Library</h1>
          <p className="page-hero__desc">
            {controls.length} controls tied to the assessment. Use the filters below to narrow by type.
          </p>
        </div>
      </section>

      {/* Filters */}
      <section className="section">
        <div className="container">
          <div className="controls-filters">
            {[
              { key: 'all', label: 'All' },
              { key: 'technical', label: 'Technical' },
              { key: 'procedural', label: 'Procedural' },
              { key: 'informational', label: 'Informational' },
            ].map((f) => (
              <button
                key={f.key}
                className={`controls-filter-btn ${activeFilter === f.key ? 'controls-filter-btn--active' : ''}`}
                onClick={() => setActiveFilter(f.key)}
              >
                {f.label} <span className="controls-filter-btn__count">{typeCounts[f.key] || 0}</span>
              </button>
            ))}
          </div>

          {/* Controls Grid */}
          <div className="controls-grid">
            {filtered.map((c) => {
              const cfg = typeConfig[c.type];
              const linkedAreas = controlToAreas[c.id] || [];
              const isExpanded = expandedIds.has(c.id);

              return (
                <div
                  key={c.id}
                  ref={(el) => { cardRefs.current[c.id] = el; }}
                  className={`control-card card ${isExpanded ? 'control-card--expanded' : ''}`}
                  style={{ '--type-color': cfg.color } as React.CSSProperties}
                >
                  <div className="control-card__header">
                    <div className="control-card__meta">
                      <span className="control-card__id">{c.id}</span>
                      <span className={`control-card__type control-card__type--${c.type}`}>{cfg.label}</span>
                    </div>
                  </div>
                  <h3 className="control-card__title">{c.name}</h3>
                  <p className="control-card__desc">{c.description}</p>

                  {/* Action links — notebook for technical controls */}
                  {c.notebook && !Boolean((c as Record<string, unknown>).notebookPlaceholder) && (
                    <div className="control-card__badges">
                      <a
                        href={`${NOTEBOOK_BASE_URL}/${c.notebook}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="control-card__notebook-link"
                      >
                        Notebook
                      </a>
                    </div>
                  )}
                  {Boolean((c as Record<string, unknown>).notebookPlaceholder) && (
                    <div className="control-card__badges">
                      <span className="badge badge--coming-soon">Notebook coming soon</span>
                    </div>
                  )}

                  {/* Resources & Template — driven from data */}
                  <ControlResourcesList
                    resources={c.resources}
                    template={c.template ?? undefined}
                  />

                  {/* Linked Areas Toggle */}
                  {linkedAreas.length > 0 && (
                    <>
                      <button
                        className="control-card__toggle"
                        onClick={() => setExpandedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        })}
                      >
                        {isExpanded ? '▲ Hide' : '▼ Show'} linked assessment areas ({linkedAreas.length})
                      </button>
                      {isExpanded && (
                        <div className="control-card__areas">
                          {linkedAreas.map((area) => (
                            <div key={area.id} className="control-card__area-item">
                              <span className="control-card__area-id">{area.id}</span>
                              <div>
                                <Link href={`/explore/framework#area-card-${area.id}`} className="control-card__area-link">
                                  <strong>{area.name}</strong>
                                </Link>
                                <span className="control-card__area-stage">{area.stage}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
