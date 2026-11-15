import { TERM_FINDING, TERM_MITIGATION, TERM_SEAL, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';

/**
 * The words of About, S-28 (copy audit D, AB3 to AB52, as ruled for plan 1A Task 19 part 19d; first-use definitions,
 * lane 6 B5). Server only: it reads the vocabulary, so no client file may import it (ruling X-2).
 *
 * Not here, on purpose: the eight principle titles and the risk area names (content-tied, kept in the page), the
 * credit line (`data/credit.json`, read by `lib/credit.ts`) and the link to Help's "What sealing means" (lane 2's).
 * The two sentences that need a `data-claims-allowed` marker are single strings, so the marker in the page wraps
 * exactly one of them.
 */
export const ABOUT_COPY = Object.freeze({
  titles: Object.freeze({ about: 'About' }),
  hero: Object.freeze({
    heading: 'About the MAK-AI Responsible AI (RAI) Platform',
    lead: 'A place for a team to record what it decided about its AI system, why it decided it, and the evidence behind the decision.',
  }),
  whatItDoes: Object.freeze({
    heading: 'What the platform does',
    intro: 'Your team records a decision on each question about one AI system. The questions come in three stages:',
    /**
     * The ruled paragraph (Q17) in two parts around the four terms it introduces (B5): each term is first used in its own
     * line beside its definition, then `followUp` says how they fit. "Sealing fixes the record so it cannot change." is
     * dropped: the record can still change after a seal, and the seal's definition says what does not.
     */
    record: 'For each question, your team records a decision, the reason, who decided, when, and any evidence. The team decides; the platform records.',
    termsLead: 'Four more words name what can follow a decision:',
    /** The four terms in the order `followUp` uses them; the page prints each with the vocabulary's `Definition`. */
    terms: Object.freeze([TERM_FINDING, TERM_MITIGATION, TERM_STAGE_REVIEW, TERM_SEAL] as const),
    followUp:
      'If a decision does not meet good practice, a finding is raised. Your team closes each finding in one of two ways: it fixes the problem (a mitigation), or it records that it accepts the risk. When your team is ready, it seals a stage review. The platform then makes documents from it for your ethics committee or funder. The platform does not test your model or calculate anything from your data.',
    /** Holds "audit" and "certify": shown only inside the marker `not-an-approval-service` (AL-3). */
    notApproval:
      "The platform does not approve, audit or certify AI systems. Its documents are your team's own record, not an approval.",
    whoCanSee: Object.freeze({
      heading: 'Who can see your records',
      /** The owner's words (14 November 2026, Q18), unchanged. */
      text: 'Every member of your organisation can read its records. Other organisations cannot. The MAK-AI administrator has no access to your records in the platform. The people at MAK-AI who run the server can reach the database for technical work.',
    }),
  }),
  principles: Object.freeze({
    heading: 'Eight responsible AI principles',
    lead: 'Each question in the platform belongs to one of these eight principles. Read a principle to see why its questions are asked.',
    /** B5: the first use of "risk area" on About, in three parts around the `Term`; the page adds its `Definition`. */
    areasLine: Object.freeze(['Each principle lists its ', 'risk areas', '.'] as const),
    asks: 'What the platform asks about',
    areas: 'Risk areas',
    sourceBefore: 'These principles are drawn from the',
    sourceLink: 'UNESCO Recommendation on the Ethics of Artificial Intelligence',
    fairness: Object.freeze({
      summary:
        'AI systems should not systematically disadvantage people based on characteristics like race, gender, age, disability, or socioeconomic status.',
      body: 'Bias can enter through data that leaves some groups out, through labels that repeat past unfair treatment, or through a model that is accurate on average but often wrong for a smaller group. For example, a model trained mostly on data from city hospitals may miss disease in rural patients. To find this, test how well the model works for each group separately.',
      checks:
        'Whether the data matches the people the system will serve. Whether past unfair treatment is in the data. How well the model works for each group. Whether labels were given consistently.',
    }),
    proportionality: Object.freeze({
      summary:
        'AI should only be used when it is the most appropriate solution, and should not cause more harm than the problem it solves.',
      body: 'If a simple rule, a spreadsheet or a trained person would give similar results, a complex model adds cost and risk for no gain. Ask whether AI is the best tool, or only the newest one.',
      checks:
        'Whether the team compared AI with simpler options. Whether it weighed the possible harms against the benefits. Whether the sample supports what the team claims.',
    }),
    transparency: Object.freeze({
      summary: 'People affected by AI decisions should be able to understand why those decisions were made.',
      body: 'A person affected by an AI system should be able to learn why it gave its result. This also covers the data: people should know their data is used, and the system should be documented so others can understand it.',
      checks:
        "Whether people knew their data would be used and agreed. Whether the model's results can be explained to the people affected. Whether the system is documented well enough for others to follow.",
    }),
    accountability: Object.freeze({
      summary: 'Results should be reproducible, and someone should be accountable when things go wrong.',
      body: "If nobody can repeat an AI system's results, nobody can check them, and nobody can be held responsible when it goes wrong. Keep the code, a record of which data was used, and the settings, so the results can be produced again. Name who is responsible for the system, and who to tell when it makes a mistake.",
      checks:
        'Whether the team measures the right thing. Whether experiments are written down and can be repeated. Whether the model is watched after it goes live. Whether someone is named as responsible.',
    }),
    safety: Object.freeze({
      summary:
        'Systems should keep working safely when they receive unexpected data, and should protect data from damage or misuse.',
      body: 'A model trained on clean data will meet messy, missing or misleading data when it is used. Data can also be damaged when it is moved or cleaned. A safe system shows clearly when something goes wrong, so people can handle it. A secure system keeps data private and stops others from changing it.',
      checks:
        'Whether the model was tested on data that differs from the training data. Whether data is checked when it is moved or cleaned. Whether the team can find and fix problems with data quality. Whether personal data is protected.',
    }),
    awareness: Object.freeze({
      summary:
        'People who use or are affected by AI systems need to understand what those systems can and cannot do.',
      /** Holds "60%": shown only inside the marker `about-model-scores` (FR-RM-01), before `body`. */
      marked: 'A health worker who reads a model\'s "60% likely" as "certain" will make worse decisions.',
      body: 'People who use an AI system need to know when to trust it, when to question it, and whom to tell when something looks wrong. They also need to know that they may overrule it.',
      checks:
        'Whether a person can check and overrule the system. Whether users are trained to read its results and know its limits.',
    }),
    collaboration: Object.freeze({
      summary: 'The people affected by an AI system should have a say in how it is built and used.',
      body: 'Systems built without asking the people they affect often miss local facts and cause harm nobody planned. A crop disease model built without farmers may not know local crop varieties. People need a way to report problems and to challenge a result. Their reports show problems that your test data did not.',
      checks: 'Whether affected people and users can give feedback, challenge a result, and report problems.',
    }),
    sustainability: Object.freeze({
      summary: 'The energy and environmental costs of AI should be proportionate to its benefits.',
      body: 'Training and running large models uses a lot of energy. The benefit should be worth the cost: a model that keeps patients out of hospital may justify it, a small gain in a shopping app may not. Teams should record the energy their system uses, and check whether a smaller model would work almost as well.',
      checks:
        'Whether the team estimated the energy used to train and run the model. Whether it considered a smaller or more efficient model.',
    }),
  }),
  credit: Object.freeze({
    heading: 'Credit',
    licenceLink: (licence: string) => `Read the ${licence} licence`,
  }),
  help: Object.freeze({
    heading: 'Help and contact',
    /** Shown only while `data/help-contact.json` holds no address. */
    pending: 'For help, ask the Owner of your organisation.',
    writeTo: 'Write to',
    reference:
      'Tell us what you were doing and which page you were on. If an error page appeared, give the support reference shown on it. The reference lets us find what happened without screenshots of your records.',
    noRecords: 'Do not put your records in the email: no decisions, findings, file names or file contents.',
  }),
});
