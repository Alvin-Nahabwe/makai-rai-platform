import type { ReactNode } from 'react';
import Link from 'next/link';
import { readCreditLine } from '@/lib/credit';
import { ABOUT_COPY } from '@/lib/about/copy';
import { PRODUCT_NAME, pageTitle } from '@/lib/ui/title';
import { readHelpEmail } from '@/lib/help/contact';
import { HELP_COPY } from '@/lib/help/copy';
import { SEAL_PROOF_HREF } from '@/components/review/reviewText';
import './AboutPage.css';

/**
 * S-28, the public About page. It says what the platform is and is not,
 * credits GIZ, and gives Help and contact. What a seal does and does not show
 * is on Help (plan 1A Task 12, ruling R10); this page links there.
 *
 * Section ids are linked from other pages and are part of the contract:
 * `credit`, `help-and-contact` and `principle-<slug>`.
 *
 * `data-claims-allowed` marks the few places that must name a score or a claim
 * word, so the phrase test (`__tests__/lint/no-product-claims.test.ts`) and the
 * crawls skip exactly those elements and nothing else on the page.
 */
export const metadata = { title: pageTitle(ABOUT_COPY.titles.about) };

type Principle = {
  slug: string;
  color: string;
  title: string;
  summary: string;
  body: ReactNode;
  checks: string;
  areas: Array<[code: string, name: string]>;
};

