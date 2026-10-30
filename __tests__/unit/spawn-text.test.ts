import { describe, expect, it } from 'vitest';
import { shText, stripAnsi } from '../helpers/spawnText';

/**
 * C4 item 12: a test that spawns a process and matches its output runs the child with NO_COLOR=1
 * and strips ANSI escapes, so a colouring environment (FORCE_COLOR=1, a TTY-like CI) cannot change
 * what the match sees.
 */
describe('spawned-process text (C4 item 12)', () => {
  it('stripAnsi removes colour and cursor escapes and keeps the text', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m and \u001b[1;32mbold green\u001b[39;22m\u001b[?25l')).toBe('red and bold green');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('shText runs the child with NO_COLOR=1 and returns its stripped output', () => {
    expect(shText(`printf '%s' "$NO_COLOR"`)).toBe('1');
    expect(shText(`printf '\\033[31mx\\033[0m'`)).toBe('x');
  });
});
