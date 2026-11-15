import Link from 'next/link';
import { readCreditLine } from '@/lib/credit';
import { ABOUT_COPY } from '@/lib/about/copy';
import { pageTitle } from '@/lib/ui/title';
import { readHelpEmail } from '@/lib/help/contact';
import { HELP_COPY } from '@/lib/help/copy';
import { SEAL_PROOF_HREF } from '@/components/review/reviewText';
import { Definition, Term } from '@/components/ui/Definition';
import { TERM_RISK_AREA, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import './AboutPage.css';

/**
 * S-28, the public About page. It says what the platform is and is not,
 * credits GIZ, and gives Help and contact. What a seal does and does not show
 * is on Help (plan 1A Task 12, ruling R10); this page links there.
 *
 * Each defined term (spec 6) is first used beside its definition: the stage names in the stage list, the four words of
 * what can follow a decision in their own list, and "risk areas" in the principles' lead (lane 6 B5).
 *
 * Section ids are linked from other pages and are part of the contract:
 * `credit`, `help-and-contact` and `principle-<slug>`.
 *
 * `data-claims-allowed` marks the few places that must name a score or a claim
 * word, so the phrase test (`__tests__/lint/no-product-claims.test.ts`) and the
 * crawls skip exactly those elements and nothing else on the page.
 */
export const metadata = { title: pageTitle(ABOUT_COPY.titles.about) };

type PrincipleSlug = Exclude<keyof typeof ABOUT_COPY.principles, 'heading' | 'lead' | 'areasLine' | 'asks' | 'areas' | 'sourceBefore' | 'sourceLink'>;

/** The titles and the risk areas are the content's (`data/constants.ts`); the words about each are the copy module's. */
const PRINCIPLES: Array<{ slug: PrincipleSlug; title: string; areas: Array<[code: string, name: string]> }> = [
  {
    slug: 'fairness',
    title: 'Fairness & Non-discrimination',
    areas: [
      ['PP-02', 'Data Scarcity & Availability Bias'],
      ['PP-03', 'Historical & Societal Bias'],
      ['PP-04', 'Population Bias'],
      ['PP-07', 'Labeling Bias'],
      ['IP-01', 'Algorithmic Discrimination'],
      ['IP-02', 'Aggregation Bias'],
    ],
  },
  {
    slug: 'proportionality',
    title: 'Proportionality & Do Not Harm',
    areas: [
      ['PP-01', 'Techno-solutionist Bias'],
      ['PP-05', 'Sampling & Generalization Bias'],
    ],
  },
  {
    slug: 'transparency',
    title: 'Transparency & Explainability',
    areas: [
      ['IP-03', 'Opacity & Unexplainability'],
      ['PO-07', 'Documentation Deficit'],
    ],
  },
  {
    slug: 'accountability',
    title: 'Reproducibility & Accountability',
    areas: [
      ['IP-04', 'Metric Selection Bias'],
      ['IP-06', 'Reproducibility Failure'],
      ['PO-01', 'Deployment Drift'],
      ['PO-03', 'Accountability Gap'],
    ],
  },
  {
    slug: 'safety',
    title: 'Safety & Security',
    areas: [
      ['PP-06', 'Privacy & Consent Violations'],
      ['IP-05', 'Model Robustness Failure'],
      ['IP-07', 'Data Integrity Compromise'],
    ],
  },
  {
    slug: 'awareness',
    title: 'Awareness & Literacy',
    areas: [
      ['PO-02', 'Lack of Human Oversight'],
      ['PO-04', 'User Literacy Deficit'],
    ],
  },
  {
    slug: 'collaboration',
    title: 'Multi-stakeholder Collaboration',
    areas: [['PO-06', 'Feedback Loop Absence']],
  },
  {
    slug: 'sustainability',
    title: 'Sustainability',
    areas: [['PO-05', 'Environmental Impact']],
  },
];

/** The stage names are the content's; the meaning beside each is the vocabulary's `Definition` (D1). */
const STAGES: ReadonlyArray<readonly [name: string, entry: DefinedEntry]> = [
  ['Pre-processing', TERM_STAGE_1],
  ['In-processing', TERM_STAGE_2],
  ['Post-processing', TERM_STAGE_3],
];

/** One line of a term list: the term as its first use on the page, then its definition (spec 6; the Members role list). */
function TermLine({ entry, label }: { entry: DefinedEntry; label: string }) {
  return (
    <li>
      <strong><Term of={entry}>{label}</Term>.</strong> <Definition of={entry} />
    </li>
  );
}

const capitalised = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`;

/** The awareness principle's first sentence names a model's "60% likely", so it alone sits in the marker. */
function PrincipleBody({ slug }: { slug: PrincipleSlug }) {
  const words = ABOUT_COPY.principles[slug];
  if ('marked' in words) {
    return (
      <p>
        <span data-claims-allowed="about-model-scores">{words.marked}</span> {words.body}
      </p>
    );
  }
  return <p>{words.body}</p>;
}

export default function AboutPage() {
  const credit = readCreditLine();
  const helpEmail = readHelpEmail();

  const { hero, whatItDoes, principles, credit: creditWords, help } = ABOUT_COPY;

  return (
    <div className="about-page" id="about-page">
      <header className="page-hero">
        <div className="container">
          <h1>{hero.heading}</h1>
          <p className="page-hero__desc">{hero.lead}</p>
        </div>
      </header>

      <div className="container container--narrow about-body">
        <section className="about-section" aria-labelledby="what-this-is">
          <h2 id="what-this-is">{whatItDoes.heading}</h2>
          <p>{whatItDoes.intro}</p>
          <ul className="about-stages">
            {STAGES.map(([name, entry]) => <TermLine key={entry.id} entry={entry} label={name} />)}
          </ul>
          <p>{whatItDoes.record}</p>
          <p>{whatItDoes.termsLead}</p>
          <ul className="about-stages">
            {whatItDoes.terms.map((entry) => <TermLine key={entry.id} entry={entry} label={capitalised(entry.term)} />)}
          </ul>
          <p>{whatItDoes.followUp}</p>
          <p data-claims-allowed="not-an-approval-service">{whatItDoes.notApproval}</p>
          <p>
            <Link href={SEAL_PROOF_HREF}>{HELP_COPY.sealing.heading}</Link>
          </p>
          <h3>{whatItDoes.whoCanSee.heading}</h3>
          <p>{whatItDoes.whoCanSee.text}</p>
        </section>

        <section
          className="about-principles"
          id="principles-section"
          aria-labelledby="principles-heading"
        >
          <h2 id="principles-heading">{principles.heading}</h2>
          <p className="about-lead">
            {principles.lead} {principles.areasLine[0]}<Term of={TERM_RISK_AREA}>{principles.areasLine[1]}</Term>{principles.areasLine[2]}{' '}
            <Definition of={TERM_RISK_AREA} />
          </p>

          <div className="stage-details">
            {PRINCIPLES.map((p) => (
              <div key={p.slug} className="stage-detail" id={`principle-${p.slug}`}>
                <div className="stage-detail__header">
                  <div>
                    <h3>{p.title}</h3>
                    <p className="stage-detail__summary">{principles[p.slug].summary}</p>
                  </div>
                </div>
                <div className="stage-detail__body">
                  <div className="stage-detail__areas">
                    <PrincipleBody slug={p.slug} />
                    <h4>{principles.asks}</h4>
                    <p>{principles[p.slug].checks}</p>
                  </div>
                  <div className="stage-detail__assessment">
                    <h4>{principles.areas}</h4>
                    <ul>
                      {p.areas.map(([code, name]) => (
                        <li key={code}>
                          <Link href={`/explore/framework#area-card-${code}`}>
                            {code} {name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="about-note about-note--centered">
            {principles.sourceBefore}{' '}
            <a
              href="https://www.unesco.org/en/artificial-intelligence/recommendation-ethics"
              rel="noopener noreferrer"
            >
              {principles.sourceLink}
            </a>
            .
          </p>
        </section>

        <section className="about-section" aria-labelledby="credit">
          <h2 id="credit">{creditWords.heading}</h2>
          <p>{credit.text}</p>
          <p>
            <a href={credit.href} rel="noopener noreferrer">
              {creditWords.licenceLink(credit.licence)}
            </a>
          </p>
        </section>

        <section className="about-section" aria-labelledby="help-and-contact">
          <h2 id="help-and-contact">{help.heading}</h2>
          {helpEmail === null ? (
            <p>{help.pending}</p>
          ) : (
            <p>
              {help.writeTo} <a href={`mailto:${helpEmail}`}>{helpEmail}</a>.
            </p>
          )}
          <p>{help.reference}</p>
          <p>{help.noRecords}</p>
        </section>
      </div>
    </div>
  );
}
