import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createLinkAdder } from '@/lib/client/evidenceLink';
import type { UploadOutcome } from '@/lib/client/evidenceUpload';
import { LINK_URL_MESSAGE } from '@/lib/evidence/link';
import type { CreateLinkEvidenceRequest, EvidenceItemView } from '@/types/api';

const ITEM = { id: 'l1', kind: 'link', url: 'https://example.org/x' } as EvidenceItemView;

/** A send that stays pending until the test settles it. */
function pendingSend() {
  const bodies: CreateLinkEvidenceRequest[] = [];
  let settle: (o: UploadOutcome) => void = () => {};
  const send = vi.fn((body: CreateLinkEvidenceRequest) => {
    bodies.push(body);
    return new Promise<UploadOutcome>((resolve) => { settle = resolve; });
  });
  return { send, bodies, settle: (o: UploadOutcome) => settle(o) };
}
function adder(send: (b: CreateLinkEvidenceRequest) => Promise<UploadOutcome>) {
  const events = { pending: [] as boolean[], added: [] as EvidenceItemView[], errors: [] as Array<string | null>, cleared: 0 };
  const add = createLinkAdder({
    send, onPending: (p) => events.pending.push(p), onAdded: (i) => events.added.push(i),
    onError: (t) => events.errors.push(t), onDone: () => { events.cleared++; },
  });
  return { add, events };
}

describe('the link adder behind the evidence block (CR-1, CR-3)', () => {
  it('CR-1 FR-DEC-07: a second press while the first is in flight sends nothing, and the pending flag is set then cleared', async () => {
    const p = pendingSend();
    const { add, events } = adder(p.send);
    const first = add({ address: 'https://example.org/x', label: '' });
    const second = add({ address: 'https://example.org/x', label: '' });
    await second;
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(events.pending).toEqual([true]);
    p.settle({ kind: 'uploaded', status: 201, item: ITEM });
    await first;
    expect(events.pending).toEqual([true, false]);
    expect(events.added).toEqual([ITEM]);
    expect(events.cleared).toBe(1);
    void add({ address: 'https://example.org/x', label: '' });   // the guard is released: a later press sends again
    expect(p.send).toHaveBeenCalledTimes(2);
  });

  it('CR-3 M-12 M-19 M-08 M-09: each refusal reaches onError with its own line and adds nothing', async () => {
    const cases: Array<[number, string, string]> = [
      [409, 'project_archived', 'Not saved: this project is archived. Owners and admins can unarchive it.'],
      [429, 'rate_limited', 'Not uploaded: you can upload 10 files a minute. Wait a minute, then retry.'],
      [401, 'unauthenticated', 'Not saved: you have been signed out. Your answer is kept on this device. Sign in again to save it.'],
      [403, 'forbidden', 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.'],
      [422, 'validation', LINK_URL_MESSAGE],
      [500, 'internal_error', 'The link was not added: connection lost. Try again.'],
    ];
    for (const [status, code, text] of cases) {
      const { add, events } = adder(async () => ({ kind: 'rejected', status, body: { error: 'x', code } }));
      await add({ address: 'https://example.org/x', label: '' });
      expect([status, events.errors.at(-1), events.added]).toEqual([status, text, []]);
      expect(events.pending).toEqual([true, false]);
    }
    const lost = adder(async () => ({ kind: 'not_uploaded', reason: 'network' }));
    await lost.add({ address: 'https://example.org/x', label: '' });
    expect(lost.events.errors.at(-1)).toBe('The link was not added: connection lost. Try again.');
  });

  it('FR-EVD-01: an address that is not http or https, or a label over 200 characters, is refused before any request', async () => {
    const send = vi.fn(async (): Promise<UploadOutcome> => ({ kind: 'uploaded', status: 201, item: ITEM }));
    const { add, events } = adder(send);
    await add({ address: 'ftp://x', label: '' });
    await add({ address: 'https://example.org/x', label: 'x'.repeat(201) });
    expect(send).not.toHaveBeenCalled();
    expect(events.errors).toEqual([LINK_URL_MESSAGE, 'Enter a label of 200 characters or fewer.']);
  });

  it('FR-DEC-07: Retry of an unchanged link reuses its request id; a changed link, or a stored one, gets a new id', async () => {
    const seen: string[] = [];
    let next: UploadOutcome = { kind: 'not_uploaded', reason: 'network' };
    const { add } = adder(async (b) => { seen.push(b.requestId); return next; });
    await add({ address: 'https://example.org/x', label: '' });
    await add({ address: 'https://example.org/x', label: '' });
    expect(seen[1]).toBe(seen[0]);
    await add({ address: 'https://example.org/y', label: '' });
    expect(seen[2]).not.toBe(seen[0]);
    next = { kind: 'uploaded', status: 201, item: ITEM };
    await add({ address: 'https://example.org/y', label: '' });
    await add({ address: 'https://example.org/y', label: '' });
    expect(seen[4]).not.toBe(seen[3]);
  });

  it('CR-1 CR-3: EvidenceBlock sends links only through the adder and appends through appendOnce', () => {
    const src = readFileSync('components/evidence/EvidenceBlock.tsx', 'utf8');
    expect(src).toMatch(/createLinkAdder\(/);
    expect(src).toMatch(/appendOnce\(/);
    expect(src).not.toMatch(/linkFailureText|linkInFlight|\brequestIdFor\b/);
    expect(src).toMatch(/linkPending=\{linkPending\}/);
  });
});
