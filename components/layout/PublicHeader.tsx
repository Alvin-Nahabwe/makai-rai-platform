import Link from 'next/link';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { SHELL_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import './shell.css';

/** The header of the signed-out pages (SRS 7.1.1): the product name, About, Sign in and the theme switch (in the header, not fixed over the page, so it never covers a link). The signed-in pages have the shell's rail instead. */
export default function PublicHeader() {
  return (
    <header className="shell-public-header">
      <Link href="/" className="shell-public-header__name">
        {PRODUCT_NAME}
      </Link>
      <nav aria-label={SHELL_COPY.publicNav} className="shell-public-header__nav">
        <Link href="/about">{SHELL_COPY.public.about}</Link>
        <Link href="/login">{SHELL_COPY.public.signIn}</Link>
        <ThemeToggle onLight />
      </nav>
    </header>
  );
}
