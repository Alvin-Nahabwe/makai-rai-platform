import Link from 'next/link';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { principleSlugMap, stageLabels } from '@/data/constants';
import ReferencesList from '@/components/report/ReferencesList';
import { STAGES, type Stage } from '@/types/record';
import type { ContentArea, LoadedContent } from '@/types/content';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { PageHeader } from '@/components/ui/PageHeader';
import { Definition, Term } from '@/components/ui/Definition';
import { TermLine } from '@/components/review/TermList';
import { TERM_CONTROL, TERM_MODEL_CARD, TERM_RISK_AREA, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { pageTitle } from '@/lib/ui/title';
import './FrameworkMapPage.css';

export const metadata = { title: pageTitle(GUIDANCE_COPY.titles.framework) };

/**
 * S-26, the framework for reference (FR-CNT-01; contract Screens row S-26). A server component: every stage, topic,
 * risk area and control of the running content is in the page's HTML before any script runs, and nothing waits for a
 * click (UX-36). Counts are read from the content (call R-62), and every text is a React child, so content is escaped.
 * The area cards keep their `area-card-<id>` anchors, which S-27 links to.
 *
 * Each defined term is first used beside its definition (spec 6; lane 6 B5): "risk area" and "control" in the lead, each
 * stage name in its heading (D1), and "model card" in the first content text that says it. Area and control names are
 * not uses (ruling X-1 (3)).
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

/** Each stage's vocabulary entry: its heading is the stage name's first use on the page (D1). */
const STAGE_TERMS: Readonly<Record<Stage, DefinedEntry>> = { 'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3 };

/** Where a term is in a text, as the first-use rule reads it (lib/vocabulary/firstUse.ts): whole words, an optional plural `s`. */
function termIn(text: string, entry: DefinedEntry): { start: number; end: number } | null {
  const words = entry.term.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${words}s?(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return m === null ? null : { start: m.index, end: m.index + m[0].length };
}

/** A content text with its first use of `entry` marked as the term (the caller places the `Definition`). */
function WithTerm({ text, entry }: { text: string; entry: DefinedEntry }) {
  const at = termIn(text, entry);
  if (at === null) return <>{text}</>;
  return <>{text.slice(0, at.start)}<Term of={entry}>{text.slice(at.start, at.end)}</Term>{text.slice(at.end)}</>;
}

/**
 * "model card" first appears on this page inside the content's own words (an area's description or examples); the page
 * marks it in the first one, in page order. Only this term: the content uses everyday words (such as "not yet") that are
 * defined terms in another sense, which a general search would mark wrongly (ruling X-1 (1)).
 */
type ModelCardUse = { areaId: string; field: 'description' | 'context' } | null;

function firstModelCardUse(areasInOrder: readonly ContentArea[]): ModelCardUse {
  for (const a of areasInOrder) {
    if (termIn(a.description, TERM_MODEL_CARD)) return { areaId: a.id, field: 'description' };
    if (a.context && termIn(a.context, TERM_MODEL_CARD)) return { areaId: a.id, field: 'context' };
  }
  return null;
}

function AreaCard({ area, c, defineModelCard = null }: { area: ContentArea; c: LoadedContent; defineModelCard?: 'description' | 'context' | null }) {
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
      <p className="area-card__desc">
        {defineModelCard === 'description' ? <WithTerm text={area.description} entry={TERM_MODEL_CARD} /> : area.description}
      </p>
      {defineModelCard === 'description' ? <TermLine of={TERM_MODEL_CARD} /> : null}
      {area.context ? (
        <p className="area-card__context">
          <strong>{F.examples}</strong> {defineModelCard === 'context' ? <WithTerm text={area.context} entry={TERM_MODEL_CARD} /> : area.context}
        </p>
      ) : null}
      {area.context && defineModelCard === 'context' ? <TermLine of={TERM_MODEL_CARD} /> : null}
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

export default function FrameworkPage() {
  const c = runningContent();
  const stages = STAGES.map((stage) => ({
    stage,
    modules: modulesOf(c, stage),
    areas: [...c.areas.values()].filter((a) => a.stage === stage),
  }));
  const moduleCount = stages.reduce((n, s) => n + s.modules.length, 0);
  const [p1, p2, p3, p4, p5] = F.scope.predictive;
  const modelCard = firstModelCardUse(stages.flatMap((s) => s.areas));

  return (
    <div className="framework-page page-content" id="framework-map-page">
      <PageHeader
        title={F.heading}
        lead={(
          <>
            {/* Each definition on its own line, the element after its sentence (FX4, DF I4). */}
            <p>{F.lead(STAGES.length, moduleCount)} {F.areasLine[0]}<Term of={TERM_RISK_AREA}>{F.areasLine[1]}</Term>{F.areasLine[2]}</p>
            <Definition of={TERM_RISK_AREA} as="p" />
            <p>{F.controlsLine[0]}<Term of={TERM_CONTROL}>{F.controlsLine[1]}</Term>{F.controlsLine[2]}</p>
            <Definition of={TERM_CONTROL} as="p" />
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
          <h2 id={`stage-${stage}`} className="framework-stage__title"><Term of={STAGE_TERMS[stage]}>{stageLabels[stage].label}</Term></h2>
          <Definition of={STAGE_TERMS[stage]} as="p" />
          <h3 className="framework-stage__subtitle">{F.topics}</h3>
          <ul className="framework-stage__modules">
            {modules.map((m) => (
              <li key={m.id}>{F.topicLine(m.title, m.questions)}</li>
            ))}
          </ul>
          <h3 className="framework-stage__subtitle">{F.riskAreas}</h3>
          <ul className="framework-stage__areas">
            {areas.map((area) => (
              <AreaCard key={area.id} area={area} c={c} defineModelCard={modelCard?.areaId === area.id ? modelCard.field : null} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
