// What a logged error may say about where it failed, defined once because three places read stacks: the request's log line
// (lib/http/toResponse.ts), the working report's render worker (lib/documents/render/pdfWorker.mjs), which runs this file as it is,
// and the pool that takes the worker's answer (lib/documents/render/pdfWorkerPool.ts). A stack's first lines are the error's message,
// and a message can hold record text, so only lines in V8's frame shape, read from after the message, are ever logged.

/**
 * A V8 stack frame: `at` and a location that ends in `:line:column`, either bare or in parentheses after a function name. A line
 * of a message that merely starts with `at` does not end so, and is never taken as a frame.
 */
export const FRAME = /^\s+at (?:.+ \()?[^\s()]+:\d+:\d+\)?$/;

/** An error's class name that may be logged: a plain identifier. */
export const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** At most this many frames are kept, as toResponse's log line keeps. */
export const MAX_FRAMES = 10;

/**
 * The frames of `e`'s stack, read only from after the message V8 put at its head (`name: message`, or `name` alone when the
 * message is empty), and only lines in the frame shape. A stack that does not begin with that head (its name or message changed
 * after it was thrown) answers no frames, since where its message ends is not known. Never throws: a value whose getters throw
 * answers no frames.
 *
 * @param {unknown} e
 * @returns {string[]}
 */
export function framesAfterMessage(e) {
  try {
    if (typeof e !== 'object' || e === null) return [];
    const stack = /** @type {{ stack?: unknown }} */ (e).stack;
    if (typeof stack !== 'string') return [];
    const name = String(/** @type {{ name?: unknown }} */ (e).name);
    const message = String(/** @type {{ message?: unknown }} */ (e).message ?? '');
    const head = message === '' ? name : `${name}: ${message}`;
    if (!stack.startsWith(`${head}\n`)) return [];
    return stack.slice(head.length + 1).split('\n').filter((l) => FRAME.test(l)).slice(0, MAX_FRAMES);
  } catch {
    return [];
  }
}
