import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { legalTextHeading } from '@/components/legal/LegalTextView';
import { ACCEPTED_KINDS } from '@/types/legal';
import { HELP_COPY } from '@/lib/help/copy';
import { helpVocabulary } from '@/lib/help/vocabulary';
import { readHelpEmail } from '@/lib/help/contact';
import { pageTitle } from '@/lib/ui/title';
import './help.css';

export const metadata = { title: pageTitle(HELP_COPY.titles.help) };

/**
 * Help, `/help` (plan 1A Task 12, ruling L2-69; design spec screen 13): public, and inside the signed-in shell for a person
 * who passes the sign-in gates (app/help/layout.tsx). In order: the words used on the platform, from data/vocabulary.json;
 * what sealing means (W1); the three texts every account accepts, each named as its own page heads it (W4); the contact
 * address (About's, read by the same function); a link to About. A server component with no client code of its own. Terms,
 * definitions and the address are React text (S8). Each term's `<dt>` is followed by its `<dd>`, which lets the first-use
 * reader count every term on this page as defined (ruling L2-29a). Every entry, the 26 the first-use rule checks among
 * them, carries `data-term` and `data-definition` on the `dt` and `dd` themselves, so the glossary reads as one list in one
 * style (lead's ruling, FX2), never through the kit's term and definition components. Each group sits under the heading
 * Help gives it (ruling D5), so no heading is the first use of a defined term.
 */
export default function HelpPage() {
  const groups = helpVocabulary();
  const email = readHelpEmail();
  return (
    <div className="help">
      <PageHeader title={HELP_COPY.titles.help} />
      <section aria-labelledby="words-used-on-the-platform">
        <h2 id="words-used-on-the-platform">{HELP_COPY.words.heading}</h2>
        {groups.map((group, i) => (
          <section key={group.name}>
            <h3 id={`help-group-${i + 1}`}>{group.heading}</h3>
            <dl className="help__list">
              {group.entries.flatMap((e) => [
                <dt key={`t-${e.id}`} data-term={e.id}>{e.term}</dt>,
                <dd key={`d-${e.id}`} data-definition={e.id}>{e.definition}</dd>,
              ])}
            </dl>
          </section>
        ))}
      </section>
      <section aria-labelledby="what-sealing-means">
        <h2 id="what-sealing-means">{HELP_COPY.sealing.heading}</h2>
        {HELP_COPY.sealing.paragraphs.map((p) => <p key={p}>{p}</p>)}
      </section>
      <section aria-labelledby="terms-and-privacy">
        <h2 id="terms-and-privacy">{HELP_COPY.legal.heading}</h2>
        <ul className="help__links">
          {ACCEPTED_KINDS.map((kind) => (
            <li key={kind}><Link href={`/legal/${kind}`}>{legalTextHeading(kind)}</Link></li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="contact">
        <h2 id="contact">{HELP_COPY.contact.heading}</h2>
        {email === null ? (
          <p>{HELP_COPY.contact.askOwner}</p>
        ) : (
          <p>{HELP_COPY.contact.writeTo}<a className="help__address" href={`mailto:${email}`}>{email}</a>{HELP_COPY.contact.writeToEnd}</p>
        )}
      </section>
      <p className="help__about"><Link href="/about">{HELP_COPY.about}</Link></p>
    </div>
  );
}
