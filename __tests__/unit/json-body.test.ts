import { describe, expect, it } from 'vitest';
import { ValidationFailed } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/jsonBody';

/** A request whose body is these bytes. */
const req = (body: BodyInit | null) => new Request('http://localhost/x', { method: 'POST', body });
const refusal = async (r: Request) => {
  const e = await readJsonBody(r).catch((x: unknown) => x);
  return e instanceof ValidationFailed ? e.extra?.fields : e;
};

describe('lib/http/jsonBody.ts readJsonBody', () => {
  it('FR-DEC-02: a JSON body is read as its value', async () => {
    expect(await readJsonBody(req('{"a":[1,"é"]}'))).toEqual({ a: [1, 'é'] });
  });

  it('FR-DEC-02: a body that is not JSON, or empty, answers 422 naming body', async () => {
    for (const body of ['{"reason":', '', 'not json']) {
      expect(await refusal(req(body))).toEqual([expect.objectContaining({ field: 'body' })]);
    }
  });

  it('FR-DEC-02 NFR-SEC-11: a body that is not valid UTF-8 answers 422 naming body, rather than being read with U+FFFD in it', async () => {
    const bytes = new TextEncoder().encode('{"reason":"XX"}');
    bytes[bytes.indexOf(0x58)] = 0xff;
    expect(await refusal(req(new Blob([bytes])))).toEqual([expect.objectContaining({ field: 'body' })]);
  });

  it('FR-DEC-02: a body that cannot be read at all is not mapped to 422; it propagates', async () => {
    const r = req('{}');
    await r.text();   // the body is used up, so reading it again throws a TypeError
    const e = await readJsonBody(r).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TypeError);
  });
});
