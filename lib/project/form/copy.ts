/**
 * Every word of the project form, S-09 in create and edit mode (audit B rows 90 to 137, as plan 1A Task 17 rules them).
 * Its one client importer is components/project/ProjectForm.tsx (ruling X-2: these words ship with the form only).
 */
const CREATE = 'Create project';
const SAVE = 'Save changes';

export const PROJECT_FORM_COPY = Object.freeze({
  /** The same address in both modes; "Back to {project}" needs a new target and is not built in plan 1A. */
  back: 'Back to all projects',
  headingCreate: 'New project',
  headingEdit: 'Edit project',
  leadCreate: 'Add the AI system your team is building. You will record your team\'s decisions about it here.',
  leadEdit: 'Change the project\'s name and details.',
  labels: Object.freeze({
    name: 'Project name',
    aiSystemType: 'AI system type',
    description: 'Description',
    deploymentSector: 'Sector',
    datasetType: 'Dataset type',
    datasetSize: 'Dataset size',
    processesPersonalData: 'Does the system use personal data?',
    fundingSource: 'Funding source',
    regulatoryContext: 'Regulatory context',
    developmentStage: 'Development status',
    teamSize: 'Team size',
    projectStart: 'Start date',
    projectEnd: 'End date',
    institution: 'Institution',
    department: 'Department',
    country: 'Country',
    targetPopulation: 'Target population',
    /** Shown only while AI system type is Other (defect 21). */
    aiSystemTypeOther: 'Describe the type of AI system',
  }),
  /** Fields with no entry here have no placeholder (B#123, B#131). */
  placeholders: Object.freeze({
    name: 'For example: Patient triage model',
    description: 'What the system does and who it is for',
    deploymentSector: 'For example: health, agriculture',
    datasetType: 'For example: tables, images, text',
    regulatoryContext: 'For example: your country\'s data protection law',
    institution: 'For example: your university or research centre',
    department: 'For example: computer science',
    targetPopulation: 'For example: older adults in rural areas',
  }),
  /** The first option of every select, with the empty value. */
  notChosen: 'Not chosen',
  /** The AI system types, in the order the form lists them; the values are the API's. */
  aiSystemTypes: Object.freeze([
    { value: 'classification', label: 'Classification' },
    { value: 'regression', label: 'Regression' },
    { value: 'nlp', label: 'Natural language processing' },
    { value: 'computer_vision', label: 'Computer vision' },
    { value: 'recommendation', label: 'Recommendation system' },
    { value: 'generative_ai', label: 'Generative AI' },
    { value: 'other', label: 'Other' },
  ] as const),
  /** The two sections of the form (plan 1B Task 13). */
  sectionAbout: 'About the project',
  sectionDetails: 'More details (optional)',
  /** The toggle of the optional details, by its state (defect 22): closed, then open. */
  showDetails: 'Show more details',
  hideDetails: 'Hide more details',
  optional: 'Optional. You can add these later.',
  cancel: 'Cancel',
  create: CREATE,
  save: SAVE,
  creating: 'Creating...',
  saving: 'Saving...',
  /** The form's own check before it sends anything. */
  nameRequired: 'Enter a project name.',
  /** A start or end date that is incomplete or not in the calendar (the ruled sentence of audit C row 431). */
  dateInvalid: 'Enter a real date, or leave the date empty.',
  slow: 'Still saving. The connection is slow.',
  /**
   * No reply in time, or no usable reply: the outcome is not known (CONSOLIDATED 8 #7, C3 rule 3; replaces B#373 here).
   * Save's "It will not be saved twice" is true because the same form sent again keeps its request id
   * (lib/client/retrySafeWrite.ts requestIdFor) and the route answers a repeated id with the first result
   * (lib/data/idempotency.ts receiptWrite). Create makes no such promise: a create form edited before it is sent
   * again gets a new request id (the coordinator's rule; review finding I-2).
   */
  noReply: Object.freeze({
    create: `Not created yet. We did not get a reply in time, so the project may already be created. Select ${CREATE} again.`,
    save: `Not saved yet. We did not get a reply in time, so your changes may already be saved. Select ${SAVE} again. It will not be saved twice.`,
  }),
});
