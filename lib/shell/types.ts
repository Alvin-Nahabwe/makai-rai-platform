import type { IconName } from '@/components/ui/types';
import type { Stage } from '@/types/record';

/**
 * The shell's data (plan 1A Task 11, ruling L2-50). Types only, so a client component can import them. What reaches the client
 * is exactly this: an organisation is its slug and its name, never another column of its row (security obligation T2), and
 * the account's platform role field is not here at all (D-10).
 */

/** One of the person's own active organisations. */
export type ShellOrg = { slug: string; name: string };

export type ShellData = {
  userId: string;
  userName: string;
  /** "MAK-AI administrator" for the platform administrator, otherwise null (lib/authz/roleLabel.ts). */
  platformLabel: string | null;
  /** The role word in each of the person's organisations, keyed by slug, capitalised ("Viewer"). Read with Object.hasOwn. */
  roleLabels: Readonly<Record<string, string>>;
  /** Sorted by name, then slug. */
  orgs: readonly ShellOrg[];
  /**
   * The organisation `/` would send the person to (S4), for the rail's links outside an organisation: a slug that is in
   * `orgs`, never anything else of the user or organisation row (T2). Null for the administrator, for a person in no
   * organisation, and for a person in several with no usable last-active hint.
   */
  homeSlug: string | null;
};

export type RailItem = {
  key: 'home' | 'projects' | 'findings' | 'guidance' | 'help' | 'members' | 'organisation' | 'account' | 'admin-organisations' | 'admin-accounts';
  label: string;
  href: string;
  icon: IconName;
  current: boolean;
  group: 'main' | 'lower';
};

/**
 * One stage of the project in context, as the rail's project block shows it (owner ruling R4): the number of questions
 * of the stage and how many of them have no decision, both stageView's own counts (lib/data/projects.ts, `questions` and
 * `noDecision`). A stage is started when fewer questions have no decision than it holds.
 */
export type ShellProjectStage = { stage: Stage; questions: number; noDecision: number };

/**
 * The project in context (S5): its id, its name and the per-stage numbers, and nothing else of its row. Read on the server
 * by lib/shell/project.ts, past the project page's own gates.
 */
export type ShellProject = { id: string; name: string; stages: readonly ShellProjectStage[] };
