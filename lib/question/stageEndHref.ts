/**
 * The end-of-stage screen of the stage whose question list is at `stageHref` (design G3). The one place the address is built:
 * the stage page, the last question's way on, the reading view and the save's push all take it from here.
 */
export const stageEndHref = (stageHref: string): string => `${stageHref}/end`;
