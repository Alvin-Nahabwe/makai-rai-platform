'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import projectConfig from '@/data/projectConfig.json';
import './AboutPage.css';

export default function AboutPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Handle hash-based scrolling (e.g. /about#principles-section from Framework Map)
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash) {
        setTimeout(() => {
          const el = document.getElementById(hash);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    };

    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [pathname, searchParams]);

  const stages = [
    {
      icon: null,
      title: 'Pre-processing',
      color: '#C06014',
      desc: 'Most responsible AI considerations begin before any model is trained.',
      areas: [
        { name: 'Problem Formulation', desc: 'Defining the problem, assessing whether AI is the most proportionate solution, and identifying affected stakeholders.' },
        { name: 'Data Collection', desc: 'Collecting data ethically with proper consent, representing the target population, and documenting provenance.' },
        { name: 'Data Preparation', desc: 'Auditing data quality, identifying biases, checking representativeness across subgroups, and applying anonymization.' },
      ],
      assessmentFocus: [
        'Alternatives analysis',
        'Stakeholder identification and impact mapping',
        'Data representativeness and demographic balance',
        'Privacy, consent, and anonymization protocols',
        'Labeling quality and consistency',
        'Identification of historical and sampling biases',
      ],
    },
    {
      icon: null,
      title: 'In-processing',
      color: '#8B4513',
      desc: 'Considerations that arise during model training, evaluation, and selection.',
      areas: [
        { name: 'Model Selection & Training', desc: 'Choosing appropriate architectures, justifying complexity, and applying the parsimony principle.' },
        { name: 'Fairness Evaluation', desc: 'Computing subgroup performance metrics and fairness measures to detect algorithmic discrimination.' },
        { name: 'Explainability & Robustness', desc: 'Using interpretability methods to understand model decisions, and stress-testing robustness to distribution shifts.' },
      ],
      assessmentFocus: [
        'Model architecture justification',
        'Disaggregated performance analysis by subgroup',
        'Fairness metrics computation and comparison',
        'Explainability and interpretability methods',
        'Robustness and sensitivity testing',
        'Documentation: model cards, experiment tracking',
      ],
    },
    {
      icon: null,
      title: 'Post-processing',
      color: '#A0522D',
      desc: 'What happens after the model is deployed: monitoring, governance, and community engagement.',
      areas: [
        { name: 'Deployment & Monitoring', desc: 'Continuous monitoring for performance drift, retraining triggers, and graceful degradation for out-of-distribution inputs.' },
        { name: 'Governance & Accountability', desc: 'Clear roles and responsibilities, incident response plans, audit trails, and compliance with data protection frameworks.' },
        { name: 'User Engagement & Literacy', desc: 'Training end-users to interpret AI outputs, establishing feedback channels and appeal mechanisms, and communicating system limitations.' },
      ],
      assessmentFocus: [
        'Drift detection and monitoring dashboards',
        'Human-in-the-loop mechanisms',
        'Accountability matrix and incident response',
        'End-user training and literacy programs',
        'Feedback and redress channels',
        'Full system documentation: codebooks',
      ],
    },
  ];


  return (
    <div className="about-page" id="about-page">
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">About the toolkit</span>
          <h1>Framework overview</h1>
          <p className="page-hero__desc">
            The {projectConfig.projectName} is a structured assessment
            for evaluating AI systems across the development lifecycle against
            established responsible AI principles.
          </p>
        </div>
      </section>

      {/* Framework Introduction */}
      <section className="section">
        <div className="container container--narrow">
          <div className="about-intro">
            <h2>A lifecycle approach to responsible AI</h2>
            <p>
              The assessment is split into three stages (pre-processing, in-processing, and
              post-processing) matching the phases of AI development. Each stage asks questions about
              specific practices and considerations, scored against responsible AI principles. At the end, you get
              a readiness report showing where you are strong, where the gaps are, and what to do about them.
            </p>
          </div>
        </div>
      </section>

      {/* Detailed Stage Breakdown */}
      <section className="section" style={{ background: 'var(--color-white)' }}>
        <div className="container">
          <div className="section-header">
            <span className="text-accent">Framework components</span>
            <h2>The three stages</h2>
          </div>

          <div className="stage-details">
            {stages.map((stage, idx) => (
              <div key={idx} className="stage-detail" style={{ '--stage-color': stage.color } as React.CSSProperties}>
                <div className="stage-detail__header">
                  {stage.icon && <span className="stage-detail__icon">{stage.icon}</span>}
                  <div>
                    <h3>{stage.title}</h3>
                    <p className="stage-detail__summary">{stage.desc}</p>
                  </div>
                </div>

                <div className="stage-detail__body">
                  <div className="stage-detail__areas">
                    <h4>What this stage covers</h4>
                    {stage.areas.map((area, i) => (
                      <div key={i} className="stage-area">
                        <h5>{area.name}</h5>
                        <p>{area.desc}</p>
                      </div>
                    ))}
                  </div>

                  <div className="stage-detail__assessment">
                    <h4>Assessment focus</h4>
                    <ul>
                      {stage.assessmentFocus.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* Principles */}
      <section className="section section--dark" id="principles-section">
        <div className="container">
          <div className="section-header">
            <span className="text-accent">Guiding principles</span>
            <h2>Eight responsible AI principles</h2>
            <p className="text-muted section-header__desc">
              Every question in the assessment maps back to one of these eight principles.
            </p>
          </div>

          <div className="stage-details">
            <div className="stage-detail" id="principle-fairness" style={{ '--stage-color': '#C06014' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Fairness &amp; Non-discrimination</h3>
                  <p className="stage-detail__summary">AI systems should not systematically disadvantage people based on characteristics like race, gender, age, disability, or socioeconomic status.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>Bias enters through training data that underrepresents certain groups, through labels that encode historical discrimination, and through model architectures that optimize for aggregate accuracy while masking poor performance on minorities. A healthcare algorithm that works well on average but fails for Black patients produces real harm, regardless of its overall accuracy score. Fairness requires active measurement: disaggregating performance by subgroup, testing for disparate impact, and choosing evaluation metrics that surface inequality rather than hide it.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Data representativeness relative to the target population. Historical bias identification. Disaggregated model performance across protected groups. Labeling consistency and annotator agreement.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PP-02">PP-02 Data Scarcity &amp; Availability Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-PP-03">PP-03 Historical &amp; Societal Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-PP-04">PP-04 Population Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-PP-07">PP-07 Labeling Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-IP-01">IP-01 Algorithmic Discrimination</Link></li>
                    <li><Link href="/explore/framework#area-card-IP-02">IP-02 Aggregation Bias</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-proportionality" style={{ '--stage-color': '#8B4513' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Proportionality &amp; Do Not Harm</h3>
                  <p className="stage-detail__summary">AI should only be used when it is the most appropriate solution, and should not cause more harm than the problem it solves.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>When a rule-based system, a spreadsheet, or a human process would produce comparable results, complex ML introduces unnecessary cost, opacity, and potential for harm with no added benefit. Proportionality means matching the tool to the problem and being honest about whether AI was chosen because it is the best approach or because it is the most novel one. A facial recognition system deployed in schools may be technically feasible, but the surveillance harms to children can far exceed the security benefits it provides.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Alternatives analysis before choosing AI. Cost-benefit evaluation that accounts for harms to affected populations. Sampling methodology that supports the claims being made.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PP-01">PP-01 Techno-solutionist Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-PP-05">PP-05 Sampling &amp; Generalization Bias</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-transparency" style={{ '--stage-color': '#A0522D' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Transparency &amp; Explainability</h3>
                  <p className="stage-detail__summary">People affected by AI decisions should be able to understand why those decisions were made.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>When an AI system denies someone a loan, flags them for additional scrutiny, or filters their job application, the affected person deserves to know why. Transparency goes beyond publishing model architecture details. It means providing meaningful explanations to the people who bear the consequences of automated decisions. It also extends to data collection: if personal data was gathered without informing the subjects, or if a deployed system has no documentation of how it works, transparency has already failed before any prediction is made.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Data collection transparency and consent practices. Explainability of model decisions to affected individuals. System documentation for auditors, regulators, and successors.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-IP-03">IP-03 Opacity &amp; Unexplainability</Link></li>
                    <li><Link href="/explore/framework#area-card-PO-07">PO-07 Documentation Deficit</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-accountability" style={{ '--stage-color': '#C06014' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Reproducibility &amp; Accountability</h3>
                  <p className="stage-detail__summary">Results should be reproducible, and someone should be accountable when things go wrong.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>If you cannot reproduce an AI system&apos;s results, you cannot audit it. If you cannot audit it, you cannot hold anyone accountable when it fails. Reproducibility requires documented code, versioned data, recorded hyperparameters, and fixed random seeds. Accountability requires clear ownership of system outputs, defined escalation paths when errors occur, and governance frameworks that survive personnel changes. Without both, harmful AI decisions happen in a vacuum: the model made the decision, no one owns the outcome, and no one can determine what went wrong.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Evaluation metric appropriateness for the use case. Experiment documentation and reproducibility. Post-deployment performance monitoring. Governance structures assigning responsibility for system outcomes.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-IP-04">IP-04 Metric Selection Bias</Link></li>
                    <li><Link href="/explore/framework#area-card-IP-06">IP-06 Reproducibility Failure</Link></li>
                    <li><Link href="/explore/framework#area-card-PO-01">PO-01 Deployment Drift</Link></li>
                    <li><Link href="/explore/framework#area-card-PO-03">PO-03 Accountability Gap</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-safety" style={{ '--stage-color': '#8B4513' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Safety &amp; Security</h3>
                  <p className="stage-detail__summary">Systems should handle unexpected inputs gracefully and protect data from corruption or misuse.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>A model trained on clean, curated data will face noisy, incomplete, and adversarial inputs in production. A data pipeline that works correctly in development can silently corrupt records during ETL. Safety means the system degrades gracefully rather than catastrophically when conditions change. Security means protecting the data pipeline from corruption, unauthorized modification, or quality degradation. In healthcare or criminal justice, a robustness failure causes direct harm to real people.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Stress testing against realistic distribution shifts. Data pipeline integrity checks and validation. Mechanisms for detecting and responding to data quality issues.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PP-06">PP-06 Privacy &amp; Consent Violations</Link></li>
                    <li><Link href="/explore/framework#area-card-IP-05">IP-05 Model Robustness Failure</Link></li>
                    <li><Link href="/explore/framework#area-card-IP-07">IP-07 Data Integrity Compromise</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-awareness" style={{ '--stage-color': '#A0522D' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Awareness &amp; Literacy</h3>
                  <p className="stage-detail__summary">People who use or are affected by AI systems need to understand what those systems can and cannot do.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>A clinician who treats a model&apos;s 60% confidence score as certainty will make worse decisions than one who understands the margin of error. A loan officer who does not realize they can override an algorithmic recommendation becomes a rubber stamp for the model&apos;s biases. AI literacy means giving end-users enough understanding to know when to trust the system, when to question it, and how to escalate when something looks wrong. Oversight mechanisms are only as strong as the people operating them.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Human oversight mechanisms for AI-driven decisions. End-user training on system outputs, confidence levels, and system limitations.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PO-02">PO-02 Lack of Human Oversight</Link></li>
                    <li><Link href="/explore/framework#area-card-PO-04">PO-04 User Literacy Deficit</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-collaboration" style={{ '--stage-color': '#C06014' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Multi-stakeholder Collaboration</h3>
                  <p className="stage-detail__summary">The people affected by an AI system should have a say in how it is built and used.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>AI systems built without input from the communities they affect tend to miss local context, fail to anticipate harm, and lack mechanisms for redress. A crop disease detection model deployed without consulting local farmers may misclassify regional crop varieties. A content moderation system without an appeal mechanism has no way to correct its mistakes. Feedback loops are how you discover that your system is failing in ways your test data never showed.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Mechanisms for affected communities and end-users to provide feedback, contest automated decisions, and report system issues.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PO-06">PO-06 Feedback Loop Absence</Link></li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="stage-detail" id="principle-sustainability" style={{ '--stage-color': '#8B4513' } as React.CSSProperties}>
              <div className="stage-detail__header">
                <div>
                  <h3>Sustainability</h3>
                  <p className="stage-detail__summary">The energy and environmental costs of AI should be proportionate to its benefits.</p>
                </div>
              </div>
              <div className="stage-detail__body">
                <div className="stage-detail__areas">
                  <p>Training a single large language model can emit as much carbon as five cars over their entire lifetimes. Running inference at scale compounds this. A model that reduces hospital readmissions may justify significant compute. A marginally better recommendation engine may not. This principle asks teams to measure and report the energy footprint of their AI systems and to consider whether more efficient architectures or training methods could achieve comparable results at lower cost.</p>
                  <h4>What the toolkit checks</h4>
                  <p>Environmental impact assessment for model training and deployment. Consideration of efficient architectures and green computing practices.</p>
                </div>
                <div className="stage-detail__assessment">
                  <h4>Linked assessment areas</h4>
                  <ul>
                    <li><Link href="/explore/framework#area-card-PO-05">PO-05 Environmental Impact</Link></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <p className="text-muted" style={{ textAlign: 'center', marginTop: 'var(--space-8)', fontSize: 'var(--font-size-sm)' }}>
            These principles are drawn from the <a href="https://www.unesco.org/en/artificial-intelligence/recommendation-ethics" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>UNESCO Recommendation on the Ethics of Artificial Intelligence</a>.
          </p>
        </div>
      </section>

    </div>
  );
}
