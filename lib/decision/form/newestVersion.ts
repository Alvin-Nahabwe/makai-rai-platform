import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionVersionView } from '@/types/api';

/**
 * The panel the decision form reads. A save's reply can name a saved version the page does not hold yet: a conflict's
 * current version, or the version the save itself made. `page` is the page's own panel and `newest` the newest version a
 * reply has named; the result is `page` itself (the same object) unless `newest` is the newer of the two, and then
 * `page` with that version as its current one. So its current version is never older than the page's or the named one,
 * whichever order they arrive in, and the form states nothing about a version it knows has been replaced.
 *
 * With the version go the two facts the page worked out from its current version that the version itself gives
 * (lib/question/panel.ts): the question's wording (the running content's for a withdrawal or an answer under it; an
 * answer under content this page does not hold keeps the page's wording, which the browser cannot load) and the
 * viewer's last own decision date (when the viewer entered the version and it is a decision). What a reply does not
 * carry stays the page's and is the older version's: `openFinding`, `historyCount`, `seals`, `gateAnswer`. The form
 * states none of them while the result is not `page` (DecisionForm `behind`); the card that does is not drawn then.
 */
export function panelWithNewest(page: QuestionPanelData, newest: DecisionVersionView | null): QuestionPanelData {
  if (newest === null || newest.versionNumber <= (page.current?.versionNumber ?? 0)) return page;
  const decision = newest.status !== 'withdrawn';
  return {
    ...page,
    current: newest,
    question: !decision || newest.content.semver === page.contentSemver ? page.runningQuestion : page.question,
    lastOwnSaveDate: decision && newest.enteredBy.userId === page.viewer.userId && newest.declaredDate !== null ? newest.declaredDate : page.lastOwnSaveDate,
  };
}
