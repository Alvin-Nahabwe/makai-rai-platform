'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import { StatusRegion } from '@/components/ui/StatusRegion';
import '@/components/ui/buttonStyles';

/**
 * A plain download link, and a status region that says the file is being prepared once the link is pressed
 * (S-20's M-37 second sentence, S-21's "Preparing your file..."). The browser does the download; without
 * scripts the link still works and only the sentence is missing. The link is a native <a> in the kit's primary button
 * classes, since the kit's ButtonLink takes no onClick (ruling T18-j); the status line is the kit's StatusRegion, in
 * the page and empty before the press.
 */
export function PreparingDownload({ href, label, preparing }: { href: string; label: string; preparing: string }): ReactElement {
  const [pressed, setPressed] = useState(false);
  return (
    <>
      <p><a href={href} className="ui-button ui-button--primary" onClick={() => setPressed(true)}>{label}</a></p>
      <StatusRegion message={pressed ? preparing : null} />
    </>
  );
}
