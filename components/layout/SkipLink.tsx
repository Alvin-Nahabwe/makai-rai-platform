import { SHELL_COPY } from '@/lib/shell/copy';

/** The id of the main landmark every page carries; the skip link points at it (UX-04, SC 2.4.1). app/error.tsx writes the same value as a literal (H0's file), and a unit test checks every <main> under app/. */
export const MAIN_CONTENT_ID = 'main-content';

/** "Skip to content", the first focusable element of every page. Hidden until focused (.skip-link in app/globals.css). */
export default function SkipLink() {
  return (
    <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
      {SHELL_COPY.skip}
    </a>
  );
}
