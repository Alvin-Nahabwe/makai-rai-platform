import Link from 'next/link';

export const metadata = { title: 'Terms of Service — MAK-AI RAI Toolkit' };

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-12) var(--space-6)' }}>
      <Link href="/register" className="back-link">← Back</Link>
      <h1 style={{ marginTop: 'var(--space-2)' }}>Terms of Service</h1>
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
        Draft — pending institutional legal review. This page exists so the registration consent
        does not link to a missing document; the binding terms will replace this text before public
        launch.
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', lineHeight: 'var(--line-height-relaxed)' }}>
        <div>
          <h2>1. Purpose</h2>
          <p>
            The MAK-AI Responsible AI Toolkit is provided to help teams and institutions assess and
            improve responsible-AI practices across the machine-learning lifecycle. It is an
            assessment and guidance tool. It does not give legal advice or assurance.
          </p>
        </div>
        <div>
          <h2>2. Accounts</h2>
          <p>
            You are responsible for the accuracy of the information you provide and for keeping your
            account credentials secure. Assessment responses reflect your own attestations.
          </p>
        </div>
        <div>
          <h2>3. Acceptable use</h2>
          <p>
            Use the platform only for lawful responsible-AI assessment purposes. Do not attempt to
            access data belonging to other users or organizations, or to disrupt the service.
          </p>
        </div>
        <div>
          <h2>4. Data</h2>
          <p>
            Handling of your data is described in the <Link href="/privacy">Privacy Policy</Link>.
            The platform does not use your data for research. The registration form no longer asks
            for research consent, and consent given earlier has been voided.
          </p>
        </div>
        <div>
          <h2>5. No warranty</h2>
          <p>
            The toolkit is provided &quot;as is&quot;. What it records and suggests is guidance
            to support human judgement, not a substitute for it.
          </p>
        </div>
      </section>
    </div>
  );
}
