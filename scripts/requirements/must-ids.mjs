#!/usr/bin/env node
// The requirement ids of the SRS by priority, for the test-id check (NFR-MNT-03, SRS line 3320).
//
//   node scripts/requirements/must-ids.mjs <srs.md> > __tests__/lint/must-ids.json
//
// Reads each requirement block, a line that starts `> **FR-<AREA>-<n>**` or `> **NFR-<AREA>-<n>**`, up to the
// next such line or the next heading, and takes the block's priority from the last `*Priority:* MUST` or
// `*Priority:* SHOULD` in it. The last, because NFR-PERF-04 carries a table before its priority line (SRS line
// 3220). The template at the top of the SRS (`NFR-AREA-NN`) has no number, so it is not a block.
// Prints { "must": [...], "should": [...] }, each sorted. The test reads only that JSON, so CI needs no SRS.
//
// Exit 2: no file given, the file cannot be read, or a block has no priority or an id appears twice. A short
// list that looks complete is the failure this refuses.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADER = /^> \*\*(N?FR-[A-Z0-9]+-\d+)\*\*/;
const PRIORITY = /\*Priority:\*\s+(MUST|SHOULD)\b/g;

/**
 * @param {string} text
 * @returns {{ must: string[], should: string[] }}
 */
export function parseRequirementIds(text) {
  /** @type {Map<string, string | null>} */
  const priorityOf = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      current = header[1];
      if (priorityOf.has(current)) throw new Error(`${current} appears twice in the requirements`);
      priorityOf.set(current, null);
      continue;
    }
    if (line.startsWith('#')) {
      current = null;
      continue;
    }
    if (current === null) continue;
    for (const m of line.matchAll(PRIORITY)) priorityOf.set(current, m[1]);
  }
  const must = [];
  const should = [];
  for (const [id, priority] of priorityOf) {
    if (priority === null) throw new Error(`${id} has no "*Priority:* MUST" or "*Priority:* SHOULD" line`);
    (priority === 'MUST' ? must : should).push(id);
  }
  return { must: must.sort(), should: should.sort() };
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('usage: node scripts/requirements/must-ids.mjs <srs.md>\n');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(argv[0], 'utf8');
  } catch (e) {
    process.stderr.write(`must-ids: cannot read ${argv[0]} (${e.code ?? e.message})\n`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(parseRequirementIds(text), null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`must-ids: ${e.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
