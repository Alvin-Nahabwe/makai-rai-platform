/**
 * The port a Playwright run drives, and the base URL built from it.
 *
 * Several builders share one machine, and `playwright.config.ts` used to fix
 * `http://localhost:3000` with `reuseExistingServer` on, so a second local run
 * attached to whichever server started first and tested the wrong code
 * (00-master.md E2). Outside CI the port therefore has no default: an unset
 * `E2E_PORT` throws when the config loads. With `CI` set the value is
 * unchanged, port 3000, so the Actions job is as before.
 *
 * `E2E_PORT` ends up inside a `sh -c` command line (`webServer.command`), so
 * it is accepted only as 2 to 5 digits. Nothing else is interpolated. A
 * malformed value is refused even in CI instead of falling back to 3000, with
 * a message of its own that does not repeat the value; an empty one counts as
 * unset.
 */
export function e2ePort(env: NodeJS.ProcessEnv): string {
  const port = env.E2E_PORT;
  if (port) {
    if (/^\d{2,5}$/.test(port)) return port;
    // The value is not repeated: it is untrusted text on its way into a shell line.
    throw new Error('E2E_PORT must be 2 to 5 digits');
  }
  if (env.CI) return '3000';
  throw new Error("E2E_PORT must be set to this slot's port outside CI (00-master.md E2)");
}

export function e2eBaseURL(env: NodeJS.ProcessEnv): string {
  return `http://localhost:${e2ePort(env)}`;
}
