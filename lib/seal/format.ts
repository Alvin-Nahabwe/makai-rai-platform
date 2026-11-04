/**
 * A seal fingerprint as people read it (7.5.8, UX-18, M-28; contract "Further cross-unit symbols", gap
 * G017): lower-case hexadecimal in groups of four. `full` is the sixteen groups separated by spaces; `short`
 * is the first two groups, " ... ", and the last group ("8b21 04fa ... 9e3d"). Anything other than 64
 * lower-case hex characters is refused rather than shown cut, since a shortened wrong value would read as
 * a real fingerprint.
 */
export function formatFingerprint(hex: string, form: 'full' | 'short'): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('formatFingerprint: not a SHA-256 fingerprint');
  const groups = hex.match(/.{4}/g) as string[];
  return form === 'full' ? groups.join(' ') : `${groups[0]} ${groups[1]} ... ${groups[15]}`;
}
