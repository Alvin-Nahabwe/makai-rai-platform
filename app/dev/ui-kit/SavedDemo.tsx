'use client';

import { useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { SavedMark } from '@/components/ui/SavedMark';

/** The gallery's live saved mark: empty until "Simulate save", then one version more on each press, so its announcement can be heard and tested. */
export function SavedDemo(): ReactElement {
  const [version, setVersion] = useState(0);
  return (
    <div>
      <Button variant="secondary" onClick={() => setVersion((v) => v + 1)}>Simulate save</Button>
      <SavedMark
        saved={version === 0 ? null : { version, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02-11' }}
        historyHref="#saved-mark"
      />
    </div>
  );
}
