import Link from 'next/link';
import { readCreditLine } from '@/lib/credit';
import { SHELL_COPY } from '@/lib/shell/copy';
import { DSWB_LOGO, MAKAI_LOGO } from '@/components/layout/logos';
import './footer.css';

/**
 * The footer of every page (SRS 7.1.1 "Same place on every page"; UX-03; FR-PUB-02), a navy band in both themes in the rail's
 * language (owner, 15 November 2026: the MAK-AI logo back, with the DSWB logo, the pilot partner's, beside it): the two
 * logos, named by their alt text, then the GIZ credit line, then the licence, Terms and privacy (Help's legal section, plan
 * 1A Task 12 R7), About and Help and contact (Help's contact section, /help#contact; spec 8 line 271), in that order. The credit's words are rendered as a React text child, never as
 * markup (NFR-SEC-11), and the licence is linked only when its address is https (lib/credit.ts refuses others too). The
 * licence is an external address, so it is a plain anchor; the three site links are `next/link` with Next's default prefetch
 * (SRS 7.6.4 rule 4). The logos are files already sized (components/layout/logos.ts) and load lazily: on most pages the
 * footer is below the first view, so a first visit does not fetch them until it is near.
 */
export default function Footer() {
  const credit = readCreditLine();
  return (
    <footer className="shell-footer">
      <div className="shell-footer__inner">
        <div className="shell-footer__logos">
          {/* eslint-disable-next-line @next/next/no-img-element -- files already sized for the drawn logos (logos.ts). */}
          <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height}
            alt={SHELL_COPY.footer.makaiLogo} loading="lazy" decoding="async" />
          {/* eslint-disable-next-line @next/next/no-img-element -- files already sized for the drawn logos (logos.ts). */}
          <img src={DSWB_LOGO.src} srcSet={DSWB_LOGO.srcSet} width={DSWB_LOGO.width} height={DSWB_LOGO.height}
            alt={SHELL_COPY.footer.dswbLogo} loading="lazy" decoding="async" />
        </div>
        <div className="shell-footer__text">
          <p className="shell-footer__credit">{credit.text}</p>
          <nav aria-label="Footer" className="shell-footer__nav">
            {credit.href.startsWith('https://') ? (
              <a href={credit.href} rel="noopener noreferrer">
                {credit.licence}
              </a>
            ) : (
              <span>{credit.licence}</span>
            )}
            <Link href="/help#terms-and-privacy">{SHELL_COPY.footer.termsAndPrivacy}</Link>
            <Link href="/about">About</Link>
            <Link href="/help#contact">Help and contact</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
