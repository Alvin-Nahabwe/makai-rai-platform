import ThemeToggle from '@/components/layout/ThemeToggle';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-layout">
      <ThemeToggle floating />
      {children}
    </main>
  );
}
