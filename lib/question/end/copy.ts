import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * The end-of-stage screen (path to outputs, design G3; components/question/StageEnd.tsx), where saving the last question of a
 * stage lands. `link` is how the stage page, the last question and the reading view reach it again (QUESTION_COPY.end.link, kept
 * there alone because the question page's client bundle carries QUESTION_COPY); `title` is the page's name in the browser tab.
 * The stage name in `start` and `view` is the caller's, a vocabulary term it marks at first use. Only server components and tests
 * import this module.
 */
export const STAGE_END_COPY = Object.freeze({
  title: 'Where your project stands',
  link: QUESTION_COPY.end.link,
  heading: 'Here is where your project stands',
  openReport: 'Open the working report',
  start: (stage: string): string => `Start ${stage}`,
  view: (stage: string): string => `View ${stage}`,
  openHeading: 'Next steps in this stage',
  nothingOpen: 'Nothing is open in this stage.',
  more: (n: number): string => (n === 1 ? '1 more is listed in the working report.' : `${n} more are listed in the working report.`),
  /** The accessible name of the (i) beside a term the screen defines at its first use: 'What does "risk area" mean?'. */
  whatMeans: (term: string): string => `What does "${term}" mean?`,
});
