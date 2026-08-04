/**
 * Validates a `?callbackUrl=` query value before it is handed to
 * `router.push`. Extracted (not left inline in `app/(public)/login/page.tsx`)
 * for the same reason `lib/org-nav.ts` is: this project has no React Testing
 * Library / jsdom vitest environment (`vitest.config.ts` runs
 * `environment: 'node'`), so a pure function is what makes this testable at
 * all, and `login/page.tsx` itself imports `next-auth/react` /
 * `next/navigation`, which do not resolve cleanly under plain Node.
 *
 * `?callbackUrl=` is attacker-controlled query input (a phishing link can
 * set it to anything), so this is a security boundary, not a UX default.
 * `startsWith('/')` alone is NOT sufficient: the WHATWG URL parser this
 * app's own router resolves through
 * (`node_modules/next/dist/client/components/app-router-instance.js`)
 * treats a leading `//` or a leading `/\` as protocol-relative and resolves
 * it to a DIFFERENT origin — verified live, `new URL('//evil.com',
 * 'http://localhost:3000/login').href` -> `'http://evil.com/'`, and the same
 * for `'/\\evil.com'` — which Next's router then treats as an external URL
 * and hard-navigates the browser to. Both payloads pass `startsWith('/')`
 * alone, which would make a successful login the trigger for a
 * same-domain-phishing-link redirect to an attacker's page: the classic
 * post-auth open-redirect chain. Rejecting a second leading slash and any
 * backslash closes both without needing a full same-origin URL parse.
 */
export function safeCallbackUrl(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}
