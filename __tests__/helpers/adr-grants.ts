import { readFileSync } from 'node:fs';

/**
 * Reads the grant tables out of `docs/adr/0009-identity-lane-role.md`.
 *
 * The ADR is the single statement of what each lane may do. Tests read it rather than
 * restating it, so a grant cannot change in a migration without the ADR changing too:
 * `role-grants.test.ts` compares the live catalog to these tables, and
 * `identity-lane.test.ts` derives "every tenant record table" from them.
 *
 * Strict on purpose. A row that does not parse, an unknown privilege, a missing
 * heading or an empty table throws, because a parser that quietly returned `{}` would
 * make every comparison against it pass by expecting nothing.
 */
export type LaneRole = 'makrai_identity' | 'makrai_app';

const ADR_PATH = 'docs/adr/0009-identity-lane-role.md';
const PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']);

/** Table name -> sorted privileges, for every table the ADR grants `role` anything on. */
export function adrGrants(role: LaneRole): Record<string, string[]> {
  const lines = readFileSync(ADR_PATH, 'utf8').split('\n');
  const heading = lines.findIndex((l) => l.trim() === `### \`${role}\` grants`);
  if (heading === -1) throw new Error(`${ADR_PATH} has no "### \`${role}\` grants" heading`);

  const out: Record<string, string[]> = {};
  let inTable = false;
  for (const line of lines.slice(heading + 1)) {
    const trimmed = line.trim();
    if (!inTable) {
      if (trimmed.startsWith('|')) inTable = true;
      else if (trimmed.startsWith('#')) break;
      else continue;
    }
    if (!trimmed.startsWith('|')) break; // the table ended
    if (/^\|\s*Table\s*\|/.test(trimmed) || /^\|[-\s|]+\|$/.test(trimmed)) continue;

    const m = /^\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|/.exec(trimmed);
    if (!m) throw new Error(`${ADR_PATH}: cannot parse grant row ${JSON.stringify(trimmed)}`);
    const privileges = m[2].split(',').map((p) => p.trim());
    for (const p of privileges) {
      if (!PRIVILEGES.has(p)) throw new Error(`${ADR_PATH}: unknown privilege ${JSON.stringify(p)} for ${m[1]}`);
    }
    if (m[1] in out) throw new Error(`${ADR_PATH}: ${m[1]} is listed twice for ${role}`);
    out[m[1]] = privileges.sort();
  }
  if (Object.keys(out).length === 0) throw new Error(`${ADR_PATH}: the ${role} grant table is empty`);
  return out;
}
