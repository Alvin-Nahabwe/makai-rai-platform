import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Task 9: `lib/email/send.ts` is the ONE transport export. Tests never send
 * real email (constraint 6) — the Resend SDK is mocked at the module
 * boundary (`vi.mock('resend', ...)`), the same shape as
 * `__tests__/integration/assessments.test.ts`'s `vi.mock('../../lib/data/tenant', ...)`.
 *
 * The Resend SDK itself does NOT throw on an API failure: `emails.send`
 * resolves to `{ data, error }` and folds the failure into that shape
 * (node_modules/resend/dist/index.d.mts, `type Response<T>`). Constraint 2
 * requires the transport to throw on failure rather than return a
 * success-shaped value — that translation is exactly what these tests pin.
 */

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

describe('sendEmail', () => {
  const message = {
    to: 'invitee@example.org',
    from: 'onboarding@resend.dev',
    subject: 'Subject',
    html: '<p>hi</p>',
    text: 'hi',
  };

  beforeEach(() => {
    sendMock.mockReset();
    vi.stubEnv('RESEND_API_KEY', 're_test_key_1234567890');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves with the Resend message id on success', async () => {
    sendMock.mockResolvedValue({ data: { id: 'resend-msg-1' }, error: null });
    const { sendEmail } = await import('../../lib/email/send');

    const result = await sendEmail(message);

    expect(result).toEqual({ id: 'resend-msg-1' });
  });

  it('throws — does not return a success-shaped value — when Resend reports an error', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { message: 'Invalid from address', statusCode: 422, name: 'invalid_from_address' },
    });
    const { sendEmail } = await import('../../lib/email/send');

    await expect(sendEmail(message)).rejects.toThrow(/invalid_from_address|Invalid from address/);
  });

  it('throws when the underlying SDK call itself rejects (network failure)', async () => {
    sendMock.mockRejectedValue(new Error('ECONNRESET'));
    const { sendEmail } = await import('../../lib/email/send');

    await expect(sendEmail(message)).rejects.toThrow();
  });

  it('throws without ever calling Resend when RESEND_API_KEY is not set — fails loud, not silent', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('RESEND_API_KEY', '');
    const { sendEmail } = await import('../../lib/email/send');

    await expect(sendEmail(message)).rejects.toThrow(/RESEND_API_KEY/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws when Resend resolves with no error but a data object missing an id (half-success guard, silent-failure-hunter finding)', async () => {
    sendMock.mockResolvedValue({ data: {}, error: null });
    const { sendEmail } = await import('../../lib/email/send');

    await expect(sendEmail(message)).rejects.toThrow();
  });

  it('never includes the API key in the thrown error message', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { message: 'Invalid from address', statusCode: 422, name: 'invalid_from_address' },
    });
    const { sendEmail } = await import('../../lib/email/send');

    await expect(sendEmail(message)).rejects.not.toThrow(/re_test_key_1234567890/);
  });
});
