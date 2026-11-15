#!/usr/bin/env node
// First-load JavaScript per route, from an existing Next.js build (NFR-PERF-01, SRS line 3189).
//
//   node scripts/measure_first_load.mjs <.next directory> [--exceptions <file>]
//
// For each server/app/**/page_client-reference-manifest.js it takes the union of build-manifest.json
// `rootMainFiles` and every chunk listed under `entryJSFiles` (the page and its layouts), and prints
//
//   route=<path> firstLoadKB=<n> budgetKB=<160|190>
//
// where <n> is the gzip (level 9) size of those chunks in KiB. Polyfill files, CSS, fonts, images, the
// HTML and lazily loaded chunks are not counted: this measures the JavaScript a first visit with an empty
// cache downloads. The route is the directory under server/app with route groups ("(public)") removed. The
// budget is 160 KB when the first directory is the group "(public)" or the route directory is listed in
// PUBLIC_OUTSIDE_PUBLIC_GROUP, else 190 KB.
//
// Exit 0: every route is within budget, or over it with a listed exception.
// Exit 1: a route is over budget without an exception; a listed exception is stale (its route is not in the
//         build, or is within budget now); or RELEASE_CANDIDATE=1 is set and any exception is listed.
// Exit 2: the build could not be measured (no build-manifest.json, no route, a missing or unreadable file) or
//         the exceptions file is malformed. A build that cannot be read never passes.
//
// scripts/first-load-exceptions.json lists routes allowed over budget, each { route, reason }. It is `[]`
// once the score removal has merged. RELEASE_CANDIDATE=1 (the release candidate's run) refuses any entry.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PUBLIC_BUDGET_KB = 160;
const SIGNED_IN_BUDGET_KB = 190;
// NFR-PERF-01 (SRS line 3189) gives every public page (S-01 to S-06, S-28) 160 KB, but a page's group in the
// build says "public" only for the ones under app/(public). S-05, the acceptances page, is a public page that
// lives at app/(gate)/acceptances/page.tsx (contract, S-05 row; the gate frame's group since plan 1B Task 1), so it is
// listed here by its route directory as the build writes it. The match is exact: a child such as (gate)/acceptances/history
// is not S-05 and keeps 190 KB.
const PUBLIC_OUTSIDE_PUBLIC_GROUP = [
  '(gate)/acceptances',
  // Help (plan 1A Task 12): a public page outside (public) that shows the whole shell to a signed-in person, as S-05 does.
  'help',
];
const MANIFEST_NAME = 'page_client-reference-manifest.js';

class Unreadable extends Error {}

function fail(code, message) {
  process.stderr.write(`measure_first_load: ${message}\n`);
  process.exit(code);
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Unreadable(`cannot read ${what} ${path} (${e.code ?? e.message})`);
  }
}

function readJson(path, what) {
  try {
    return JSON.parse(readText(path, what));
  } catch (e) {
    if (e instanceof Unreadable) throw e;
    throw new Unreadable(`${what} ${path} is not valid JSON`);
  }
}

/** The manifest's object: Next writes `globalThis.__RSC_MANIFEST["<key>"] = {...};` and nothing else after it. */
function parseClientReferenceManifest(path) {
  const text = readText(path, 'client reference manifest');
  const start = /__RSC_MANIFEST\[("(?:[^"\\]|\\.)*")\]\s*=\s*/.exec(text);
  if (!start) throw new Unreadable(`${path} has no __RSC_MANIFEST assignment`);
  const body = text.slice(start.index + start[0].length).trim().replace(/;$/, '');
  try {
    return JSON.parse(body);
  } catch {
    throw new Unreadable(`the manifest object in ${path} is not valid JSON`);
  }
}

/** Every page_client-reference-manifest.js under `dir`, as paths relative to `dir`. */
function findManifests(dir, rel = '') {
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch (e) {
    throw new Unreadable(`cannot read directory ${join(dir, rel)} (${e.code ?? e.message})`);
  }
  return entries.flatMap((entry) => {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) return findManifests(dir, next);
    return entry.name === MANIFEST_NAME ? [next] : [];
  });
}

function routeOf(manifestRel) {
  const segments = manifestRel.split('/').slice(0, -1);
  const visible = segments.filter((s) => !/^\(.*\)$/.test(s));
  const isPublic = segments[0] === '(public)' || PUBLIC_OUTSIDE_PUBLIC_GROUP.includes(segments.join('/'));
  return { route: `/${visible.join('/')}`, budgetKB: isPublic ? PUBLIC_BUDGET_KB : SIGNED_IN_BUDGET_KB };
}

