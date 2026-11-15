/**
 * The words of Guidance: the framework page (S-26), the controls page (S-27) and the research sources list on S-26
 * (copy audit D, EX1 to EX24, as ruled for plan 1A Task 19). Server only: no client file may import it (ruling X-2).
 */
export const GUIDANCE_COPY = Object.freeze({
  titles: Object.freeze({ framework: 'Framework', controls: 'Controls' }),
  framework: Object.freeze({
    heading: 'The question framework',
    /**
     * The lead's first sentence, then its two lines on risk areas and controls, each in three parts around its one defined
     * term (B5): the page marks the term with `Term` and follows the line with its `Definition`. The ruled sentence "Each
     * question links to a risk area, and each risk area to controls that reduce the risk." is split in two for that.
     */
    lead: (stages: number, topics: number) => `The questions are grouped into ${stages} stages and ${topics} topics.`,
    areasLine: Object.freeze(['Each question links to a ', 'risk area', '.'] as const),
    controlsLine: Object.freeze(['Each risk area links to ', 'controls', ' that reduce the risk.'] as const),
    counts: (stages: number, topics: number, areas: number, controls: number) =>
      `${stages} stages, ${topics} topics, ${areas} risk areas, ${controls} controls`,
    scope: Object.freeze({
      summary: 'What this framework covers, and what it does not',
      /**
       * EX5, in parts: the second and fourth are shown in bold. The ruled "rank them" is refused by the claims pattern
       * (lib/claims/pattern.ts, `rank`), so this holds the page's earlier words "put them in order" until it is ruled.
       */
      predictive: Object.freeze([
        'These questions are for ',
        'predictive',
        ' AI systems: models that sort cases into groups, put them in order, or estimate a number. They do not cover ',
        'generative',
        ' AI, such as chatbots or systems that write text or make images. If your system is generative, a record here does not cover its main risks.',
      ] as const),
      bias: 'The questions look at bias in the data and the model: who is in the data, how labels were made, and whether errors fall more on some groups. They do not ask who chose the problem, who benefits from the system, or whose priorities set its goal. Your team may need to answer those questions in another place.',
      standards: Object.freeze({
        label: 'Standards.',
        text: 'Using this framework does not mean your organisation meets ISO/IEC 42001. Some controls mention articles of the EU AI Act for reference. This does not mean the Act applies to your system.',
      }),
      principles: Object.freeze({
        label: 'Principles.',
        text: "The framework uses eight of UNESCO's ten principles. Privacy and human oversight are not separate principles here; they are risk areas (PP-06 and PO-02).",
      }),
    }),
    topics: 'Topics',
    topicLine: (title: string, questions: number) =>
      questions === 1 ? `${title}, 1 question` : `${title}, ${questions} questions`,
    riskAreas: 'Risk areas',
    principle: (name: string) => `Principle: ${name}`,
    examples: 'Examples:',
    controls: 'Controls',
  }),
  references: Object.freeze({
    summary: (n: number) => `Research sources (${n})`,
    doi: 'DOI',
    arxiv: 'arXiv',
    book: 'Book',
  }),
  controls: Object.freeze({
    /**
     * B5: under the h1 (the first use of "control"), the page shows the control's `Definition`, then these two lines, each
     * in three parts around its one defined term, which the page marks with `Term` and follows with its `Definition`. The
     * line was "When your team closes a finding with a mitigation, …": "finding" is left out so each line holds one term.
     */
    introLine: Object.freeze(['When your team adds a ', 'mitigation', ', it can follow one of these.'] as const),
    areasLine: Object.freeze(['Each control lists the ', 'risk areas', ' it addresses.'] as const),
    count: (n: number) => `${n} controls`,
    types: Object.freeze({
      technical: Object.freeze({ label: 'Technical', line: 'Changes to data, model or code.' }),
      procedural: Object.freeze({ label: 'Procedural', line: 'Steps your team follows.' }),
      informational: Object.freeze({ label: 'Informational', line: 'What you tell affected people.' }),
    }),
    section: (label: string, n: number) => `${label} (${n})`,
    riskAreas: 'Risk areas:',
  }),
});