const PRINCIPLES: Principle[] = [
  {
    slug: 'fairness',
    color: '#C06014',
    title: 'Fairness & Non-discrimination',
    summary:
      'AI systems should not systematically disadvantage people based on characteristics like race, gender, age, disability, or socioeconomic status.',
    body: (
      <>
        Bias enters through training data that underrepresents certain groups, through labels that
        encode historical discrimination, and through model architectures that optimize for
        aggregate accuracy while masking poor performance on minorities.{' '}
        <span data-claims-allowed="about-model-scores">
          A healthcare algorithm that works well on average but works poorly for Black patients produces
          real harm, regardless of its overall accuracy score.
        </span>{' '}
        Fairness requires active measurement: disaggregating performance by subgroup, testing for
        disparate impact, and choosing evaluation metrics that surface inequality rather than hide
        it.
      </>
    ),
    checks:
      'Data representativeness relative to the target population. Historical bias identification. Disaggregated model performance across protected groups. Labeling consistency and annotator agreement.',
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
    color: '#8B4513',
    title: 'Proportionality & Do Not Harm',
    summary:
      'AI should only be used when it is the most appropriate solution, and should not cause more harm than the problem it solves.',
    body: (
      <>
        When a rule-based system, a spreadsheet, or a human process would produce comparable
        results, complex ML introduces unnecessary cost, opacity, and potential for harm with no
        added benefit. Proportionality means matching the tool to the problem and being honest
        about whether AI was chosen because it is the best approach or because it is the most
        novel one. A facial recognition system deployed in schools may be technically feasible, but
        the surveillance harms to children can far exceed the security benefits it provides.
      </>
    ),
    checks:
      'Alternatives analysis before choosing AI. Cost-benefit evaluation that accounts for harms to affected populations. Sampling methodology that supports the claims being made.',
    areas: [
      ['PP-01', 'Techno-solutionist Bias'],
      ['PP-05', 'Sampling & Generalization Bias'],
    ],
  },
  {
    slug: 'transparency',
    color: '#A0522D',
    title: 'Transparency & Explainability',
    summary: 'People affected by AI decisions should be able to understand why those decisions were made.',
    body: (
      <>
        When an AI system denies someone a loan, flags them for additional scrutiny, or filters
        their job application, the affected person deserves to know why. Transparency goes beyond
        publishing model architecture details. It means providing meaningful explanations to the
        people who bear the consequences of automated decisions. It also extends to data
        collection: if personal data was gathered without informing the subjects, or if a deployed
        system has no documentation of how it works, transparency has already been lost before any
        prediction is made.
      </>
    ),
    checks:
      'Data collection transparency and consent practices. Explainability of model decisions to affected individuals. System documentation that regulators and successors can follow.',
    areas: [
      ['IP-03', 'Opacity & Unexplainability'],
      ['PO-07', 'Documentation Deficit'],
    ],
  },
  {
    slug: 'accountability',
    color: '#C06014',
    title: 'Reproducibility & Accountability',
    summary: 'Results should be reproducible, and someone should be accountable when things go wrong.',
    body: (
      <>
        If you cannot reproduce an AI system&apos;s results, you cannot check them. If you cannot
        check them, you cannot hold anyone accountable when it goes wrong. Reproducibility requires
        documented code, versioned data, recorded hyperparameters, and fixed random seeds.
        Accountability requires clear ownership of system outputs, defined escalation paths when
        errors occur, and governance frameworks that survive personnel changes. Without both,
        harmful AI decisions happen in a vacuum: the model made the decision, no one owns the
        outcome, and no one can determine what went wrong.
      </>
    ),
    checks:
      'Evaluation metric appropriateness for the use case. Experiment documentation and reproducibility. Post-deployment performance monitoring. Governance structures assigning responsibility for system outcomes.',
    areas: [
      ['IP-04', 'Metric Selection Bias'],
      ['IP-06', 'Reproducibility Failure'],
      ['PO-01', 'Deployment Drift'],
      ['PO-03', 'Accountability Gap'],
    ],
  },
  {
    slug: 'safety',
    color: '#8B4513',
    title: 'Safety & Security',
    summary: 'Systems should handle unexpected inputs gracefully and protect data from corruption or misuse.',
    body: (
      <>
        A model trained on clean, curated data will face noisy, incomplete, and adversarial inputs
        in production. A data pipeline that works correctly in development can silently corrupt
        records during ETL. Safety means the system degrades gracefully rather than
        catastrophically when conditions change. Security means protecting the data pipeline from
        corruption, unauthorized modification, or quality degradation. In healthcare or criminal
        justice, a robustness problem causes direct harm to real people.
      </>
    ),
    checks:
      'Stress testing against realistic distribution shifts. Data pipeline integrity checks and validation. Mechanisms for detecting and responding to data quality issues.',
    areas: [
      ['PP-06', 'Privacy & Consent Violations'],
      ['IP-05', 'Model Robustness Failure'],
      ['IP-07', 'Data Integrity Compromise'],
    ],
  },
  {
    slug: 'awareness',
    color: '#A0522D',
    title: 'Awareness & Literacy',
    summary:
      'People who use or are affected by AI systems need to understand what those systems can and cannot do.',
    body: (
      <>
        <span data-claims-allowed="about-model-scores">
          A clinician who treats a model&apos;s 60% confidence score as certainty will make worse
          decisions than one who understands the margin of error.
        </span>{' '}
        A loan officer who does not realize they can override an algorithmic recommendation becomes
        a rubber stamp for the model&apos;s biases. AI literacy means giving end-users enough
        understanding to know when to trust the system, when to question it, and how to escalate
        when something looks wrong. Oversight mechanisms are only as strong as the people operating
        them.
      </>
    ),
    checks:
      'Human oversight mechanisms for AI-driven decisions. End-user training on system outputs, confidence levels, and system limitations.',
    areas: [
      ['PO-02', 'Lack of Human Oversight'],
      ['PO-04', 'User Literacy Deficit'],
    ],
  },
  {
    slug: 'collaboration',
    color: '#C06014',
    title: 'Multi-stakeholder Collaboration',
    summary: 'The people affected by an AI system should have a say in how it is built and used.',
    body: (
      <>
        AI systems built without input from the communities they affect tend to miss local
        context, overlook harm, and lack mechanisms for redress. A crop disease
        detection model deployed without consulting local farmers may misclassify regional crop
        varieties. A content moderation system without an appeal mechanism has no way to correct
        its mistakes. Feedback loops are how you discover that your system is going wrong in ways your
        test data never showed.
      </>
    ),
    checks:
      'Mechanisms for affected communities and end-users to provide feedback, contest automated decisions, and report system issues.',
    areas: [['PO-06', 'Feedback Loop Absence']],
  },
  {
    slug: 'sustainability',
    color: '#8B4513',
    title: 'Sustainability',
    summary: 'The energy and environmental costs of AI should be proportionate to its benefits.',
    body: (
      <>
        Training a single large language model can emit as much carbon as five cars over their
        entire lifetimes. Running inference at scale compounds this. A model that reduces hospital
        readmissions may justify significant compute. A marginally better recommendation engine may
        not. This principle asks teams to measure and report the energy footprint of their AI
        systems and to consider whether more efficient architectures or training methods could
        achieve comparable results at lower cost.
      </>
    ),
    checks:
      'Environmental impact assessment for model training and deployment. Consideration of efficient architectures and green computing practices.',
    areas: [['PO-05', 'Environmental Impact']],
  },
];

