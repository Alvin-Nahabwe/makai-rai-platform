'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Light/dark theme toggle. Persists the choice to localStorage and reflects it
 * on <html data-theme>. Until mounted it renders a neutral placeholder so the
 * server and client markup match (the actual theme is applied pre-paint by the
 * inline script in the root layout).
 */
export default function ThemeToggle({ onLight = false }: { onLight?: boolean }) {
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
      className={onLight ? 'theme-toggle theme-toggle--on-light' : 'theme-toggle'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === null ? <span aria-hidden="true">◐</span> : isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Inline icons, hidden from assistive technology (the button has its own name); no emoji (SRS 7.6.3 D-9). */
function SunIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
