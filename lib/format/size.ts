/**
 * A size as a person reads it (SRS 7.5.8, line 2593): decimal units, "84 KB", "2.4 MB". Kilobytes are
 * rounded to a whole number and never below 1; once that rounds to 1000 the size is written in megabytes
 * with one decimal. A size that is not a count of bytes is a RangeError, not "NaN KB" on a page.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`formatSize needs a number of bytes of 0 or more, got ${bytes}`);
  const kilobytes = Math.max(1, Math.round(bytes / 1000));
  return kilobytes >= 1000 ? `${(bytes / 1e6).toFixed(1)} MB` : `${kilobytes} KB`;
}
