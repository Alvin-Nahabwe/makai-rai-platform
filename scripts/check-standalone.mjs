#!/usr/bin/env node
// node scripts/check-standalone.mjs <build-log>
//
// Run from the project root right after `npm run build` (the CI job that builds does this, and every
// build check in the v0.6.0 plan uses it). It fails when the build traced more of the project than it
// should have, which is how a test fixture, an `.env` file or application source ends up in the
// production image (contract "Static read paths", finding SEC-01):
//
//   - the build log says the whole project was traced, or traced something unintentionally; or
//   - `.next/standalone` holds a `__tests__` path outside `node_modules`, any `.env*` file, or a `.ts`
//     or `.tsx` file under `app/`, `lib/` or `components/`; or
//   - a file the server loads at run time without importing it is missing: the password hash worker
//     (lib/auth/passwordHash.ts starts it by path) and the bcryptjs it requires (next.config.ts traces both); or
//   - the log or the standalone tree is not there, because a check of nothing must not pass.
//
// Exit 0 prints `check-standalone: clean`. Exit 1 prints one stderr line per finding.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const logPath = process.argv[2];
const standalone = join('.next', 'standalone');
const findings = [];
// umd/package.json says {"type":"commonjs"}: without it the root package's "type":"module" makes umd/index.js load as
// ESM, and every job answers `bcrypt.compareSync is not a function` (C4 pool re-review m2).
const RUNTIME_FILES = ['lib/auth/passwordHashWorker.js', 'node_modules/bcryptjs/package.json', 'node_modules/bcryptjs/umd/index.js', 'node_modules/bcryptjs/umd/package.json'];

if (!logPath) {
  findings.push('no build log given (usage: node scripts/check-standalone.mjs <build-log>)');
} else if (!existsSync(logPath)) {
  findings.push(`build log not found: ${logPath}`);
} else {
  const log = readFileSync(logPath, 'utf8');
  if (/whole project/i.test(log)) findings.push(`${logPath}: the build log says the whole project was traced`);
  if (log.includes('traced unintentionally')) findings.push(`${logPath}: the build log says a file was traced unintentionally`);
}

/** Every file under `dir` as a path relative to the standalone root, without following symlinks. */
function filesUnder(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(dir, next) : [next];
  });
}

if (!existsSync(standalone)) {
  findings.push(`${standalone} not found (run npm run build first)`);
} else {
  for (const file of filesUnder(standalone)) {
    const segments = file.split('/');
    const name = segments[segments.length - 1];
    const inDependency = segments.includes('node_modules');
    if (segments.includes('__tests__') && !inDependency) findings.push(`${standalone}${sep}${file}: a test path is in the standalone output`);
    if (name.startsWith('.env')) findings.push(`${standalone}${sep}${file}: an .env file is in the standalone output`);
    if (/^(app|lib|components)$/.test(segments[0]) && /\.tsx?$/.test(name))
      findings.push(`${standalone}${sep}${file}: a source file is in the standalone output`);
  }
  for (const file of RUNTIME_FILES)
    if (!existsSync(join(standalone, file))) findings.push(`${standalone}${sep}${file} is missing: the server loads it at run time`);
}

if (findings.length > 0) {
  for (const f of findings) console.error(`check-standalone: ${f}`);
  process.exit(1);
}
console.log('check-standalone: clean');
