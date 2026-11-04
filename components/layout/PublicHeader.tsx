import Link from 'next/link';
import ThemeToggle from '@/components/layout/ThemeToggle';

/** The header of the signed-out pages (SRS 7.1.1): the product name, About, Sign in and the theme button (in the header, not fixed over the page, so it never covers a link).  The signed-in pages have the sidebar instead. */
export default function PublicHeader() {
  return (
    <header className="public-header">
      <Link href="/" className="public-header__name">
        MAK-AI RAI Platform
      </Link>
      <nav aria-label="Public" className="public-header__nav">
        <Link href="/about">About</Link>
        <Link href="/login">Sign in</Link>
        <ThemeToggle floating />
      </nav>
    </header>
  );
}
