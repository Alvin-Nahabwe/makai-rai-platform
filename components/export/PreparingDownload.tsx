'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';

/**
 * A plain download link, and a status region that says the file is being prepared once the link is pressed
 * (S-20's M-37 second sentence, S-21's "Preparing your file..."). The browser does the download; without
 * scripts the link still works and only the sentence is missing.
 */
export function PreparingDownload({ href, label, preparing }: { href: string; label: string; preparing: string }): ReactElement {
  const [pressed, setPressed] = useState(false);
  return (
    <>
      <p><a href={href} className="btn btn--primary" onClick={() => setPressed(true)}>{label}</a></p>
      <p role="status">{pressed ? preparing : ''}</p>
    </>
  );
}
