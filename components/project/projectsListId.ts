/**
 * The id of the element around the Projects page's list (S-32; components/project/ProjectsTable.tsx). Unarchive
 * (components/project/UnarchiveProjectButton.tsx, a client component) moves focus into it before the refresh that moves
 * the project's row, so both import the id from here: a module with no copy and no 'use client' (ruling X-2).
 */
export const PROJECTS_LIST_ID = 'projects-list';
