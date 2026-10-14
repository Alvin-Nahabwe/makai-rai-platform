import Link from 'next/link';

export const metadata = { title: 'Privacy Policy — MAK-AI RAI Toolkit' };

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-12) var(--space-6)' }}>
      <Link href="/register" className="back-link">← Back</Link>
      <h1 style={{ marginTop: 'var(--space-2)' }}>Privacy Policy</h1>
      <div
        role="note"
        style={{
          margin: 'var(--space-4) 0 var(--space-8)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--tint-moderate-bg)',
          color: 'var(--tint-moderate-fg)',
          borderRadius: 'var(--border-radius-sm)',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        Draft — pending institutional review. This page exists so the registration consent does not
        link to a missing document; the binding policy will replace this text before public launch.
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', lineHeight: 'var(--line-height-relaxed)' }}>
        <div>
          <h2>What we collect</h2>
          <p>
            Account details (name, email), the projects and AI-system metadata you enter, and your
            assessment responses and generated reports.
          </p>
        </div>
        <div>
          <h2>How we use it</h2>
          <p>
            To provide the assessment service to you: saving and resuming assessments, generating
            reports, and showing your history. Everything entered in an organization can be read by
            every member of that organization.
          </p>
        </div>
        <div>
          <h2>Your controls</h2>
          <p>
            There is no self-service export or account deletion in the interface yet. Consent
            records are stored with a timestamp for audit purposes.
          </p>
        </div>
        <div>
          <h2>Security</h2>
          <p>
            Passwords are stored hashed. Data entered in an organization can be read by every
            member of that organization and by the platform operators. See the{' '}
            <Link href="/terms">Terms of Service</Link> for acceptable use.
          </p>
        </div>
      </section>
    </div>
  );
}
