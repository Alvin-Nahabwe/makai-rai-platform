import Link from 'next/link';
import { requireIdentity } from '@/lib/auth/identity';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { principleSlugMap, stageLabels } from '@/data/constants';
import ReferencesList from '@/components/report/ReferencesList';
import { STAGES, type Stage } from '@/types/record';
import type { ContentArea, LoadedContent } from '@/types/content';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { PageHeader } from '@/components/ui/PageHeader';
import { pageTitle } from '@/lib/ui/title';
import './FrameworkMapPage.css';

export const metadata = { title: pageTitle(GUIDANCE_COPY.titles.framework) };

/**
 * S-26, the framework for reference (FR-CNT-01; contract Screens row S-26). A server component: every stage, topic,
 * risk area and control of the running content is in the page's HTML before any script runs, and nothing waits for a
 * click (UX-36). Counts are read from the content (call R-62), and every text is a React child, so content is escaped.
 * The area cards keep their `area-card-<id>` anchors, which S-27 links to.
 */

interface ModuleRow { id: string; title: string; questions: number }

/** A stage's topics (the content's modules) in content order, each with the number of questions it holds. */
function modulesOf(c: LoadedContent, stage: Stage): ModuleRow[] {
  const rows = new Map<string, ModuleRow>();
  for (const q of questionsInStage(c, stage)) {
    const row = rows.get(q.moduleId) ?? { id: q.moduleId, title: q.moduleTitle, questions: 0 };
    row.questions += 1;
    rows.set(q.moduleId, row);
  }
  return [...rows.values()];
}

const F = GUIDANCE_COPY.framework;

function AreaCard({ area, c }: { area: ContentArea; c: LoadedContent }) {
  const slug: string | undefined = principleSlugMap[area.principle];
  const controls = (area.controls ?? []).flatMap((id) => {
    const control = c.controls.get(id);
    return control === undefined ? [] : [control];
  });
  return (
    <li className="area-card card" id={`area-card-${area.id}`}>
      <h4 className="area-card__title">
        <span className="area-card__id">{area.id}</span> {area.name}
      </h4>
      <p className="area-card__principle">
        {/* Each principle has its section on the About page (UX-03, FR-PUB-02); the slugs are its anchors. */}
        {slug === undefined ? F.principle(area.principle) : (
          <Link href={`/about#principle-${slug}`} className="area-card__principle-link">{F.principle(area.principle)}</Link>
        )}
      </p>
      <p className="area-card__desc">{area.description}</p>
      {area.context ? (
        <p className="area-card__context">
          <strong>{F.examples}</strong> {area.context}
        </p>
      ) : null}
      {controls.length > 0 ? (
        <>
          <p className="area-card__controls-label">{F.controls}</p>
          <ul className="area-card__controls">
            {controls.map((control) => (
              <li key={control.id}>
                <Link href={`/explore/controls#${control.id}`} className="area-card__control">{control.name}</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ReferencesList references={area.references} />
    </li>
  );
}

export default async function FrameworkPage() {
  // explore/layout.tsx gates a navigation into /explore, not one between its two pages (security review 0.7.0, L-1).
  await requireIdentity();
  const c = runningContent();
  const stages = STAGES.map((stage) => ({
    stage,
    modules: modulesOf(c, stage),
    areas: [...c.areas.values()].filter((a) => a.stage === stage),
  }));
  const moduleCount = stages.reduce((n, s) => n + s.modules.length, 0);
  const [p1, p2, p3, p4, p5] = F.scope.predictive;

  return (
    <div className="framework-page page-content" id="framework-map-page">
      <PageHeader
        title={F.heading}
        lead={(
          <>
            <p>{F.lead(STAGES.length, moduleCount)}</p>
            <p className="framework-page__counts">{F.counts(STAGES.length, moduleCount, c.areas.size, c.controls.size)}</p>
          </>
        )}
      />

      {/* What this framework does and does not cover (findings 13 and 14 of the 2026-08-18 content audit). It lives
          on the page, not in the content files: those are hashed into the content version, so a paragraph there
          would need a new version to change. The words are copy audit D's EX4 to EX8 (lib/guidance/copy.ts). */}
      <section className="framework-scope" id="framework-scope">
        <details>
          <summary>
            <strong>{F.scope.summary}</strong>
          </summary>
          <div className="framework-scope__body">
            <p>{p1}<strong>{p2}</strong>{p3}<strong>{p4}</strong>{p5}</p>
            <p>{F.scope.bias}</p>
            <p><strong>{F.scope.standards.label}</strong> {F.scope.standards.text}</p>
            <p><strong>{F.scope.principles.label}</strong> {F.scope.principles.text}</p>
          </div>
        </details>
      </section>

      {stages.map(({ stage, modules, areas }) => (
        <section key={stage} className="framework-stage" aria-labelledby={`stage-${stage}`}>
          <h2 id={`stage-${stage}`} className="framework-stage__title">{stageLabels[stage].label}</h2>
          <h3 className="framework-stage__subtitle">{F.topics}</h3>
          <ul className="framework-stage__modules">
            {modules.map((m) => (
              <li key={m.id}>{F.topicLine(m.title, m.questions)}</li>
            ))}
          </ul>
          <h3 className="framework-stage__subtitle">{F.riskAreas}</h3>
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
