'use client';

import { useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { StatusRegion } from '@/components/ui/StatusRegion';

/**
 * The gallery's live feedback demos (plan 1A Task 6): a status line that receives its message after the page loads, and a
 * dialog the browser spec opens and closes with Escape. Nothing is sent anywhere; each demo only shows what happened.
 */

export function StatusRegionDemo(): ReactElement {
  const [message, setMessage] = useState<{ text: string; tone: 'neutral' | 'error' } | null>(null);
  return (
    <div>
      <div>
        <Button variant="secondary" onClick={() => setMessage({ text: 'Sample member invited.', tone: 'neutral' })}>Show a message</Button>
        <Button variant="secondary" onClick={() => setMessage({ text: 'The sample invitation was not sent. Try again.', tone: 'error' })}>Show an error</Button>
        <Button variant="quiet" onClick={() => setMessage(null)}>Clear</Button>
      </div>
      <StatusRegion id="kit-status-live" message={message?.text ?? null} tone={message?.tone ?? 'neutral'} />
    </div>
  );
}

export function DialogDemo(): ReactElement {
  const [open, setOpen] = useState(false);
  const [closedByBrowser, setClosedByBrowser] = useState(0);
  const [chosen, setChosen] = useState('nothing yet');
  const choose = (what: string) => { setChosen(what); setOpen(false); };
  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(true)}>Open the sample dialog</Button>
      <p data-demo-output="dialog">Closed by the browser: {closedByBrowser}. Chosen: {chosen}.</p>
      <Dialog
        open={open} title="Archive the sample project?"
        onClose={() => { setClosedByBrowser((n) => n + 1); choose('dismissed'); }}
        actions={<>
          <Button variant="secondary" onClick={() => choose('cancel')}>Cancel</Button>
          <Button variant="destructive" onClick={() => choose('archive')}>Archive project</Button>
        </>}
      >
        <p>Nothing in it can be changed until it is unarchived. This is a sample: nothing is sent.</p>
      </Dialog>
    </div>
  );
}

/** A dialog taller than the window, to show that it scrolls inside itself and keeps its gutter. */
export function LongDialogDemo(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(true)}>Open the long sample dialog</Button>
      <Dialog open={open} title="A long sample dialog" onClose={() => setOpen(false)}
        actions={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        {Array.from({ length: 30 }, (_, i) => <p key={i}>Sample paragraph {i + 1} of 30. This is a sample: nothing is sent.</p>)}
      </Dialog>
    </div>
  );
}

export function InlineConfirmDemo(): ReactElement {
  const [said, setSaid] = useState('nothing yet');
  return (
    <div>
      <InlineConfirm objectName="Sample data card v1" consequence="It stays listed as withdrawn. This is a sample: nothing is sent."
        actionLabel="Withdraw document" onConfirm={() => setSaid('withdraw')} onCancel={() => setSaid('cancel')} />
      <InlineConfirm objectName="Sample project" consequence="Nothing in it can be changed until it is unarchived."
        actionLabel="Archive project" destructive cancelLabel="Keep it open" onConfirm={() => setSaid('archive')} onCancel={() => setSaid('keep')} />
      <InlineConfirm objectName="Sample invitation" consequence="Its link stops working at once." actionLabel="Revoke invitation" busy
        onConfirm={() => setSaid('revoke')} onCancel={() => setSaid('cancel while busy')} />
      <p data-demo-output="confirm">Pressed: {said}.</p>
    </div>
  );
}
