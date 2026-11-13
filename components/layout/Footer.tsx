import Link from 'next/link';
import { readCreditLine } from '@/lib/credit';
import './shell.css';

/**
 * The footer of every page (SRS 7.1.1 "Same place on every page"; UX-03; FR-PUB-02): the GIZ credit line, then the licence,
 * Legal texts, About and Help and contact, in that order. The credit's words are rendered as a React text child, never as markup
 * (NFR-SEC-11), and the licence is linked only when its address is https (lib/credit.ts refuses others too). The licence is an
 * external address, so it is a plain anchor; the three site links are `next/link` with Next's default prefetch (SRS 7.6.4 rule 4).
 */
export default function Footer() {
  const credit = readCreditLine();
  return (
    <footer className="shell-footer">
      <p className="shell-footer__credit">{credit.text}</p>
      <nav aria-label="Footer" className="shell-footer__nav">
        {credit.href.startsWith('https://') ? (
          <a href={credit.href} rel="noopener noreferrer">
            {credit.licence}
          </a>
        ) : (
          <span>{credit.licence}</span>
        )}
        <Link href="/legal/terms">Legal texts</Link>
        <Link href="/about">About</Link>
        <Link href="/about#help-and-contact">Help and contact</Link>
      </nav>
    </footer>
  );
}
