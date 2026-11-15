'use client';

import { Icon } from '@/components/ui/Icon';
import { SHELL_COPY } from '@/lib/shell/copy';

/**
 * The theme switch (plan 1A Task 11, ruling L2-47; modern-web-guidance `dark-mode-toggle`). Both labels are in the markup and
 * CSS shows the one that names the other theme (app/globals.css, moved there from components/layout/shell.css), so the server and the client render the same
 * thing and the words are right on first paint, before any script. The control's name changes with the state, so it carries
 * no aria-pressed. A press sets <html data-theme> and stores the choice under `theme`, which the root layout's inline script
 * reads before paint.
 */
export default function ThemeToggle({ onLight = false }: { onLight?: boolean }) {
  function toggle() {
    const root = document.documentElement;
    const set = root.getAttribute('data-theme');
    const rendered = set === 'dark' || set === 'light' ? set : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const next = rendered === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Ignore storage failures (e.g. private mode) — the in-session choice still applies.
    }
  }

  return (
    <button type="button" className={onLight ? 'shell-theme shell-theme--on-light' : 'shell-theme'} onClick={toggle}>
      <span className="shell-theme__to-dark"><Icon name="moon" />{SHELL_COPY.theme.toDark}</span>
      <span className="shell-theme__to-light"><Icon name="sun" />{SHELL_COPY.theme.toLight}</span>
    </button>
  );
}
