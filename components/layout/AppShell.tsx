import type { ReactNode } from 'react';
import TopBar from '@/components/layout/TopBar';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { PRODUCT_NAME } from '@/lib/ui/title';
import type { ShellData } from '@/lib/shell/types';
import './shell.css';

/**
 * The signed-in shell (plan 1A Task 11, rulings L2-44 and L2-45): the top bar with its Menu button, the panel that holds the
 * one navigation tree (the rail), then the page's own <main>. From 1024 px the panel is the rail's column; below it the panel
 * is a popover the Menu button opens. Nothing of the shell is inside <main>: specs read main as the page's own content.
 */
export default function AppShell({ shell, children }: { shell: ShellData; children: ReactNode }) {
  return (
    <div className="shell">
      <TopBar shell={shell} title={PRODUCT_NAME} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="shell__main">
        {children}
      </main>
    </div>
  );
}
