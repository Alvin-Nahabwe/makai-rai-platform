import Link from 'next/link';
import { ShellProjectPlace } from '@/components/layout/ShellPlace';
import { SHELL_PROJECT_COPY, stageStateLine } from '@/lib/shell/project/copy';
import type { ShellProject } from '@/lib/shell/types';
import type { Stage } from '@/types/record';

type Props = {
  project: ShellProject;
  /** The organisation slug of the address, which the slot's page has already passed through requireOrgContextFor. */
  orgSlug: string;
  /** The stage named in the address (`…/stages/<stage>/…`), or null on a project-level page. */
  currentStage: Stage | null;
};

const NAME_ID = 'shell-project-name';

const projectHref = (orgSlug: string, id: string) => `/orgs/${orgSlug}/projects/${id}`;
/** A stage's All questions page (S-11): the stage page itself, `…/stages/<stage>`; there is no `…/questions` list page. */
const stageHref = (orgSlug: string, id: string, stage: Stage) => `${projectHref(orgSlug, id)}/stages/${stage}`;

/**
 * A stage's line mark, as the locked sketch draws it (assigned.html, `.lines`): a short rule, brighter for a started stage,
 * with the action-orange disc on it for the stage in the address. It is drawn, not a status mark (no fill stands for an
 * amount, spec 5 principle 7), and hidden from assistive technology: the line of words beside it says the same.
 */
function LineMark({ current }: { current: boolean }) {
  return (
    <svg className="shell-project__mark" width="48" height="14" viewBox="0 0 48 14" aria-hidden="true" focusable="false">
      <path d="M2 7h44" />
      {current ? <circle cx="24" cy="7" r="5.5" /> : null}
    </svg>
  );
}

/**
 * The rail's project block (owner ruling R4; sketch `1-the-route.png`, left column under the navigation): the project's name
 * linking to its page, the project page's sentence about the stages, then the three stages in order, each linking to its
 * All questions page with one line of state (lib/shell/project/copy.ts). The stage in the address is `aria-current=
 * "location"`: it is where the open page sits in the project, while the stages themselves are no sequence of steps (they
 * are worked in any order), and "page" stays the rail item's (Projects). The list is named by the project's name.
 */
export function RailProjectBlock({ project, orgSlug, currentStage }: Props) {
  return (
    <div className="shell-project">
      <p className="shell-project__name" id={NAME_ID}>
        <Link href={projectHref(orgSlug, project.id)}>{project.name}</Link>
      </p>
      <p className="shell-project__lead">{SHELL_PROJECT_COPY.stagesLead}</p>
      <ul className="shell-project__stages" aria-labelledby={NAME_ID}>
        {project.stages.map((s) => {
          const current = s.stage === currentStage;
          const started = s.noDecision < s.questions;
          const className = ['shell-project__stage', current ? 'shell-project__stage--current' : null,
            started ? 'shell-project__stage--started' : null].filter(Boolean).join(' ');
          return (
            <li key={s.stage}>
              <Link href={stageHref(orgSlug, project.id, s.stage)} className={className} aria-current={current ? 'location' : undefined}>
                <LineMark current={current} />
                <span className="shell-project__stage-text">
                  <span className="shell-project__stage-name">{SHELL_PROJECT_COPY.stageTitle[s.stage]}</span>
                  <span className="shell-project__state">{stageStateLine(s, current)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The narrow top bar's project context (sketch `workspace-phone-saved.png`): the stage on the first line and the project's
 * name, smaller, under it; just the name on a project-level page. With a stage in the address, "All questions" links to
 * that stage's list. The whole name is in the markup and CSS cuts it with an ellipsis (shell.css), so its accessible name
 * is the full name.
 */
export function BarProjectContext({ project, orgSlug, currentStage }: Props) {
  return (
    <div className="shell-bar-project">
      <p className="shell-bar-project__where">
        {currentStage !== null ? <span className="shell-bar-project__stage">{SHELL_PROJECT_COPY.stageTitle[currentStage]}</span> : null}
        <span className="shell-bar-project__name">{project.name}</span>
      </p>
      {currentStage !== null ? (
        <Link href={stageHref(orgSlug, project.id, currentStage)} className="shell-bar-project__all">
          {SHELL_PROJECT_COPY.allQuestions}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * What the `@project` slot renders for a project in context: both pieces, server-rendered, handed to the one client part
 * that shows each in its own place of the shell (components/layout/ShellPlace.tsx).
 */
export function ShellProjectSlot(props: Props) {
  return <ShellProjectPlace rail={<RailProjectBlock {...props} />} bar={<BarProjectContext {...props} />} />;
}
