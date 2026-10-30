'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import assessmentAreas from '@/data/assessmentAreas.json';
import { stageLabels, principleSlugMap } from '@/data/constants';
import ReferencesList from '@/components/report/ReferencesList';
import './FrameworkMapPage.css';

export default function FrameworkMapPage() {
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // In Next.js, window.location.hash isn't available via next/navigation,
  // so we read it from the browser directly on mount and on hash changes.
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash.startsWith('area-card-')) {
        const areaId = hash.replace('area-card-', '');
        const area = assessmentAreas.areas.find((a: { id: string }) => a.id === areaId);
        if (area) {
          setActiveStage(area.stage);
          setTimeout(() => {
            const el = document.getElementById(hash);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 150);
        }
      }
    };

    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [pathname, searchParams]);

  const areasByStage: Record<string, typeof assessmentAreas.areas> = {};
  assessmentAreas.areas.forEach((area) => {
    if (!areasByStage[area.stage]) areasByStage[area.stage] = [];
    areasByStage[area.stage].push(area);
  });

  const controlsMap: Record<string, (typeof assessmentAreas.controls)[number]> = {};
  assessmentAreas.controls.forEach((c) => { controlsMap[c.id] = c; });

  const activeAreas = activeStage ? areasByStage[activeStage] || [] : [];

  return (
    <div className="framework-page" id="framework-map-page">
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">21 assessment areas · 3 lifecycle stages</span>
          <h1>Framework map</h1>
          <p className="page-hero__desc">
            Each lifecycle stage has its own assessment areas and suggested fixes. Pick a stage below to see what&apos;s covered.
          </p>
        </div>
      </section>

      {/* What this framework does and does not cover.
          Findings 13 and 14 of the 2026-08-18 content audit. It lives here, on a
          page, rather than in `data/assessmentAreas.json` meta for two reasons:
          `meta` is read only for the version number, so a scope statement there
          would be invisible to every user; and content files are hashed into the
          framework version, so putting it there would strand every pinned
          assessment (D-167) to publish a paragraph. */}
      <section className="section" id="framework-scope">
        <div className="container">
          <details className="framework-scope">
            <summary>
              <strong>What this framework covers — and what it does not</strong>
            </summary>
            <div style={{ marginTop: '1rem', maxWidth: '70ch', lineHeight: 1.6 }}>
              <p>
                These 21 areas were written for <strong>predictive machine-learning systems</strong>
                {' '}(models that classify cases, put them in order, or estimate a value). Generative systems raise questions this
                framework does not yet ask, so what a team records here says nothing about a
                generative deployment.
              </p>
              <p>
                The bias it assesses is <strong>statistical and dataset bias</strong>: who is in the
                data, how labels were produced, how error is distributed across groups. It does not
                assess <strong>institutional bias</strong> — who chose the problem, who benefits from
                the system existing, whose priorities set the objective. Those questions matter and
                are simply out of scope here.
              </p>
              <p>
                <strong>On the standards.</strong> ISO/IEC 42001 clauses 6.1.4 and 8.4 and Annex A
                objective A.5 describe an AI system impact assessment. This framework is a separate
                tool and does <em>not</em> replace that standard, which applies to an
                organisation&apos;s management system rather than a single AI system. EU AI Act
                articles appear as reference context on individual controls; showing one is not a
                determination that the Act applies to your system, which depends on its risk tier.
              </p>
              <p>
                <strong>On the eight principles.</strong> UNESCO&apos;s Recommendation states ten.
                Two — privacy, and human oversight — are covered as assessment areas rather than as
                principles, and one is renamed. The reasoning is recorded in ADR 0004 in the
                repository, so the difference is visible rather than implied.
              </p>
            </div>
          </details>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {/* Stage selector */}
          <div className="lifecycle-flow" id="lifecycle-flow">
            {Object.entries(stageLabels).map(([key, cfg], i) => (
              <div key={key} className="lifecycle-flow__segment">
                <button
                  className={`lifecycle-node ${activeStage === key ? 'lifecycle-node--active' : ''}`}
                  onClick={() => setActiveStage(activeStage === key ? null : key)}
                  style={{ '--node-color': cfg.color } as React.CSSProperties}
                  id={`lifecycle-node-${key}`}
                >
                  <span className="lifecycle-node__label">{cfg.label}</span>
                </button>
                {i < 2 && <div className="lifecycle-flow__arrow">→</div>}
              </div>
            ))}
          </div>

          {/* Area details */}
          {activeStage && (
            <div className="area-panel" id="area-panel">
              <div className="area-panel__header" style={{ borderColor: stageLabels[activeStage as keyof typeof stageLabels].color }}>
                <h2>
                  {stageLabels[activeStage as keyof typeof stageLabels].label}
                </h2>
              </div>

              <div className="area-panel__grid">
                {activeAreas.map((area) => (
                  <div key={area.id} className="area-card card" id={`area-card-${area.id}`}>
                    <div className="area-card__header">
                      <span className="area-card__id">{area.id}</span>
                      <Link href={`/about#principle-${principleSlugMap[area.principle] || 'fairness'}`} className="stage-indicator" style={{
                        backgroundColor: `${stageLabels[area.stage as keyof typeof stageLabels].color}15`,
                        color: stageLabels[area.stage as keyof typeof stageLabels].color,
                        textDecoration: 'none',
                      }}>
                        {area.principle}
                      </Link>
                    </div>
                    <h4 className="area-card__title">{area.name}</h4>
                    <p className="area-card__desc">{area.description}</p>
                    <div className="area-card__context">
                      <strong>Context:</strong> {area.context}
                    </div>
                    <div className="area-card__controls">
                      <span className="area-card__controls-label">Suggested fixes:</span>
                      {area.controls.map((cId: string) => {
                        const ctrl = controlsMap[cId];
                        if (!ctrl) return null;
                        return (
                          <Link key={cId} href={`/explore/controls#${cId}`} className={`badge badge--${ctrl.type === 'technical' ? 'moderate' : ctrl.type === 'procedural' ? 'low' : 'high'} badge--clickable`}>
                            {ctrl.name}
                          </Link>
                        );
                      })}
                    </div>
                    <ReferencesList references={area.references} />
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </section>
    </div>
  );
}
