import Link from 'next/link';
import { ControlCard } from '@/components/suggestions/ControlCard';
import { Definition, Term } from '@/components/ui/Definition';
import { runningContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { pageTitle } from '@/lib/ui/title';
import { TERM_CONTROL, TERM_MITIGATION, TERM_RISK_AREA } from '@/lib/vocabulary/terms';
import './ControlsLibraryPage.css';

export const metadata = { title: pageTitle(GUIDANCE_COPY.titles.controls) };

/**
 * S-27, the controls (FR-SUG-04 to 06, UX-13). A server component: every control of the running content, on the same
 * card as S-12 and S-15, is in the page's HTML before any script runs, with no filter state. A template or notebook
 * is linked only when `data/resources.json` says it passed review or was released (FR-SUG-05, FR-SUG-06). The wrapper
 * of each card carries the control's id, because S-26 and old links use `/explore/controls#C-01`. The header holds the
 * page's first use of "control" (the h1), "mitigation" and "risk area", each beside its definition (spec 6; lane 6 B5).
 */
const C = GUIDANCE_COPY.controls;
const TYPES = [
  { type: 'technical', ...C.types.technical },
  { type: 'procedural', ...C.types.procedural },
  { type: 'informational', ...C.types.informational },
] as const;

export default function ControlsPage() {
  const c = runningContent();
  const resources = loadResources();
  const controls = [...c.controls.values()];
  const unknown = controls.find((k) => !TYPES.some((t) => t.type === k.type));
  // A type this page has no section for would drop the control from the page without a word.
  if (unknown) throw new Error(`control ${unknown.id} has type ${unknown.type}, which S-27 has no section for`);
  const areasOf = (controlId: string) => [...c.areas.values()].filter((a) => a.controls?.includes(controlId));

  return (
    <div className="controls-page page-content" id="controls-library-page">
      <header className="controls-page__header">
        <h1><Term of={TERM_CONTROL}>{GUIDANCE_COPY.titles.controls}</Term></h1>
        <Definition of={TERM_CONTROL} as="p" />
        <p className="controls-page__intro">
          {C.introLine[0]}<Term of={TERM_MITIGATION}>{C.introLine[1]}</Term>{C.introLine[2]} <Definition of={TERM_MITIGATION} />
        </p>
        <p className="controls-page__intro">
          {C.areasLine[0]}<Term of={TERM_RISK_AREA}>{C.areasLine[1]}</Term>{C.areasLine[2]} <Definition of={TERM_RISK_AREA} />
        </p>
        <p className="controls-page__counts">{C.count(controls.length)}</p>
      </header>
      {TYPES.map(({ type, label, line }) => {
        const ofType = controls.filter((k) => k.type === type);
        return (
          <section key={type} className="controls-page__section" aria-labelledby={`controls-${type}`}>
            <h2 id={`controls-${type}`}>{C.section(label, ofType.length)}</h2>
            <p className="controls-page__type-line">{line}</p>
            <div className="controls-page__grid">
              {ofType.map((k) => (
                <div key={k.id} id={k.id} className="controls-page__item">
                  <ControlCard control={k} resources={resources} headingLevel={3} />
                  <p className="controls-page__areas">
                    <span>{C.riskAreas}</span>{' '}
                    {areasOf(k.id).map((a, i) => (
                      <span key={a.id}>
                        {i > 0 ? ', ' : ''}
                        <Link href={`/explore/framework#area-card-${a.id}`}><span>{a.id}</span> {a.name}</Link>
                      </span>
                    ))}
                  </p>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
