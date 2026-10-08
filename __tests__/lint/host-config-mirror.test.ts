import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Host configuration files mirrored into `ops/host/`.
 *
 * These are not scripts: each is a config file the server reads, copied here so
 * the repository says what the host runs. The tests keep the one property of
 * each that something else depends on from being edited away.
 *
 * WHAT THESE TESTS CAN AND CANNOT SHOW. They read the repository copy. They do
 * not read the host, so they cannot show that the host still matches; that
 * comparison is a `sha256sum` of both. What they stop is an edit to the copy
 * that would be installed over a working host and quietly undo the setting.
 */

const HOST_DIR = 'ops/host';
const DOCKER_ORIGIN = '51makrai-docker-origin';
const REBOOT = '52makrai-reboot';

function readHost(file: string): string {
  const p = path.join(HOST_DIR, file);
  expect(existsSync(p), `${p} does not exist`).toBe(true);
  return readFileSync(p, 'utf8');
}

/**
 * apt.conf text with comments removed (block comments, `//` comments and `#`
 * lines), so a setting that is only mentioned in a comment does not count as set.
 */
function aptConf(file: string): string {
  return readHost(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * The `Key "value";` settings of an apt.conf file. A key set twice keeps its
 * last value, which is how apt resolves it.
 */
function aptSettings(file: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const m of aptConf(file).matchAll(/^\s*([A-Za-z][\w:-]*)\s+"([^"]*)"\s*;/gm)) {
    settings.set(m[1], m[2]);
  }
  return settings;
}

/** The quoted entries of `Unattended-Upgrade::Allowed-Origins { ... };`. */
function allowedOrigins(file: string): string[] {
  const block = /Unattended-Upgrade::Allowed-Origins\s*\{([^}]*)\}\s*;/.exec(aptConf(file));
  expect(block, `${file} has no Unattended-Upgrade::Allowed-Origins block`).not.toBeNull();
  const body = block ? block[1] : '';
  return [...body.matchAll(/"([^"]*)"\s*;/g)].map((m) => m[1]);
}

describe('51makrai-docker-origin', () => {
  it('lets unattended-upgrades install packages from the Docker repository', () => {
    // Without this entry the Docker packages are held back, and the engine
    // stays at whatever version the host was provisioned with.
    expect(allowedOrigins(DOCKER_ORIGIN)).toContain('Docker:noble');
  });
});

describe('52makrai-reboot', () => {
  it('reboots automatically after an upgrade that needs it, at 03:30', () => {
    // A kernel or libc upgrade does not take effect until the host restarts.
    // The time is a clock time in the host's timezone, which is UTC.
    const settings = aptSettings(REBOOT);
    expect(settings.get('Unattended-Upgrade::Automatic-Reboot')).toBe('true');
    expect(settings.get('Unattended-Upgrade::Automatic-Reboot-Time')).toBe('03:30');
  });
});

describe('daemon.json', () => {
  const daemon = (): Record<string, unknown> => JSON.parse(readHost('daemon.json'));

  it('is valid JSON with live-restore on, so containers survive a daemon restart', () => {
    expect(daemon()['live-restore']).toBe(true);
  });

  it('keeps the json-file log driver and its size cap', () => {
    // Without the cap a container's log file grows until the disk is full.
    expect(daemon()['log-driver']).toBe('json-file');
    expect(daemon()['log-opts']).toEqual({ 'max-size': '10m', 'max-file': '5' });
  });
});
