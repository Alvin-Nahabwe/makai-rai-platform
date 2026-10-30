import Link from 'next/link';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { stageLabels } from '@/data/constants';
import ReferencesList from '@/components/report/ReferencesList';
import { STAGES, type Stage } from '@/types/record';
import type { ContentArea, LoadedContent } from '@/types/content';
import './FrameworkMapPage.css';

/**
 * S-26, the framework for reference (FR-CNT-01; contract Screens row S-26). A server component: every stage, module,
 * risk area and control of the running content is in the page's HTML before any script runs, and nothing waits for a
 * click (UX-36). Counts are read from the content (call R-62), and every text is a React child, so content is escaped.
 * The area cards keep their `area-card-<id>` anchors, which S-27 links to.
 */

interface ModuleRow { id: string; title: string; questions: number }

/** A stage's modules in content order, each with the number of questions it holds. */
function modulesOf(c: LoadedContent, stage: Stage): ModuleRow[] {
  const rows = new Map<string, ModuleRow>();
  for (const q of questionsInStage(c, stage)) {
    const row = rows.get(q.moduleId) ?? { id: q.moduleId, title: q.moduleTitle, questions: 0 };
    row.questions += 1;
    rows.set(q.moduleId, row);
  }
  return [...rows.values()];
}

function AreaCard({ area, c }: { area: ContentArea; c: LoadedContent }) {
  const controls = (area.controls ?? []).flatMap((id) => {
    const control = c.controls.get(id);
    return control === undefined ? [] : [control];
  });
  return (
    <li className="area-card card" id={`area-card-${area.id}`}>
      <h4 className="area-card__title">
        <span className="area-card__id">{area.id}</span> {area.name}
      </h4>
      <p className="area-card__principle">{`Principle: ${area.principle}`}</p>
      <p className="area-card__desc">{area.description}</p>
      {area.context ? (
        <p className="area-card__context">
          <strong>Context:</strong> {area.context}
        </p>
      ) : null}
      {controls.length > 0 ? (
        <>
          <p className="area-card__controls-label">Controls</p>
          <ul className="area-card__controls">
            {controls.map((control) => (
              <li key={control.id}>
                <Link href={`/explore/controls#${control.id}`} className="area-card__control">{control.name}</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ReferencesList references={area.references ? [...area.references] : undefined} />
    </li>
  );
}

export default function FrameworkPage() {
  const c = runningContent();
  const stages = STAGES.map((stage) => ({
    stage,
    modules: modulesOf(c, stage),
    areas: [...c.areas.values()].filter((a) => a.stage === stage),
  }));
  const moduleCount = stages.reduce((n, s) => n + s.modules.length, 0);

  return (
    <div className="framework-page page-content" id="framework-map-page">
      <header className="framework-page__header">
        <h1>Framework</h1>
        <p className="framework-page__counts">
          {`${STAGES.length} stages, ${moduleCount} modules, ${c.areas.size} risk areas, ${c.controls.size} controls`}
        </p>
      </header>

      {/* What this framework does and does not cover (findings 13 and 14 of the 2026-08-18 content audit). It lives
          on the page, not in the content files: those are hashed into the content version, so a paragraph there
          would need a new version to change. The wording is PUB's (FR-PUB-01). */}
      <section className="framework-scope" id="framework-scope">
        <details>
          <summary>
            <strong>What this framework covers, and what it does not</strong>
          </summary>
          <div className="framework-scope__body">
            <p>
              These 21 areas were written for <strong>predictive machine-learning systems</strong>
              {' '}(models that classify, rank, or estimate). Generative systems raise questions this
              framework does not yet ask, so a low-risk result here says nothing about a
              generative deployment.
            </p>
            <p>
              The bias it assesses is <strong>statistical and dataset bias</strong>: who is in the
              data, how labels were produced, how error is distributed across groups. It does not
              assess <strong>institutional bias</strong>, who chose the problem, who benefits from
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
              Two, privacy and human oversight, are covered as assessment areas rather than as
              principles, and one is renamed. The reasoning is recorded in ADR 0004 in the
              repository, so the difference is visible rather than implied.
            </p>
          </div>
        </details>
      </section>

      {stages.map(({ stage, modules, areas }) => (
        <section key={stage} className="framework-stage" aria-labelledby={`stage-${stage}`}>
          <h2 id={`stage-${stage}`} className="framework-stage__title">{stageLabels[stage].label}</h2>
          <h3 className="framework-stage__subtitle">Modules</h3>
          <ul className="framework-stage__modules">
            {modules.map((m) => (
              <li key={m.id}>{`${m.title}, ${m.questions} questions`}</li>
            ))}
          </ul>
          <h3 className="framework-stage__subtitle">Risk areas</h3>
          <ul className="framework-stage__areas">
            {areas.map((area) => (
              <AreaCard key={area.id} area={area} c={c} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
