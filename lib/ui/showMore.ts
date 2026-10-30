/** Lists show this many items before "Show more" (findings, members, accounts, organisations; UX-40). */
export const LIST_PAGE_SIZE = 50;
/** A history (decision versions) shows this many before "Show older" (UX-40). */
export const HISTORY_PAGE_SIZE = 20;

/**
 * One page of a list, by the `shown` query parameter (UX-40). `shown` is how many items the person has asked
 * to see; anything but a whole number of up to nine digits, and anything below one page, means the first
 * page. `nextShown` is the value for the "Show more" link while there is more, and `shown` itself after.
 * Reading a list this way changes nothing about it.
 */
export function pageOf<T>(
  items: readonly T[], shown: string | null, pageSize: number,
): { items: T[]; hasMore: boolean; nextShown: number } {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageOf needs a page size of 1 or more, got ${pageSize}`);
  const asked = shown !== null && /^\d{1,9}$/.test(shown) ? Number(shown) : pageSize;
  const wanted = Math.max(asked, pageSize);
  const hasMore = items.length > wanted;
  return { items: items.slice(0, wanted), hasMore, nextShown: hasMore ? wanted + pageSize : wanted };
}