const STAGES: Array<[name: string, summary: string]> = [
  ['Pre-processing', 'Most responsible AI considerations begin before any model is trained.'],
  ['In-processing', 'Considerations that arise during model training, evaluation, and selection.'],
  [
    'Post-processing',
    'What happens after the model is deployed: monitoring, governance, and community engagement.',
  ],
];

export default function AboutPage() {
  const credit = readCreditLine();
  const helpEmail = readHelpEmail();

  return (
    <div className="about-page" id="about-page">
      <header className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <h1>{`About the ${PRODUCT_NAME}`}</h1>
          <p className="page-hero__desc">
            A place for a team to record what it decided about its AI system, why it decided it,
            and the evidence behind the decision.
          </p>
        </div>
      </header>

      <div className="container container--narrow about-body">
        <section className="about-section" aria-labelledby="what-this-is">
          <h2 id="what-this-is">What this platform is and is not</h2>
          <p>
            {`The ${PRODUCT_NAME} helps a team keep one honest record of how it handled responsible AI questions for one AI system. The questions follow three stages of AI development.`}
          </p>
          <ul className="about-stages">
            {STAGES.map(([name, summary]) => (
              <li key={name}>
                <strong>{name}.</strong> {summary}
              </li>
            ))}
          </ul>
          <p>
            For each question, your team records a decision, the reason for it, who decided and
            when, and any evidence. The team decides; the platform records. Where a decision falls
            short of the expected practice, the platform raises a finding. Your team closes a
            finding with a mitigation or by accepting the risk. When a stage review is ready, your
            team seals it, and the platform builds documents from the sealed record. The platform
            does not test your model or calculate anything from your data.
          </p>
          <p data-claims-allowed="not-an-approval-service">
            It is not an approval, audit, certification or compliance service, and nothing it
            produces is one.
          </p>
          <h3>Who can see your records</h3>
          <p>
            Only members of your organisation can see its records, according to their role.
            MAK-AI&apos;s administrator has no access to records in the application, and the
            operator who runs the server has technical access to the database.
          </p>
          <p>
            <Link href={SEAL_PROOF_HREF}>{HELP_COPY.sealing.heading}</Link>
          </p>
        </section>

        <section
          className="about-principles"
          id="principles-section"
          aria-labelledby="principles-heading"
        >
          <h2 id="principles-heading">Eight responsible AI principles</h2>
          <p className="about-lead">
            Every question in the framework maps back to one of these eight principles.
          </p>

          <div className="stage-details">
            {PRINCIPLES.map((p) => (
              <div
                key={p.slug}
                className="stage-detail"
                id={`principle-${p.slug}`}
                style={{ '--stage-color': p.color } as React.CSSProperties}
              >
                <div className="stage-detail__header">
                  <div>
                    <h3>{p.title}</h3>
                    <p className="stage-detail__summary">{p.summary}</p>
                  </div>
                </div>
                <div className="stage-detail__body">
                  <div className="stage-detail__areas">
                    <p>{p.body}</p>
                    <h4>What the platform asks about</h4>
                    <p>{p.checks}</p>
                  </div>
                  <div className="stage-detail__assessment">
                    <h4>Linked assessment areas</h4>
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
            These principles are drawn from the{' '}
            <a
              href="https://www.unesco.org/en/artificial-intelligence/recommendation-ethics"
              rel="noopener noreferrer"
            >
              UNESCO Recommendation on the Ethics of Artificial Intelligence
            </a>
            .
          </p>
        </section>

        <section className="about-section" aria-labelledby="credit">
          <h2 id="credit">Credit</h2>
          <p>{credit.text}</p>
          <p>
            <a href={credit.href} rel="noopener noreferrer">
              Read the {credit.licence} licence
            </a>
          </p>
        </section>

        <section className="about-section" aria-labelledby="help-and-contact">
          <h2 id="help-and-contact">Help and contact</h2>
          {helpEmail === null ? (
            <p>The Help and contact address is published before the platform opens to teams.</p>
          ) : (
            <p>
              Write to <a href={`mailto:${helpEmail}`}>{helpEmail}</a>.
            </p>
          )}
          <p>
            Tell us what you were doing and which page you were on. If an error page appeared,
            give the support reference shown on it. The reference lets us find what happened
            without screenshots of your records.
          </p>
          <p>Never send record text by email. That means decisions, findings, evidence names and file contents.</p>
        </section>
      </div>
    </div>
  );
}
