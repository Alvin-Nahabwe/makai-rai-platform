/**
 * Test code only. public/notebooks/requirements.txt is C-NB's file and does not exist until unit/c-nb-2 lands it, but a card
 * with a released notebook stats it for the size it shows. A `vi.mock('node:fs', ...)` factory passes the real module here and
 * gets it back with that one `statSync` answered (2048 bytes); every other path is the real one. Remove the mock from the three
 * tests that use it (control-card, suggestion-slots, controls-page) once the file exists. No import: the factory runs while
 * 'node:fs' is itself being mocked.
 */
export function withRequirementsStat<T extends { statSync: unknown }>(real: T): T {
  const realStat = real.statSync as (...a: unknown[]) => unknown;
  return {
    ...real,
    statSync: ((p: unknown, ...rest: unknown[]) =>
      String(p).endsWith('/public/notebooks/requirements.txt') ? { size: 2048 } : realStat(p, ...rest)) as T['statSync'],
  };
}
