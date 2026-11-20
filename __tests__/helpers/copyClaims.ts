import { expect } from 'vitest';
import { claimMatches } from '@/lib/claims/pattern';

/** Every string leaf of a copy object (strings, and strings inside arrays and nested objects), with its path. */
function leaves(value: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out);
  }
  return out;
}

/**
 * The claims lint's reach stops at `app` and `components` (no-product-claims.test.ts scans only those), so copy in
 * `lib/*\/copy.ts` is checked here: no string leaf of `copy` may match the claims pattern (SRS 7.5.3, FR-PUB-01).
 * Each task of "Path to outputs" that adds or changes a copy object adds one `it` that calls this with its object.
 */
export function assertNoClaims(name: string, copy: unknown): void {
  const found = leaves(copy, name, []).flatMap(([path, text]) => claimMatches(text).map((m) => `${path}: "${m.text}" in "${text}"`));
  expect(found, `${name}: strings that match the claims pattern`).toEqual([]);
}
