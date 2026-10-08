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
 *
 * The two apt files are read strictly. A `#clear` or `#include` directive, a
 * nested block, or anything else the readers below do not understand fails the
 * test, because apt would act on it and the test cannot follow it. A setting
 * added in some other file under /etc/apt/apt.conf.d is out of reach of any test
 * here.
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
 * The `#clear` and `#include` directives are kept: apt acts on them.
 */
function aptConf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .filter((line) => !line.trimStart().startsWith('#') || /^\s*#(clear|include)\b/.test(line))
    .join('\n');
}

/**
 * The reader takes what it understands out of the text and requires nothing to be
 * left. A file that does anything else, such as a directive or a nested block that
 * sets the same key, is refused rather than read as if the extra part were absent.
 */
function requireNothingLeft(rest: string): void {
  expect(rest.trim(), `apt syntax this test does not read:\n${rest.trim()}`).toBe('');
}

/**
 * The `Key "value";` settings of an apt.conf file, one per line. A key set twice
 * keeps its last value, which is how apt resolves it.
 */
function aptSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  const rest = aptConf(text).replace(/^[ \t]*([A-Za-z][\w:-]*)[ \t]+"([^"]*)"[ \t]*;[ \t]*$/gm, (_m, key, value) => {
    settings.set(key, value);
    return '';
  });
  requireNothingLeft(rest);
  return settings;
}

/** The quoted entries of the one `Unattended-Upgrade::Allowed-Origins { ... };` block. */
function allowedOrigins(text: string): string[] {
  const origins: string[] = [];
  let blocks = 0;
  const rest = aptConf(text).replace(/Unattended-Upgrade::Allowed-Origins\s*\{([^}]*)\}\s*;/g, (_m, body: string) => {
    blocks += 1;
    requireNothingLeft(body.replace(/"([^"]*)"\s*;/g, (_e, origin: string) => {
      origins.push(origin);
      return '';
    }));
    return '';
  });
  expect(blocks, 'expected exactly one Unattended-Upgrade::Allowed-Origins block').toBe(1);
  requireNothingLeft(rest);
  return origins;
}

/**
 * The readers above must not call a file fine when apt would read it differently.
 * Checked with `apt-config dump` (apt 2.8.3) before these cases were written:
 * `#clear` and `#include` act as directives wherever they appear outside a `//`
 * or block comment, while `# clear` (with a space) is a comment; a nested
 * `Unattended-Upgrade { ... };` block sets the same keys as the flat
 * `Unattended-Upgrade::Key` form and, coming later, wins; two statements on one
 * line, and a second `Allowed-Origins` block, are valid and honoured. The readers
 * refuse those last two only because they follow the one-statement-per-line,
 * one-block form that the files are written in.
 */
describe('the apt readers', () => {
  const ORIGINS = 'Unattended-Upgrade::Allowed-Origins {\n\t"Docker:noble";\n};\n';
  const REBOOT_SETTINGS =
    'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "03:30";\n';

  it('read plain files, and ignore everything apt ignores', () => {
    const noise = '# clear is a comment\n// #clear is a comment\n/* #clear is a comment */\n';
    expect(allowedOrigins(noise + ORIGINS)).toEqual(['Docker:noble']);
    expect([...aptSettings(noise + REBOOT_SETTINGS)]).toEqual([
      ['Unattended-Upgrade::Automatic-Reboot', 'true'],
      ['Unattended-Upgrade::Automatic-Reboot-Time', '03:30'],
    ]);
  });

  it.each([
    ['#clear before the block', '#clear Unattended-Upgrade::Allowed-Origins;\n' + ORIGINS],
    ['an indented #clear', '  #clear Unattended-Upgrade::Allowed-Origins;\n' + ORIGINS],
    ['#clear after the block', ORIGINS + '#clear Unattended-Upgrade::Allowed-Origins;\n'],
    ['#clear after a statement on the same line', 'Unattended-Upgrade::Allowed-Origins {\n"Docker:noble";\n}; #clear Unattended-Upgrade::Allowed-Origins;\n'],
    ['#include', '#include "/etc/apt/apt.conf.d/99other";\n' + ORIGINS],
    ['a second Allowed-Origins block', ORIGINS + ORIGINS],
    ['the list inside a nested block', 'Unattended-Upgrade {\n  Allowed-Origins {\n    "Docker:noble";\n  };\n};\n'],
  ])('refuse an origins file with %s', (_name, text) => {
    expect(() => allowedOrigins(text)).toThrow();
  });

  it.each([
    ['#clear before the settings', '#clear Unattended-Upgrade::Automatic-Reboot;\n' + REBOOT_SETTINGS],
    ['#clear after the settings', REBOOT_SETTINGS + '#clear Unattended-Upgrade::Automatic-Reboot;\n'],
    ['#include', '#include "/etc/apt/apt.conf.d/99other";\n' + REBOOT_SETTINGS],
    ['a nested block that overrides a setting', REBOOT_SETTINGS + 'Unattended-Upgrade {\n  Automatic-Reboot "false";\n};\n'],
    ['two settings on one line', 'Unattended-Upgrade::Automatic-Reboot "true"; Unattended-Upgrade::Automatic-Reboot-Time "03:30";\n'],
  ])('refuse a settings file with %s', (_name, text) => {
    expect(() => aptSettings(text)).toThrow();
  });
});

describe('51makrai-docker-origin', () => {
  it('lets unattended-upgrades install packages from the Docker repository', () => {
    // Without this entry unattended-upgrades ignores the Docker repository, so
    // the engine stays at the last version installed by hand.
    expect(allowedOrigins(readHost(DOCKER_ORIGIN))).toContain('Docker:noble');
  });
});

describe('52makrai-reboot', () => {
  it('reboots automatically after an upgrade that needs it, at 03:30', () => {
    // A kernel or libc upgrade does not take effect until the host restarts.
    // The time is a clock time in the host's timezone, which is UTC.
    const settings = aptSettings(readHost(REBOOT));
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