function gzipBytes(nextDir, chunk, cache) {
  const rel = chunk.startsWith('/_next/') ? chunk.slice('/_next/'.length) : chunk.replace(/^\/+/, '');
  const full = resolve(nextDir, rel);
  if (!full.startsWith(resolve(nextDir) + sep)) throw new Unreadable(`chunk ${chunk} points outside the build directory`);
  if (!cache.has(full)) {
    let data;
    try {
      data = readFileSync(full);
    } catch (e) {
      throw new Unreadable(`cannot read chunk ${rel} (${e.code ?? e.message})`);
    }
    cache.set(full, gzipSync(data, { level: 9 }).length);
  }
  return cache.get(full);
}

function measure(nextDir) {
  const buildManifest = join(nextDir, 'build-manifest.json');
  const build = readJson(buildManifest, 'build manifest');
  // A key Next stops writing must not read as "no shared chunks": every route would look light. Empty is an answer, missing is not.
  if (!Array.isArray(build.rootMainFiles)) throw new Unreadable(`${buildManifest} has no rootMainFiles list`);
  const rootMain = build.rootMainFiles;
  const manifests = findManifests(join(nextDir, 'server', 'app'));
  if (manifests.length === 0) throw new Unreadable(`no route found: no ${MANIFEST_NAME} under ${join(nextDir, 'server', 'app')}`);
  const cache = new Map();
  const rows = manifests.map((rel) => {
    const manifestPath = join(nextDir, 'server', 'app', rel);
    const entries = parseClientReferenceManifest(manifestPath).entryJSFiles;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) throw new Unreadable(`${manifestPath} has no entryJSFiles object`);
    const chunks = new Set(rootMain);
    for (const list of Object.values(entries)) for (const chunk of list) chunks.add(chunk);
    let bytes = 0;
    for (const chunk of chunks) bytes += gzipBytes(nextDir, chunk, cache);
    return { ...routeOf(rel), kb: bytes / 1024 };
  });
  return rows.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

function readExceptions(file) {
  const list = readJson(file, 'exceptions file');
  const valid =
    Array.isArray(list) &&
    list.every((e) => e && typeof e === 'object' && typeof e.route === 'string' && e.route.startsWith('/') && typeof e.reason === 'string' && e.reason.trim() !== '');
  if (!valid) throw new Unreadable(`${file} must be a JSON array of { "route": "/path", "reason": "why" } entries`);
  return list;
}

function main(argv) {
  const args = [...argv];
  let exceptionsFile = join(dirname(fileURLToPath(import.meta.url)), 'first-load-exceptions.json');
  const at = args.indexOf('--exceptions');
  if (at >= 0) {
    if (args[at + 1] === undefined) fail(2, '--exceptions needs a file');
    exceptionsFile = args[at + 1];
    args.splice(at, 2);
  }
  if (args.length !== 1) fail(2, 'usage: node scripts/measure_first_load.mjs <.next directory> [--exceptions <file>]');

  let rows;
  let exceptions;
  try {
    exceptions = readExceptions(exceptionsFile);
    rows = measure(args[0]);
  } catch (e) {
    if (e instanceof Unreadable) fail(2, e.message);
    throw e;
  }

  const problems = [];
  const excepted = new Map(exceptions.map((e) => [e.route, e.reason]));
  for (const { route, kb, budgetKB } of rows) {
    process.stdout.write(`route=${route} firstLoadKB=${kb.toFixed(1)} budgetKB=${budgetKB}\n`);
    if (kb <= budgetKB) continue;
    if (excepted.has(route)) {
      process.stdout.write(`exception: ${route} is ${(kb - budgetKB).toFixed(1)} KB over its ${budgetKB} KB budget, listed: ${excepted.get(route)}\n`);
    } else {
      problems.push(`${route} is ${kb.toFixed(1)} KB, over its ${budgetKB} KB budget by ${(kb - budgetKB).toFixed(1)} KB`);
    }
  }
  for (const { route } of exceptions) {
    const row = rows.find((r) => r.route === route);
    if (!row) problems.push(`stale exception: ${route} is not a route of this build; delete its entry from ${exceptionsFile}`);
    else if (row.kb <= row.budgetKB) problems.push(`stale exception: ${route} is within its ${row.budgetKB} KB budget (${row.kb.toFixed(1)} KB); delete its entry from ${exceptionsFile}`);
  }
  if (process.env.RELEASE_CANDIDATE === '1' && exceptions.length > 0) {
    problems.push(`RELEASE_CANDIDATE=1 allows no page-weight exception, but ${exceptionsFile} lists ${exceptions.map((e) => e.route).join(', ')}`);
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`measure_first_load: ${p}\n`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
