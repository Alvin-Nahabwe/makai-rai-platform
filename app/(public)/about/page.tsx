import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { readCreditLine } from '@/lib/credit';
import './AboutPage.css';

/**
 * S-28, the public About page. It says what the platform is and is not, why
 * there is no score, what it never does, and what a seal does and does not
 * prove, credits GIZ, and gives Help and contact.
 *
 * Section ids are linked from other pages and are part of the contract:
 * `why-no-score`, `never-runs`, `what-a-seal-proves`, `credit`,
 * `free-toolkits`, `help-and-contact` and `principle-<slug>`.
 *
 * `data-claims-allowed` marks the few places that must name a score, so the
 * phrase test (`__tests__/lint/no-product-claims.test.ts`) and the crawls skip
 * exactly those elements and nothing else on the page. In "Why there is no
 * score" it marks the heading and the explanation; the paragraph about what a
 * team gets instead is checked like any other text.
 */
export const metadata = { title: 'About - MAK-AI RAI Platform' };

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

/**
 * The Help and contact address, from `data/help-contact.json`: `{ "email": string | null }`.
 * It is null until the owner names the monitored address (13.8 step 4d), and only an
 * explicit null shows the pending sentence. A missing key, an extra key, a value that is
 * not an address, or a file that is not JSON stops the build: a wrong or absent address
 * must not pass for the placeholder. The literal `data` prefix keeps the build's file
 * tracing static.
 */
const HELP_FILE = 'data/help-contact.json';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readHelpEmail(): string | null {
  const text = readFileSync(join(process.cwd(), 'data', 'help-contact.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${HELP_FILE}: not valid JSON`, { cause });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${HELP_FILE}: expected an object with one key, "email"`);
  }
  if (Object.keys(raw).join() !== 'email') {
    throw new Error(`${HELP_FILE}: the only key allowed is "email"`);
  }
  const email: unknown = (raw as { email: unknown }).email;
  if (email === null) return null;
  if (typeof email !== 'string' || !EMAIL_SHAPE.test(email) || /^mailto:/i.test(email)) {
    throw new Error(`${HELP_FILE}: "email" must be an address such as name@host.tld, or null`);
  }
  return email;
}

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
          <span className="about-eyebrow">About the platform</span>
          <h1>About the MAK-AI RAI Platform</h1>
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
            The MAK-AI RAI Platform helps a team keep one honest record of how it handled
            responsible AI questions for one AI system. The questions follow three stages of AI
            development.
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
            team seals it, and the platform builds documents from the sealed record.
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
        </section>

        <section className="about-section" aria-labelledby="why-no-score">
          <h2 id="why-no-score" data-claims-allowed="why-no-score">Why there is no score</h2>
          <p>
            Earlier versions of this tool turned a team&apos;s answers into a number and a label.
            We removed both. The labels were never checked against what actually happened in real
            projects. When the rules were tested on 5,000 simulated sets of answers, moving the
            dividing lines by half of one answer step, as happened between two versions of this
            tool, changed the label for 43 to 48 of every 100 identical sets of answers. A number
            that moves when nothing about your practice moves tells you nothing true about your
            practice, and it invites work on the number instead of the practice.
          </p>
          <p>
            What you get instead: for every question, a record of what your team decided, why, who
            decided and when, with evidence; a finding for every shortfall, closed by a mitigation
            or an accepted risk; and documents built from that record, each stored with a
            fingerprint so your team can show exactly what it issued. Counts of decisions,
            findings and mitigations are shown as whole numbers for each stage, such as 12
            questions with a decision or 3 open findings. They are never added into one total.
          </p>
        </section>

        <section className="about-section" aria-labelledby="never-runs">
          <h2 id="never-runs">What this platform never does</h2>
          <p>
            The platform never runs evaluations, models, notebooks or uploaded files. It never
            computes metrics from your team&apos;s data.
          </p>
          <p>
            When you attach evidence, the platform stores the file, reads only its first few bytes
            to see what kind of file it is, and calculates its fingerprint. It does not open or
            run what is inside. The platform records what your team says. It does not decide
            whether it is true.
          </p>
        </section>

        <section className="about-section" aria-labelledby="what-a-seal-proves">
          <h2 id="what-a-seal-proves">What a seal proves, and what it does not</h2>
          <p>
            A seal fixes the content of one stage review at one moment. It proves that the
            platform, at the sealed time, recorded exactly these decision versions and these
            evidence file fingerprints for that stage, and that none of them has changed since,
            unless the platform reports an erasure.
          </p>
          <p>
            It does not prove that your team made each decision on the date it declared, that the
            evidence supports the decision, or that nobody with control of the database and the
            server could rewrite both the record and the stored seal. The platform holds the
            fingerprints itself, and there is no outside timestamp.
          </p>
          <p>
            <strong>Sealed by the platform; not independently time-stamped.</strong>
          </p>
          <p className="about-note">Technical note: each fingerprint is a SHA-256 hash.</p>
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

        <section className="about-section" aria-labelledby="free-toolkits">
          <h2 id="free-toolkits">Free toolkits</h2>
          <p>
            Each control on the controls page links to free guidance and, where one applies, a
            free tool. The platform does not run any of them.
          </p>
          <p>
            <Link href="/explore/controls">Open the controls page</Link>
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
