import Link from 'next/link';
import { ControlCard } from '@/components/suggestions/ControlCard';
import { runningContent } from '@/lib/content/loader';
import { loadResources } from '@/lib/content/resources';
import './ControlsLibraryPage.css';

/**
 * S-27, the controls (FR-SUG-04 to 06, UX-13). A server component: every control of the running content, on the same
 * card as S-12 and S-15, is in the page's HTML before any script runs, with no filter state. A template or notebook
 * is linked only when `data/resources.json` says it passed review or was released (FR-SUG-05, FR-SUG-06). The wrapper
 * of each card carries the control's id, because S-26 and old links use `/explore/controls#C-01`.
 */
const TYPES = [
  { type: 'technical', label: 'Technical' },
  { type: 'procedural', label: 'Procedural' },
  { type: 'informational', label: 'Informational' },
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
        <h1>Controls</h1>
        <p className="controls-page__counts">{`${controls.length} controls`}</p>
      </header>
      {TYPES.map(({ type, label }) => {
        const ofType = controls.filter((k) => k.type === type);
        return (
          <section key={type} className="controls-page__section" aria-labelledby={`controls-${type}`}>
            <h2 id={`controls-${type}`}>{`${label} (${ofType.length})`}</h2>
            <div className="controls-page__grid">
              {ofType.map((k) => (
                <div key={k.id} id={k.id} className="controls-page__item">
                  <ControlCard control={k} resources={resources} headingLevel={3} />
                  <p className="controls-page__areas">
                    <span>Risk areas:</span>{' '}
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
