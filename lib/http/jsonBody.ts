import { ValidationFailed } from '@/lib/http/errors';

/** The field message of a body that is not JSON in UTF-8 (an API-only text: a form always sends JSON). */
const NOT_JSON = 'The request body must be JSON, in UTF-8.';

/**
 * The request body as JSON, for a route that reads one. A body that is not valid UTF-8 or not JSON (an empty body, a
 * cut-off or hand-made one) answers 422 naming `body`, not 500, and is never read altered: `Request.json()` would
 * replace each invalid byte with U+FFFD and parse on, so the bytes are decoded with `fatal: true` instead. Only the
 * decoder's `TypeError` and the parser's `SyntaxError` are mapped; reading the stream sits outside both, so a broken
 * connection or a body already read propagates to `toResponse` unchanged.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  const bytes = await req.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throw new ValidationFailed([{ field: 'body', message: NOT_JSON }]);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new ValidationFailed([{ field: 'body', message: NOT_JSON }]);
  }
}
