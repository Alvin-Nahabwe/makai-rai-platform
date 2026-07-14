'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Light/dark theme toggle. Persists the choice to localStorage and reflects it
 * on <html data-theme>. Until mounted it renders a neutral placeholder so the
 * server and client markup match (the actual theme is applied pre-paint by the
 * inline script in the root layout).
 */
export default function ThemeToggle({ floating = false }: { floating?: boolean }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // Reads browser-only APIs (data-theme set pre-paint, and the OS preference),
    // so it can only run after mount — a legitimate one-shot effect setState.
    const stored = document.documentElement.getAttribute('data-theme') as Theme | null;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(stored ?? (prefersDark ? 'dark' : 'light'));
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Ignore storage failures (e.g. private mode) — the in-session choice still applies.
    }
  }

  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      className={floating ? 'theme-toggle theme-toggle--floating' : 'theme-toggle'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <span aria-hidden="true">{theme === null ? '◐' : isDark ? '☀️' : '🌙'}</span>
    </button>
  );
}
