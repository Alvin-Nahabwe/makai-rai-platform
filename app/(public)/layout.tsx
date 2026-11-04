import ThemeToggle from '@/components/layout/ThemeToggle';
import PublicHeader from '@/components/layout/PublicHeader';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="public-layout">
        <ThemeToggle floating />
        {children}
      </main>
    </>
  );
}
